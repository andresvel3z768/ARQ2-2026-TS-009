const express = require('express');
const axios = require('axios');
const CircuitBreaker = require('opossum');
const { pool, redis, rabbit, publish, retryOrDeadLetter, logger, metricsMiddleware, metricsText, randomUUID } = require('../../packages/common');
const app = express(); app.use(express.json()); app.use(logger('airline-connector')); app.use(metricsMiddleware('airline-connector'));
app.get('/metrics',async(_req,res)=>{res.type('text/plain').send(await metricsText());});
const bucketLua = `local t=redis.call('TIME'); local now=(t[1]*1000)+math.floor(t[2]/1000); local v=redis.call('HMGET',KEYS[1],'tokens','updated'); local tokens=tonumber(v[1]) or tonumber(ARGV[1]); local updated=tonumber(v[2]) or now; tokens=math.min(tonumber(ARGV[1]),tokens+((now-updated)/1000)*tonumber(ARGV[2])); if tokens<1 then redis.call('HMSET',KEYS[1],'tokens',tokens,'updated',now); redis.call('PEXPIRE',KEYS[1],60000); return 0 end; tokens=tokens-1; redis.call('HMSET',KEYS[1],'tokens',tokens,'updated',now); redis.call('PEXPIRE',KEYS[1],60000); return 1`;
async function acquireAirlineToken(airline) {
  const ok = await redis.eval(bucketLua,1,`airline:bucket:${airline}`,Number(process.env.AIRLINE_RATE_CAPACITY||10),Number(process.env.AIRLINE_RATE_REFILL_PER_SECOND||2));
  if (!ok) { const e=new Error('AIRLINE_RATE_LIMITED'); e.code='AIRLINE_RATE_LIMITED'; throw e; }
}
async function mockConfirm(command) {
  const rejected = String(process.env.AIRLINE_REJECT_SEATS || '12A').split(',').map(x=>x.trim());
  if (rejected.includes(command.seatNumber)) return { ok:false, status:409, reason:'SEAT_NOT_AVAILABLE', airlineErrorCode:'NO_INVENTORY', raw:{message:'Requested seat is no longer available',seat:command.seatNumber} };
  return { ok:true, status:200, confirmationCode:`AB-${command.bookingId.slice(0,8).toUpperCase()}`, raw:{status:'CONFIRMED',flightId:command.flightId,seat:command.seatNumber} };
}
const breaker = new CircuitBreaker(mockConfirm,{timeout:5000,errorThresholdPercentage:50,resetTimeout:10000,volumeThreshold:3});
breaker.fallback(async()=>({ok:false,status:503,reason:'AIRLINE_UNKNOWN',airlineErrorCode:'CIRCUIT_OPEN',raw:{message:'Airline outcome unknown'}}));
async function mockFareSearch(params){const {origin,destination,date,cabin='ECONOMY',airline='DEMO'}=params;const seed=(origin+destination+date+cabin).split('').reduce((a,c)=>a+c.charCodeAt(0),0);return {fares:[{flightId:`${airline}-${origin}${destination}-${date.replaceAll('-','')}-01`,price:250+seed%450,currency:'USD'},{flightId:`${airline}-${origin}${destination}-${date.replaceAll('-','')}-02`,price:300+seed%500,currency:'USD'}]};}
const fareBreaker=new CircuitBreaker(mockFareSearch,{timeout:5000,errorThresholdPercentage:50,resetTimeout:10000,volumeThreshold:3});
fareBreaker.fallback(async()=>{throw new Error('AIRLINE_CIRCUIT_OPEN');});
app.get('/health',(_req,res)=>res.json({status:'ok',service:'airline-connector',circuit:breaker.opened?'OPEN':'CLOSED'}));
app.post('/internal/fares/revalidate',async(req,res)=>{
  const {airline='DEMO',quoteId,flightId}=req.body||{};
  try{await acquireAirlineToken(airline);}catch(e){return res.status(429).json({valid:false,error:e.code||e.message});}
  const {rows}=await pool.query('SELECT quote_id,flight_id,expires_at,price FROM fare_quotes WHERE quote_id=$1 AND expires_at>now()',[quoteId]);
  if(!rows.length||rows[0].flight_id!==flightId)return res.status(409).json({valid:false,error:'PRICE_CHANGED'});
  if(String(process.env.AIRLINE_PRICE_CHANGE_FLIGHTS||'').split(',').map(x=>x.trim()).includes(flightId))return res.status(409).json({valid:false,error:'PRICE_CHANGED'});
  return res.json({valid:true,quoteId,flightId,revalidatedAt:new Date().toISOString()});
});
app.get('/internal/fares',async(req,res)=>{
  const {origin,destination,date,cabin='ECONOMY',pax='1',airline='DEMO'}=req.query;
  try { await acquireAirlineToken(airline); }
  catch(e){return res.status(429).json({error:e.code||e.message});}
  try{return res.json(await fareBreaker.fire({origin,destination,date,cabin,pax,airline}));}catch(e){return res.status(503).json({error:'AIRLINE_CIRCUIT_OPEN'});}
});
app.get('/internal/bookings/:id/status',async(req,res)=>{
  const {rows}=await pool.query('SELECT response_payload FROM airline_interactions WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 1',[req.params.id]);
  if(!rows.length)return res.json({status:'UNKNOWN'}); return res.json(rows[0].response_payload);
});
async function consumeCommands(){
  const ch=await rabbit();
  await ch.assertQueue('airline.commands',{durable:true,arguments:{'x-dead-letter-exchange':'aerobooking.dlx'}});
  await ch.bindQueue('airline.commands','aerobooking.events','command.airline.book');
  ch.consume('airline.commands',async msg=>{
    if(!msg)return;
    const command=JSON.parse(msg.content.toString());
    try{
      const seen=await pool.query('SELECT 1 FROM inbox WHERE message_id=$1',[`airline:${command.message_id}`]);
      if(seen.rows.length){ch.ack(msg);return;}
      const currentFence=Number(await redis.get(`fence:${command.flightId}:${command.seatNumber}`)||0);
      const currentLock=await redis.get(`seatlock:${command.flightId}:${command.seatNumber}`);
      if(currentFence!==Number(command.fencingToken)||!currentLock||currentLock!==command.lockToken){
        const stale={ok:false,status:409,reason:'STALE_FENCING_TOKEN',airlineErrorCode:'STALE_LOCK',raw:{currentFence,commandFence:command.fencingToken}};
        await pool.query(`INSERT INTO airline_interactions(booking_id,correlation_id,request_payload,response_payload,http_status) VALUES($1,$2,$3,$4,$5)`,[command.bookingId,command.correlationId,command,stale,409]);
        await publish('booking.rejected',{service:'airline-connector',bookingId:command.bookingId,sagaId:command.sagaId,correlationId:command.correlationId,reason:stale.reason,airlineErrorCode:stale.airlineErrorCode,rawRequest:command,rawResponse:stale.raw});
        await pool.query('INSERT INTO inbox(message_id) VALUES($1) ON CONFLICT DO NOTHING',[`airline:${command.message_id}`]);
        ch.ack(msg);return;
      }
      await acquireAirlineToken(command.airline||'DEMO');
      const result=await breaker.fire(command);
      await pool.query(`INSERT INTO airline_interactions(booking_id,correlation_id,request_payload,response_payload,http_status) VALUES($1,$2,$3,$4,$5)`,[command.bookingId,command.correlationId,command,result,result.status]);
      if(result.reason==='AIRLINE_UNKNOWN') await publish('booking.unknown',{service:'airline-connector',bookingId:command.bookingId,sagaId:command.sagaId,correlationId:command.correlationId,reason:'AIRLINE_UNKNOWN',rawRequest:command,rawResponse:result.raw});
      else if(result.ok) await publish('booking.confirmed',{service:'airline-connector',bookingId:command.bookingId,sagaId:command.sagaId,correlationId:command.correlationId,airlineConfirmationCode:result.confirmationCode,rawRequest:command,rawResponse:result.raw});
      else await publish('booking.rejected',{service:'airline-connector',bookingId:command.bookingId,sagaId:command.sagaId,correlationId:command.correlationId,reason:result.reason,airlineErrorCode:result.airlineErrorCode,rawRequest:command,rawResponse:result.raw});
      await pool.query('INSERT INTO inbox(message_id) VALUES($1) ON CONFLICT DO NOTHING',[`airline:${command.message_id}`]);
      ch.ack(msg);
    }catch(err){console.error(JSON.stringify({level:'error',service:'airline-connector',error:err.message,bookingId:command.bookingId}));await retryOrDeadLetter(ch,msg,'airline.commands').catch(()=>ch.nack(msg,false,true));}
  },{noAck:false});
  ch.once('close',()=>setTimeout(()=>consumeCommands().catch(err=>console.error(err)),5000));
}
app.listen(Number(process.env.PORT||3004),'0.0.0.0',()=>console.log('airline-connector listening'));
consumeCommands().catch(err=>{console.error(err);process.exit(1)});
