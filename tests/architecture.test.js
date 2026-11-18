const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('Wave 1 source artifacts are preserved',()=>{
 for(const f of ['docs/spec.md','docs/adrs/001-api-gateway-kong.md','docs/adrs/007-B2B-Auth.md','docs/assets/aerobooking-c4-level2.drawio.png'])assert.ok(fs.existsSync(path.join(root,f)),`${f} must exist`);
});
test('Wave 2 contains the mandatory infrastructure stack',()=>{
 const compose=read('docker-compose.yml');
 for(const s of ['kong','postgres','valkey','rabbitmq','prometheus','loki','grafana'])assert.match(compose,new RegExp(`^  ${s}:`,'m'));
});
test('Feature 1: OAuth2, RS256 and token revocation are implemented',()=>{
 const auth=read('services/auth/index.js'),gateway=read('gateway/kong/plugins/jwt-revocation/handler.lua');
 assert.match(auth,/client_credentials/);assert.match(auth,/RS256/);assert.match(auth,/revoked:/);assert.match(gateway,/revoked:/);
});
test('Feature 2: cache-aside, single-flight and airline token bucket are implemented',()=>{
 assert.match(read('services/search/index.js'),/lock:fare:/);assert.match(read('services/search/index.js'),/FARE_TTL_SECONDS/);assert.match(read('services/airline-connector/index.js'),/bucketLua/);
});
test('Feature 3: atomic seat locks and fencing tokens are implemented',()=>{
 const booking=read('services/booking/index.js'),airline=read('services/airline-connector/index.js');
 assert.match(booking,/PX',lockTtl,'NX/);assert.match(booking,/fence:/);assert.match(airline,/currentFence!==Number\(command\.fencingToken\)/);
});
test('Feature 4: Saga compensation, outbox and recovery are implemented',()=>{
 const booking=read('services/booking/index.js'),sql=read('infrastructure/postgres/init.sql');
 assert.match(booking,/async function compensate/);assert.match(booking,/RefundFunds|REFUND/);assert.match(booking,/async function recover/);assert.match(sql,/CREATE TABLE IF NOT EXISTS outbox/);
});
test('Feature 5: append-only audit and hash chain are implemented',()=>{
 const sql=read('infrastructure/postgres/init.sql'),audit=read('services/audit/index.js');
 assert.match(sql,/block_audit_mutation/);assert.match(sql,/compute_hash_chain/);assert.match(sql,/digest\(/);assert.match(audit,/globalChainLinked/);
});
test('OpenSpec remains the contract source of truth',()=>{
 const spec=read('docs/spec.md');
 for(const term of ['Feature 1 (B2B auth)','Feature 2 (cached search)','Feature 3 (distributed lock)','Feature 4 (saga compensation)','Feature 5 (forensic audit)'])assert.ok(spec.includes(term));
});

test('Updated Wave 1 contract: booking body binds flight and seat to lock',()=>{
 const booking=read('services/booking/index.js'),spec=read('docs/spec.md');
 assert.match(spec,/\{ "flightId": "string", "seatNumber": "string", "lockToken": "string", "fareQuoteId": "string", "paymentMethodId": "string" \}/);
 assert.match(booking,/flightId,seatNumber,lockToken,fareQuoteId,paymentMethodId/);
 assert.match(booking,/LOCK_FLIGHT_OR_SEAT_MISMATCH/);
});
test('Updated Wave 1 contract: airline booking command uses documented routing key and payload',()=>{
 const booking=read('services/booking/index.js'),airline=read('services/airline-connector/index.js'),spec=read('docs/spec.md');
 assert.match(spec,/command\.airline\.book/);
 assert.match(booking,/command\.airline\.book/);
 for(const field of ['commandId','sagaId','bookingId','correlationId','agencyId','flightId','seatNumber','fencingToken','idempotencyKey'])assert.ok(booking.includes(field),`missing ${field}`);
 assert.match(airline,/command\.airline\.book/);
});
test('Kong rate limiting is scoped per agency consumer and uses Redis-compatible Valkey',()=>{
 const kong=read('gateway/kong/kong.yml'),bootstrap=read('scripts/bootstrap.js');
 assert.match(kong,/limit_by: consumer/);assert.match(kong,/policy: redis/);
 assert.match(bootstrap,/limit_by:'consumer'/);assert.match(bootstrap,/policy:'redis'/);
});
