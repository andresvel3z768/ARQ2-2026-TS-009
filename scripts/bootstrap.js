const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) { for (const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if(m && process.env[m[1]]===undefined) process.env[m[1]]=m[2].replace(/^['\"]|['\"]$/g,''); } }
const demoClientId=process.env.DEMO_CLIENT_ID||'demo-client';
const adminClientId=process.env.DEMO_ADMIN_CLIENT_ID||'demo-admin';
const demoAgencyId=process.env.DEMO_AGENCY_ID||'00000000-0000-4000-8000-000000000009';
const secrets = path.join(root, 'secrets');
fs.mkdirSync(secrets, { recursive: true });
const privatePath = path.join(secrets, 'jwt-private.pem');
const publicPath = path.join(secrets, 'jwt-public.pem');
if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(privatePath, pair.privateKey, { mode: 0o600 });
  fs.writeFileSync(publicPath, pair.publicKey);
  console.log('Generated local development RS256 key pair. Never use these keys in production.');
}
const publicKey = fs.readFileSync(publicPath, 'utf8').trim().split('\n').map(x => `          ${x}`).join('\n');
const kong = `_format_version: "3.0"
_transform: true
consumers:
  - username: demo-agency
    custom_id: "${demoAgencyId}"
    jwt_secrets:
      - key: ${demoClientId}
        algorithm: RS256
        rsa_public_key: |
${publicKey}
      - key: ${adminClientId}
        algorithm: RS256
        rsa_public_key: |
${publicKey}
services:
  - name: auth-service
    url: http://auth-service:3001
    routes:
      - name: auth-token-route
        paths: [/v1/auth/token]
        strip_path: false
      - name: auth-key-management-route
        paths: [/v1/auth/keys]
        strip_path: false
      - name: auth-token-revocation-route
        paths: [/v1/auth/tokens]
        strip_path: false
  - name: search-service
    url: http://search-service:3002
    routes:
      - name: search-routes
        paths: [/v1/fares]
        strip_path: false
  - name: booking-service
    url: http://booking-service:3003
    routes:
      - name: booking-routes
        paths: [/v1/bookings]
        strip_path: false
  - name: audit-service
    url: http://audit-service:3005
    routes:
      - name: audit-routes
        paths: [/v1/audit]
        strip_path: false
plugins:
  - name: prometheus
    config:
      per_consumer: true
  - name: correlation-id
    config:
      header_name: X-Correlation-ID
      generator: uuid
      echo_downstream: true
  - name: rate-limiting
    config:
      minute: 120
      policy: redis
      redis_host: valkey
      redis_port: 6379
      fault_tolerant: false
  - name: jwt
    route: { name: search-routes }
    config:
      claims_to_verify: [exp]
      key_claim_name: iss
      header_names: [authorization]
  - name: jwt
    route: { name: booking-routes }
    config:
      claims_to_verify: [exp]
      key_claim_name: iss
      header_names: [authorization]
  - name: jwt
    route: { name: audit-routes }
    config:
      claims_to_verify: [exp]
      key_claim_name: iss
      header_names: [authorization]
  - name: jwt
    route: { name: auth-key-management-route }
    config:
      claims_to_verify: [exp]
      key_claim_name: iss
      header_names: [authorization]
  - name: jwt
    route: { name: auth-token-revocation-route }
    config:
      claims_to_verify: [exp]
      key_claim_name: iss
      header_names: [authorization]
  - name: jwt-revocation
    route: { name: search-routes }
    config: { redis_host: valkey, redis_port: 6379 }
  - name: jwt-revocation
    route: { name: booking-routes }
    config: { redis_host: valkey, redis_port: 6379 }
  - name: jwt-revocation
    route: { name: audit-routes }
    config: { redis_host: valkey, redis_port: 6379 }
  - name: jwt-revocation
    route: { name: auth-key-management-route }
    config: { redis_host: valkey, redis_port: 6379 }
  - name: jwt-revocation
    route: { name: auth-token-revocation-route }
    config: { redis_host: valkey, redis_port: 6379 }
  - name: idempotency
    config:
      redis_host: valkey
      redis_port: 6379
      ttl: 86400
      required_paths: ["/v1/bookings"]
`;
fs.writeFileSync(path.join(root, 'gateway/kong/kong.yml'), kong);

const routeNames = [
  'auth-token-route',
  'auth-key-management-route',
  'auth-token-revocation-route',
  'search-routes',
  'booking-routes',
  'audit-routes'
];

const routeIds = Object.fromEntries(
  routeNames.map(name => [name, crypto.randomUUID()])
);

const config = {
  _format_version: '3.0', _transform: true,
  consumers: [{ username: `agency-${demoAgencyId}`, custom_id: demoAgencyId, jwt_secrets: [demoClientId,adminClientId].map(key=>({key,algorithm:'RS256',rsa_public_key:fs.readFileSync(publicPath,'utf8')})) }],
    services: [
    {
      name: 'auth-service',
      url: 'http://auth-service:3001',
      routes: [
        {id:routeIds['auth-token-route'],name:'auth-token-route',paths:['/v1/auth/token'],strip_path:false},
        {id:routeIds['auth-key-management-route'],name:'auth-key-management-route',paths:['/v1/auth/keys'],strip_path:false},
        {id:routeIds['auth-token-revocation-route'],name:'auth-token-revocation-route',paths:['/v1/auth/tokens'],strip_path:false}
      ]
    },
    {
      name: 'search-service',
      url: 'http://search-service:3002',
      routes: [
        {id:routeIds['search-routes'],name:'search-routes',paths:['/v1/fares'],strip_path:false}
      ]
    },
    {
      name: 'booking-service',
      url: 'http://booking-service:3003',
      routes: [
        {id:routeIds['booking-routes'],name:'booking-routes',paths:['/v1/bookings'],strip_path:false}
      ]
    },
    {
      name: 'audit-service',
      url: 'http://audit-service:3005',
      routes: [
        {id:routeIds['audit-routes'],name:'audit-routes',paths:['/v1/audit'],strip_path:false}
      ]
    }
  ],
  plugins: [
    {name:'prometheus',config:{per_consumer:true}},
    {name:'correlation-id',config:{header_name:'X-Correlation-ID',generator:'uuid',echo_downstream:true}},
    {name:'rate-limiting',config:{minute:120,limit_by:'consumer',policy:'redis',redis_host:'valkey',redis_port:6379,fault_tolerant:false}},
    ...['search-routes','booking-routes','audit-routes','auth-key-management-route','auth-token-revocation-route'].map(name=>({id:crypto.randomUUID(),name:'jwt',route:{id:routeIds[name]},config:{claims_to_verify:['exp'],key_claim_name:'iss',header_names:['authorization']}})),
    ...['search-routes','booking-routes','audit-routes','auth-key-management-route','auth-token-revocation-route'].map(name=>({id:crypto.randomUUID(),name:'jwt-revocation',route:{id:routeIds[name]},config:{redis_host:'valkey',redis_port:6379}})),
    {name:'idempotency',config:{redis_host:'valkey',redis_port:6379,ttl:86400,required_paths:['/v1/bookings']}}
  ]
};
const jsonConfigPath=path.join(root,'gateway/kong/kong.json');
if(fs.existsSync(jsonConfigPath)){
  try{
    const previous=JSON.parse(fs.readFileSync(jsonConfigPath,'utf8'));
    for(const oldConsumer of (previous.consumers||[])){
      let current=config.consumers.find(c=>c.custom_id===oldConsumer.custom_id);
      if(!current){current={...oldConsumer,jwt_secrets:[]};config.consumers.push(current);}
      for(const oldCredential of (oldConsumer.jwt_secrets||[])){
        const credential={...oldCredential,rsa_public_key:fs.readFileSync(publicPath,'utf8')};
        const existing=current.jwt_secrets.find(c=>c.key===credential.key);
        if(existing)Object.assign(existing,credential);else current.jwt_secrets.push(credential);
      }
    }
  }catch(err){console.warn(`Could not preserve previous Kong consumers: ${err.message}`);}
}
fs.writeFileSync(jsonConfigPath,JSON.stringify(config,null,2));
console.log('Generated Kong DB-less YAML/JSON configuration from the local public key.');
