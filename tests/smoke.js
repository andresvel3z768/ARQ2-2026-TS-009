const base=process.env.BASE_URL||'http://localhost:8000';
async function run(){
 const tokenRes=await fetch(`${base}/v1/auth/token`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'client_credentials',client_id:process.env.DEMO_CLIENT_ID||'demo-client',client_secret:process.env.DEMO_CLIENT_SECRET||'demo-secret-change-me',scope:'fares:read bookings:write bookings:read audit:read'})});
 if(!tokenRes.ok)throw new Error(`Token endpoint failed: ${tokenRes.status} ${await tokenRes.text()}`);
 const {access_token}=await tokenRes.json();
 const fares=await fetch(`${base}/v1/fares/search?origin=BOG&destination=MDE&date=2026-12-10`,{headers:{authorization:`Bearer ${access_token}`}});
 if(!fares.ok)throw new Error(`Fare search failed: ${fares.status} ${await fares.text()}`);
 const list=await fares.json();if(!list.length||!list[0].quoteId)throw new Error('Fare response missing quoteId');
 console.log('Smoke test passed: token issuance and fare search.');
}
run().catch(e=>{console.error(e);process.exit(1)});
