const required=['NEW_AGENCY_ID','NEW_AGENCY_NAME','NEW_CLIENT_ID','NEW_CLIENT_SECRET','PROVISIONING_SECRET'];
for(const key of required)if(!process.env[key])throw new Error(`Missing environment variable ${key}`);
const body={agencyId:process.env.NEW_AGENCY_ID,name:process.env.NEW_AGENCY_NAME,clientId:process.env.NEW_CLIENT_ID,clientSecret:process.env.NEW_CLIENT_SECRET,rateLimitTier:process.env.NEW_RATE_LIMIT_TIER||'BASIC',scopes:(process.env.NEW_SCOPES||'fares:read bookings:write bookings:read keys:rotate').split(',').map(x=>x.trim()).filter(Boolean)};
async function run(){
 const response=await fetch('http://auth-service:3001/internal/agencies',{method:'POST',headers:{'content-type':'application/json','x-provisioning-secret':process.env.PROVISIONING_SECRET},body:JSON.stringify(body)});
 const result=await response.json();
 console.log(JSON.stringify(result,null,2));
 if(!response.ok && response.status!==202)process.exit(1);
}
run().catch(err=>{console.error(err);process.exit(1)});
