const { Pool } = require('pg');
const Redis = require('ioredis');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const prom = require('prom-client');
const metricsRegistry = new prom.Registry();
prom.collectDefaultMetrics({ register: metricsRegistry, prefix: 'aerobooking_' });
const httpRequests = new prom.Counter({ name: 'aerobooking_http_requests_total', help: 'HTTP requests handled', labelNames: ['service','method','route','status'], registers: [metricsRegistry] });
const httpDuration = new prom.Histogram({ name: 'aerobooking_http_request_duration_seconds', help: 'HTTP request duration in seconds', labelNames: ['service','method','route','status'], buckets: [0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5], registers: [metricsRegistry] });
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://aerobooking:aerobooking_dev@localhost:5432/booking_db', max: 15, idleTimeoutMillis: 30000 });
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 2, enableReadyCheck: true });
let connection;
let channel;
async function rabbit() {
  if (channel) return channel;
  connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
  connection.on('error', err => console.error(JSON.stringify({level:'error',service:'rabbitmq-client',error:err.message})));
  connection.on('close', () => { channel = undefined; connection = undefined; });
  channel = await connection.createConfirmChannel();
  channel.on('close', () => { channel = undefined; });
  await channel.assertExchange('aerobooking.events', 'topic', { durable: true });
  await channel.assertExchange('aerobooking.dlx', 'topic', { durable: true });
  await channel.assertQueue('aerobooking.dead-letter', { durable: true });
  await channel.bindQueue('aerobooking.dead-letter', 'aerobooking.dlx', '#');
  return channel;
}
async function retryOrDeadLetter(ch, msg, consumerQueue) {
  const headers = msg.properties.headers || {};
  const attempt = Number(headers['x-retry-count'] || 0) + 1;
  const routingKey = msg.fields.routingKey;
  if (attempt > 3) {
    await new Promise((resolve,reject)=>ch.publish('aerobooking.dlx', routingKey, msg.content, { persistent: true, headers: { ...headers, 'x-retry-count': attempt, 'x-original-queue': consumerQueue } }, err=>err?reject(err):resolve()));
    ch.ack(msg);
    return;
  }
  const delays = [1000, 2000, 4000];
  const retryQueue = `${consumerQueue}.retry.${attempt}`;
  await ch.assertQueue(retryQueue, { durable: true, arguments: { 'x-message-ttl': delays[attempt-1], 'x-dead-letter-exchange': 'aerobooking.events', 'x-dead-letter-routing-key': routingKey } });
  await new Promise((resolve,reject)=>ch.sendToQueue(retryQueue, msg.content, { persistent: true, contentType: msg.properties.contentType || 'application/json', messageId: msg.properties.messageId, headers: { ...headers, 'x-retry-count': attempt } }, err=>err?reject(err):resolve()));
  ch.ack(msg);
}
async function publish(routingKey, payload) {
  const ch = await rabbit();
  const message = { message_id: randomUUID(), occurred_at: new Date().toISOString(), ...payload };
  await new Promise((resolve, reject) => ch.publish('aerobooking.events', routingKey, Buffer.from(JSON.stringify(message)), { persistent: true, contentType: 'application/json', messageId: message.message_id, timestamp: Date.now() }, err => err ? reject(err) : resolve()));
  await ch.waitForConfirms();
  return message;
}
function publicKey() { return fs.readFileSync(process.env.JWT_PUBLIC_KEY_PATH || 'secrets/jwt-public.pem', 'utf8'); }
function privateKey() { return fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH || 'secrets/jwt-private.pem', 'utf8'); }
function verifyToken(token) { return jwt.verify(token, publicKey(), { algorithms: ['RS256'], audience: process.env.JWT_AUDIENCE || 'aerobooking' }); }
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; }
async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });
  try { req.actor = verifyToken(token); }
  catch { return res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' }); }
  try {
    if (req.actor.jti && await redis.get(`revoked:${req.actor.jti}`)) return res.status(401).json({ error: 'TOKEN_REVOKED' });
  } catch { return res.status(503).json({ error: 'REVOCATION_STORE_UNAVAILABLE' }); }
  return next();
}
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.actor || !(String(req.actor.scope || '').split(' ').includes(scope) || String(req.actor.scope || '').split(' ').includes('admin'))) return res.status(403).json({ error: 'INSUFFICIENT_SCOPE' });
    next();
  };
}
async function audit(eventType, payload = {}) {
  const correlationId = payload.correlationId || payload.correlation_id || randomUUID();
  try { await publish(eventType, { service: process.env.SERVICE_NAME || 'unknown', eventType, correlationId, payload }); }
  catch (err) { console.error(JSON.stringify({ level: 'error', msg: 'audit_publish_failed', eventType, correlationId, error: err.message })); }
  return correlationId;
}
function metricsMiddleware(service) { return (req,res,next)=>{ const start=process.hrtime.bigint(); res.on('finish',()=>{ const labels={service,method:req.method,route:req.route?.path||req.path,status:String(res.statusCode)}; httpRequests.inc(labels); httpDuration.observe(labels,Number(process.hrtime.bigint()-start)/1e9); }); next(); }; }
async function metricsText(){ return metricsRegistry.metrics(); }
function logger(service) {
  return (req, res, next) => {
    const start = Date.now();
    const correlationId = req.headers['x-correlation-id'] || randomUUID();
    res.setHeader('X-Correlation-ID', correlationId);
    res.on('finish', () => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', service, method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: Date.now() - start, correlationId })));
    req.correlationId = correlationId;
    next();
  };
}
module.exports = { pool, redis, rabbit, publish, retryOrDeadLetter, audit, publicKey, privateKey, verifyToken, requireAuth, requireScope, logger, metricsMiddleware, metricsText, metricsRegistry, randomUUID };
