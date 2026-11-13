const express = require('express');
const axios = require('axios');
const { pool, redis, requireAuth, requireScope, logger, metricsMiddleware, metricsText, audit, randomUUID } = require('../../packages/common');
const app = express(); app.use(express.json()); app.use(logger('search-service')); app.use(metricsMiddleware('search-service'));
app.get('/metrics',async(_req,res)=>res.type('text/plain').send(await metricsText()));
const ttl = Number(process.env.FARE_TTL_SECONDS || 60), staleTtl = Number(process.env.FARE_STALE_SECONDS || 15);
app.get('/health', (_req,res)=>res.json({status:'ok',service:'search-service'}));
app.get('/v1/fares/search', requireAuth, requireScope('fares:read'), async (req,res)=>{
  const { origin, destination, date, cabin='ECONOMY', pax='1', airline='DEMO' } = req.query;
  if (!origin || !destination || !date || !/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return res.status(400).json({error:'INVALID_SEARCH_CRITERIA'});
  const key = `fare:${airline}:${origin}:${destination}:${date}:${cabin}:${pax}`;
  try {
    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached).fares.map(f=>({...f, cacheStatus:'HIT'})));
    const stale = await redis.get(`${key}:stale`);
    const lock = await redis.set(`lock:fare:${key}`,'1','PX',5000,'NX');
    if (!lock) {
      if (stale) return res.json(JSON.parse(stale).fares.map(f=>({...f, cacheStatus:'STALE'})));
      for (let i=0;i<20;i++) { await new Promise(r=>setTimeout(r,100)); const v=await redis.get(key); if(v) return res.json(JSON.parse(v).fares.map(f=>({...f,cacheStatus:'HIT_AFTER_WAIT'}))); }
      return res.status(503).json({error:'FARE_REFRESH_IN_PROGRESS'});
    }
    try {
      const { data } = await axios.get(`${process.env.AIRLINE_CONNECTOR_URL || 'http://localhost:3004'}/internal/fares`, { params:{origin,destination,date,cabin,pax,airline}, timeout:5000 });
      const now = new Date(), expiresAt = new Date(Date.now()+ttl*1000);
      const fares = (data.fares || []).map(f=>({ quoteId:randomUUID(), ...f, origin,destination,date,cabin,pax:Number(pax),airline,cachedAt:now.toISOString(),expiresAt:expiresAt.toISOString() }));
      const value = JSON.stringify({fares});
      await redis.set(key,value,'EX',ttl);
      await redis.set(`${key}:stale`,value,'EX',ttl+staleTtl);
      for (const f of fares) await pool.query(`INSERT INTO fare_quotes(quote_id,flight_id,airline,origin,destination,travel_date,cabin,pax,price,currency,cached_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(quote_id) DO NOTHING`, [f.quoteId,f.flightId,airline,origin,destination,date,cabin,Number(pax),f.price,f.currency,now,expiresAt]);
      await audit('fare.cache.miss',{correlationId:req.correlationId,origin,destination,date,flightCount:fares.length});
      return res.json(fares.map(f=>({...f,cacheStatus:'MISS'})));
    } finally { await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",1,`lock:fare:${key}`,'1'); }
  } catch (err) {
    if (stale) return res.json(JSON.parse(stale).fares.map(f=>({...f,cacheStatus:'STALE_ON_ERROR'})));
    console.error(JSON.stringify({level:'error',service:'search-service',error:err.message,correlationId:req.correlationId}));
    return res.status(503).json({error:'AIRLINE_SEARCH_UNAVAILABLE'});
  }
});
app.listen(Number(process.env.PORT||3002),'0.0.0.0',()=>console.log('search-service listening'));
