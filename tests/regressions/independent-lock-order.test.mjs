import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setup,teardown,httpCall,fixture,admin,support} from '../buyer/fixtures.mjs';
before(setup);after(teardown);
async function create(){const r=await httpCall('/v1/checkouts',{method:'POST',headers:{'X-Dispatch-Intent':'checkout'},body:{product_id:fixture.product,product_version:1,quantity:1,client_kind:'browser'}});assert.equal(r.status,201);const value=await r.json(),cookie=r.headers.get('set-cookie').split(';')[0];const csrf=(await(await httpCall('/v1/session',{headers:{Cookie:cookie}})).json()).csrf_token;assert.equal((await httpCall('/v1/checkouts/'+value.id,{headers:{Cookie:cookie}})).status,200);return {id:value.id,cookie,csrf};}
async function exportRecovery(b,key=randomUUID()){const r=await httpCall('/v1/orders/'+b.id+'/recovery',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'Idempotency-Key':key},body:{}});assert.equal(r.status,200);return r.json();}
async function importRecovery(b,capability){return httpCall('/v1/recovery/import',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'X-Dispatch-Intent':'recovery'},body:{capability}});}
test('LOCK-01 recovery import/rotation uses consistent lock order without PostgreSQL deadlocks',async()=>{
 const started=Date.now(),observed=[];const beforeDeadlocks=Number((await admin.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks);
 for(let i=0;i<3;i++){
  await support();const a=await create(),b=await create(),cap=await exportRecovery(a);
  const [rotated,imported]=await Promise.all([exportRecovery(a),importRecovery(b,cap.capability)]);
  observed.push({iteration:i,import_status:imported.status});assert.ok([200,401].includes(imported.status),'unexpected import status '+imported.status);
  assert.equal((await importRecovery(b,cap.capability)).status,401);
  assert.equal((await importRecovery(b,rotated.capability)).status,200);
  assert.equal((await httpCall('/v1/checkouts/'+b.id,{headers:{Cookie:a.cookie}})).status,401);
  assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Cookie:b.cookie}})).status,200);
 }
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts')).rows[0].n,'0');
 await new Promise(resolve=>setTimeout(resolve,1200));await admin.query('SELECT pg_stat_clear_snapshot()');
 const afterDeadlocks=Number((await admin.query("SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()")).rows[0].deadlocks);
 await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/recovery-lock-observation.json',JSON.stringify({beforeDeadlocks,afterDeadlocks,observed,elapsed_ms:Date.now()-started,payment_attempts:0,unauthorized_cross_order_reads:0})+'\n');
 assert.equal(afterDeadlocks-beforeDeadlocks,0,'normal recovery export/import produced database deadlocks');
});
test('LOCK-02 imported recovery grant requires its own authenticated confirmation before quoting; no bearer/cookie substitution',async()=>{
 await support();const a=await create(),b=await create(),cap=await exportRecovery(a);assert.equal((await importRecovery(b,cap.capability)).status,200);
 const quote=()=>httpCall('/v1/checkouts/'+a.id+'/quote',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'Idempotency-Key':randomUUID()},body:{product_version:1,quantity:1,policy_version:'policy-1'}});
 assert.equal((await quote()).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Authorization:'Bearer '+cap.capability}})).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Authorization:'Bearer '+a.cookie.split('=')[1]}})).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Cookie:b.cookie}})).status,200);assert.equal((await quote()).status,200);
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts')).rows[0].n,'0');
});
