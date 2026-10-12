import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {setup,teardown,httpCall,fixture,admin,support,policy} from './fixtures.mjs';
import {createPurchase} from '../../dist/examples/agent/src/purchase.js';
import {storeSupport} from '../../dist/packages/db/src/index.js';
import {workerPool,provider} from '../payment/helpers.mjs';
test.before(setup);test.after(teardown);
async function scheduledSupport(){
 const nativeNow=Date.now;let calls=0;
 // A scheduling pause after sampling real wall time, not a fabricated clock value.
 Date.now=()=>{const value=nativeNow();if(++calls===1){const start=performance.now();while(performance.now()-start<3){}}return value;};
 try {await support();}finally{Date.now=nativeNow;}
 const row=(await admin.query('SELECT fetched_at,expires_at FROM provider_capability_snapshots ORDER BY fetched_at DESC,id DESC LIMIT 1')).rows[0];
 console.log('SUPPORT_SCHEDULE',JSON.stringify({fetched_at:row.fetched_at,expires_at:row.expires_at,window_ms:row.expires_at-row.fetched_at,calls,real_pause_ms:3}));
}
const checkout=()=>httpCall('/v1/checkouts',{method:'POST',headers:{'X-Dispatch-Intent':'checkout'},body:{product_id:fixture.product,product_version:1,quantity:1,client_kind:'browser'}});
test('SUPPORT browser checkout accepts support produced across a real scheduling pause',async()=>{
 await scheduledSupport();const response=await checkout();assert.equal(response.status,201);
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts')).rows[0].n,'0');
});
test('SUPPORT agent checkout accepts the same pause without invoking a wallet',async()=>{
 await scheduledSupport();const j=await createPurchase(policy(),process.env.DISPATCH_DB_HOST+'/schedule-agent-'+randomUUID());
 const saved=await j.read();assert.equal(saved.stage,'ready');assert.equal(saved.confirmed,true);
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts')).rows[0].n,'0');
});
test('SUPPORT genuinely overlong support still refuses checkout without effects',async()=>{
 const now=Date.now();await storeSupport(workerPool,{provider_origin:provider,fetched_at:now,expires_at:now+60001,supported_kinds:[{x402Version:2,scheme:'exact',network:'eip155:8453'}]},provider);
 const before=(await admin.query('SELECT count(*) n FROM orders')).rows[0].n;
 const response=await checkout();assert.equal(response.status,409);assert.equal((await response.json()).code,'PAYMENT_CONFLICT');
 assert.equal((await admin.query('SELECT count(*) n FROM orders')).rows[0].n,before);
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts')).rows[0].n,'0');
 await support();
});
