const Fastify = require('fastify');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const fs = require('node:fs');
const axios = require('axios');
const { pool, redis, privateKey, publicKey, metricsRegistry } = require('../../packages/common');
const app = Fastify({ logger: true });
const ttl = Number(process.env.JWT_TTL_SECONDS || 900);
app.addHook('onRequest',async(req,reply)=>{const correlationId=req.headers['x-correlation-id']||crypto.randomUUID();req.correlationId=correlationId;reply.header('X-Correlation-ID',correlationId);req.log.info({correlationId},'request received');});

async function seedDemo() {
  const agencyId = process.env.DEMO_AGENCY_ID || '00000000-0000-4000-8000-000000000009';
  const clientId = process.env.DEMO_CLIENT_ID || 'demo-client';
  const secret = process.env.DEMO_CLIENT_SECRET || 'demo-secret-change-me';
  const adminSecret = process.env.DEMO_ADMIN_SECRET || 'demo-admin-secret-change-me';
  const adminClientId = process.env.DEMO_ADMIN_CLIENT_ID || 'demo-admin';
  await pool.query(`INSERT INTO agencies(id,name,rate_limit_tier) VALUES($1,'Demo Travel Agency','PREMIUM') ON CONFLICT(id) DO NOTHING`, [agencyId]);
  const hash = await bcrypt.hash(secret, 12);
  await pool.query(`INSERT INTO api_credentials(agency_id,client_id,client_secret_hash,allowed_scopes) VALUES($1,$2,$3,$4) ON CONFLICT(client_id) DO UPDATE SET client_secret_hash=EXCLUDED.client_secret_hash, allowed_scopes=EXCLUDED.allowed_scopes`, [agencyId, clientId, hash, ['fares:read','bookings:write','bookings:read','keys:rotate']]);
  const adminHash=await bcrypt.hash(adminSecret,12);
  await pool.query(`INSERT INTO api_credentials(agency_id,client_id,client_secret_hash,allowed_scopes) VALUES($1,$2,$3,$4) ON CONFLICT(client_id) DO UPDATE SET client_secret_hash=EXCLUDED.client_secret_hash, allowed_scopes=EXCLUDED.allowed_scopes`,[agencyId,adminClientId,adminHash,['admin']]);
}

async function syncKongConsumer(agencyId, clientId) {
  const configPath=process.env.KONG_CONFIG_PATH||'/gateway/kong.json';
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  let consumer=config.consumers.find(c=>c.custom_id===agencyId);
  if(!consumer){consumer={username:`agency-${agencyId}`,custom_id:agencyId,jwt_secrets:[]};config.consumers.push(consumer);}
  const key=consumer.jwt_secrets.find(k=>k.key===clientId);
  const credential={key:clientId,algorithm:'RS256',rsa_public_key:publicKey()};
  if(key)Object.assign(key,credential);else consumer.jwt_secrets.push(credential);
  fs.writeFileSync(configPath,JSON.stringify(config,null,2));
  await axios.post(process.env.KONG_ADMIN_URL||'http://kong:8001/config',config,{headers:{'Content-Type':'application/json'},timeout:5000});
  return true;
}
app.get('/health', async () => ({ status: 'ok', service: 'auth-service' }));
app.get('/metrics', async (_req,reply) => reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics()));

