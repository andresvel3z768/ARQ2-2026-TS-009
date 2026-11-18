const Fastify=require('fastify');
const {Pool}=require('pg');
const {pool,rabbit,verifyToken,metricsRegistry,retryOrDeadLetter}=require('../../packages/common');
const auditPool=new Pool({connectionString:process.env.AUDIT_DATABASE_URL||process.env.DATABASE_URL});
const app=Fastify({logger:true});
app.addHook('onRequest',async(req,reply)=>{const correlationId=req.headers['x-correlation-id']||require('node:crypto').randomUUID();req.correlationId=correlationId;reply.header('X-Correlation-ID',correlationId);req.log.info({correlationId},'request received');});
app.get('/health',async()=>({status:'ok',service:'audit-service'}));
app.get('/metrics',async(_req,reply)=>reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics()));
app.get('/v1/audit/:correlationId',async(req,reply)=>{
  try{
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/, '');
    if(!token)return reply.code(401).send({error:'UNAUTHORIZED'});
    const actor=verifyToken(token);const scopes=String(actor.scope||'').split(' ');
    if(!scopes.includes('admin'))return reply.code(403).send({error:'INSUFFICIENT_SCOPE'});
    const {rows}=await auditPool.query(`SELECT event_id AS "eventId",correlation_id AS "correlationId",saga_id AS "sagaId",booking_id AS "bookingId",service,"event_type" AS "eventType",payload,prev_hash AS "prevHash",hash,"occurred_at" AS timestamp FROM audit_log WHERE correlation_id=$1 ORDER BY id`,[req.params.correlationId]);
    if(!rows.length)return reply.code(404).send({error:'AUDIT_NOT_FOUND'});return rows;
  }catch(e){return reply.code(401).send({error:'INVALID_OR_EXPIRED_TOKEN'});}
});
app.get('/v1/audit/:correlationId/verify',async(req,reply)=>{
  try{
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/, '');
    const actor=verifyToken(token);
    if(!String(actor.scope||'').split(' ').includes('admin'))return reply.code(403).send({error:'INSUFFICIENT_SCOPE'});
    const {rows:count}=await auditPool.query('SELECT count(*)::int AS n FROM audit_log WHERE correlation_id=$1',[req.params.correlationId]);
    if(!count[0].n)return reply.code(404).send({error:'AUDIT_NOT_FOUND'});
    const {rows:all}=await auditPool.query("SELECT hash,prev_hash,hash=encode(digest(convert_to(COALESCE(prev_hash,'') || payload::text,'UTF8'),'sha256'),'hex') AS digest_valid FROM audit_log ORDER BY id");
    const linked=all.every((r,i)=>r.prev_hash===(i===0?null:all[i-1].hash));
    const digestsValid=all.every(r=>r.digest_valid);
    return {correlationId:req.params.correlationId,events:count[0].n,globalChainLinked:linked,digestsValid,integrityValid:linked&&digestsValid,totalEvents:all.length};
  }catch{return reply.code(401).send({error:'INVALID_OR_EXPIRED_TOKEN'});}
});
async function consume(){
  const ch=await rabbit();
  await ch.assertQueue('audit.events',{durable:true,arguments:{'x-dead-letter-exchange':'aerobooking.dlx'}});
  await ch.bindQueue('audit.events','aerobooking.events','#');
  ch.prefetch(50);
  ch.consume('audit.events',async msg=>{
    if(!msg)return;
    const e=JSON.parse(msg.content.toString());
    try{
      const id=e.message_id||require('node:crypto').randomUUID();
      const seen=await pool.query('SELECT 1 FROM inbox WHERE message_id=$1',[`audit:${id}`]);
      if(seen.rows.length){ch.ack(msg);return;}
      const p=e.payload||e;
      await auditPool.query(`INSERT INTO audit_log(event_id,correlation_id,saga_id,booking_id,service,event_type,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_id) DO NOTHING`,[id,e.correlationId||e.correlation_id||'00000000-0000-4000-8000-000000000000',e.sagaId||null,e.bookingId||p.bookingId||null,e.service||'unknown',e.eventType||msg.fields.routingKey,p,e.occurred_at||new Date().toISOString()]);
      await pool.query('INSERT INTO inbox(message_id) VALUES($1) ON CONFLICT DO NOTHING',[`audit:${id}`]);
      ch.ack(msg);
    }catch(err){
      app.log.error(err);
      await retryOrDeadLetter(ch,msg,'audit.events').catch(()=>ch.nack(msg,false,true));
    }
  },{noAck:false});
  ch.once('close',()=>setTimeout(()=>consume().catch(err=>app.log.error(err)),5000));
}
app.listen({port:Number(process.env.PORT||3005),host:'0.0.0.0'}).then(()=>consume()).catch(e=>{app.log.error(e);process.exit(1)});