app.post('/internal/agencies', async (req,reply) => {
  if(!process.env.PROVISIONING_SECRET || req.headers['x-provisioning-secret']!==process.env.PROVISIONING_SECRET)return reply.code(401).send({error:'UNAUTHORIZED_PROVISIONING_REQUEST'});
  const {agencyId,name,clientId,clientSecret,rateLimitTier='BASIC',scopes=['fares:read','bookings:write','bookings:read','keys:rotate']}=req.body||{};
  if(!agencyId||!name||!clientId||!clientSecret||!Array.isArray(scopes)||!scopes.length)return reply.code(400).send({error:'INVALID_AGENCY_PROVISIONING_REQUEST'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const existing=await client.query('SELECT 1 FROM api_credentials WHERE client_id=$1',[clientId]);
    if(existing.rows.length){await client.query('ROLLBACK');return reply.code(409).send({error:'CLIENT_ID_ALREADY_EXISTS'});}
    await client.query('INSERT INTO agencies(id,name,rate_limit_tier) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,rate_limit_tier=EXCLUDED.rate_limit_tier',[agencyId,name,rateLimitTier]);
    const hash=await bcrypt.hash(clientSecret,12);
    await client.query('INSERT INTO api_credentials(agency_id,client_id,client_secret_hash,allowed_scopes) VALUES($1,$2,$3,$4)',[agencyId,clientId,hash,scopes]);
    await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK').catch(()=>{});return reply.code(400).send({error:'AGENCY_PROVISIONING_FAILED',message:err.message});}finally{client.release();}
  try{await syncKongConsumer(agencyId,clientId);return reply.code(201).send({agencyId,clientId,gatewaySynced:true});}
  catch(err){app.log.error({err},'Kong config sync pending');return reply.code(202).send({agencyId,clientId,gatewaySynced:false,message:'Agency persisted; retry gateway sync when Kong Admin API is reachable'});}
});
app.post('/internal/agencies/:agencyId/sync-gateway', async (req,reply) => {
  if(!process.env.PROVISIONING_SECRET || req.headers['x-provisioning-secret']!==process.env.PROVISIONING_SECRET)return reply.code(401).send({error:'UNAUTHORIZED_PROVISIONING_REQUEST'});
  const {rows}=await pool.query('SELECT client_id FROM api_credentials WHERE agency_id=$1',[req.params.agencyId]);
  if(!rows.length)return reply.code(404).send({error:'AGENCY_NOT_FOUND'});
  try{for(const row of rows)await syncKongConsumer(req.params.agencyId,row.client_id);return reply.send({agencyId:req.params.agencyId,gatewaySynced:true,clients:rows.length});}
  catch(err){return reply.code(503).send({error:'GATEWAY_SYNC_FAILED',message:err.message});}
});

app.post('/v1/auth/token', async (req, reply) => {
  const { grant_type, client_id, client_secret, api_key, scope } = req.body || {};
  if (grant_type !== 'client_credentials' || !client_id || (!client_secret && !api_key)) return reply.code(400).send({ error: 'INVALID_REQUEST' });
  const { rows } = await pool.query(`SELECT c.*, a.active AS agency_active, a.rate_limit_tier FROM api_credentials c JOIN agencies a ON a.id=c.agency_id WHERE c.client_id=$1 AND c.active=true AND (c.valid_until IS NULL OR c.valid_until > now())`, [client_id]);
  const credential = rows[0];
  let credentialValid=false;
  if(credential && credential.agency_active){
    if(client_secret) credentialValid=await bcrypt.compare(client_secret,credential.client_secret_hash);
    if(!credentialValid && api_key){const keys=await pool.query('SELECT id,key_hash FROM api_keys WHERE agency_id=$1 AND active=true AND (grace_until IS NULL OR grace_until>now())',[credential.agency_id]);for(const row of keys.rows){if(!(await redis.get(`revoked:api-key:${row.id}`)) && await bcrypt.compare(api_key,row.key_hash)){credentialValid=true;break;}}}
  }
  if (!credential || !credential.agency_active || !credentialValid) return reply.code(401).send({ error: 'INVALID_CLIENT' });
  const requestedScopes=String(scope || credential.allowed_scopes.join(' ')).split(' ').filter(Boolean);
  if(requestedScopes.some(s=>!credential.allowed_scopes.includes(s)))return reply.code(403).send({error:'SCOPE_NOT_ALLOWED'});
  const accessToken = jwt.sign({ agencyId: credential.agency_id, scope: requestedScopes.join(' '), plan: credential.rate_limit_tier }, privateKey(), { algorithm: 'RS256', issuer: client_id, audience: process.env.JWT_AUDIENCE || 'aerobooking', expiresIn: ttl, jwtid: crypto.randomUUID() });
  return reply.send({ access_token: accessToken, token_type: 'Bearer', expires_in: ttl });
});
app.post('/v1/auth/tokens/revoke', async (req, reply) => {
  try {
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/, '');
    const claims=jwt.verify(token,publicKey(),{algorithms:['RS256'],audience:process.env.JWT_AUDIENCE||'aerobooking'});
    const remaining=Math.max(1,claims.exp-Math.floor(Date.now()/1000));
    await redis.set(`revoked:${claims.jti}`,'1','EX',remaining);
    return reply.send({revoked:true,jti:claims.jti});
  } catch { return reply.code(401).send({error:'INVALID_OR_EXPIRED_TOKEN'}); }
});
app.post('/v1/auth/keys/rotate', async (req, reply) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const claims = jwt.verify(token, publicKey(), { algorithms: ['RS256'], audience: process.env.JWT_AUDIENCE || 'aerobooking' });
    if (await redis.get(`revoked:${claims.jti}`)) return reply.code(401).send({error:'TOKEN_REVOKED'});
    if (!String(claims.scope || '').split(' ').includes('keys:rotate')) return reply.code(403).send({ error: 'INSUFFICIENT_SCOPE' });
    const newKey = `ak_${crypto.randomBytes(32).toString('hex')}`;
    const hash = await bcrypt.hash(newKey, 12);
    await pool.query(`UPDATE api_keys SET grace_until=now()+interval '10 minutes' WHERE agency_id=$1 AND active=true`, [claims.agencyId]);
    const keyId=crypto.randomUUID();
    await pool.query(`INSERT INTO api_keys(id,agency_id,key_hash,active) VALUES($1,$2,$3,true)`, [keyId,claims.agencyId,hash]);
    return reply.send({ newApiKeyId: keyId, apiKey: newKey, gracePeriodEndsAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  } catch { return reply.code(401).send({ error: 'INVALID_OR_EXPIRED_TOKEN' }); }
});
app.post('/v1/auth/keys/revoke', async (req, reply) => {
  try {
    const token=(req.headers.authorization||'').replace(/^Bearer\s+/, '');
    const claims=jwt.verify(token,publicKey(),{algorithms:['RS256'],audience:process.env.JWT_AUDIENCE||'aerobooking'});
    if(await redis.get(`revoked:${claims.jti}`))return reply.code(401).send({error:'TOKEN_REVOKED'});
    if(!String(claims.scope||'').split(' ').includes('keys:rotate'))return reply.code(403).send({error:'INSUFFICIENT_SCOPE'});
    const {apiKeyId}=req.body||{};if(!apiKeyId)return reply.code(400).send({error:'API_KEY_ID_REQUIRED'});
    const result=await pool.query('UPDATE api_keys SET active=false WHERE id=$1 AND agency_id=$2 RETURNING id',[apiKeyId,claims.agencyId]);
    if(!result.rows.length)return reply.code(404).send({error:'API_KEY_NOT_FOUND'});
    await redis.set(`revoked:api-key:${apiKeyId}`,'1','EX',31536000);
    return reply.send({revoked:true,apiKeyId});
  }catch{return reply.code(401).send({error:'INVALID_OR_EXPIRED_TOKEN'});}
});
const port = Number(process.env.PORT || 3001);
seedDemo().then(() => { setInterval(() => pool.query("UPDATE api_keys SET active=false WHERE active=true AND grace_until IS NOT NULL AND grace_until<=now()").catch(err=>app.log.error(err)),60000); return app.listen({ port, host: '0.0.0.0' }); }).catch(err => { app.log.error(err); process.exit(1); });
