import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {BuyerAccess} from '../../dist/packages/db/src/buyer.js';
import {digest} from '../../dist/packages/db/src/commerce.js';
import {encryptionKey} from '../payment/helpers.mjs';
import {setup,teardown,httpCall,fixture,admin,api,commerce,origin,support} from './fixtures.mjs';
const observations=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>Promise.withResolvers();
let beforeDeadlocks;
before(async()=>{await setup();beforeDeadlocks=await deadlocks();});
async function deadlocks(){await admin.query('SELECT pg_stat_clear_snapshot()');return Number((await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()')).rows[0].deadlocks);}
after(async()=>{
 try {
  // Every operation is awaited. Read a fresh snapshot after the PG statistics flush interval.
  await delay(1200);const afterDeadlocks=await deadlocks();
  const log=await readFile(process.env.DISPATCH_DB_HOST+'/server.log','utf8');
  const logDeadlocks=(log.match(/deadlock detected/g)||[]).length;
  const rateCounts=(await admin.query('SELECT count FROM abuse_counters')).rows.map(r=>r.count);
  assert.ok(rateCounts.every(n=>Number(n)<60),'fixture must stay below unchanged HTTP rate limit');
  await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/recovery-lock-observation.json',JSON.stringify({beforeDeadlocks,afterDeadlocks,logDeadlocks,rateCounts,observations},null,2)+'\n');
  assert.equal(afterDeadlocks-beforeDeadlocks,0,'new PostgreSQL deadlocks');
  assert.equal(logDeadlocks,0,'isolated PostgreSQL log contains a deadlock');
 } finally {await teardown();}
});
async function create(){
 await support();const r=await httpCall('/v1/checkouts',{method:'POST',headers:{'X-Dispatch-Intent':'checkout'},body:{product_id:fixture.product,product_version:1,quantity:1,client_kind:'browser'}});
 assert.equal(r.status,201);const value=await r.json(),cookie=r.headers.get('set-cookie').split(';')[0];
 const csrf=(await(await httpCall('/v1/session',{headers:{Cookie:cookie}})).json()).csrf_token;
 assert.equal((await httpCall('/v1/checkouts/'+value.id,{headers:{Cookie:cookie}})).status,200);
 return {id:value.id,cookie,csrf,credential:cookie.split('=')[1]};
}
// Supplementary SQL schedules use the same Commerce creation/confirmation path directly;
// reserve HTTP requests for the concurrency and access assertions (57 total, limit 60).
async function createDirect(){
 await support();const v=await commerce.create({product_id:fixture.product,product_version:1,quantity:1,client_kind:'browser'});
 const credential=v.agent_capability;await commerce.status(v.id,credential);
 return {id:v.id,credential,cookie:'__Host-dispatch_buyer='+credential,csrf:commerce.buyers.csrf(credential)};
}
const exportDirect=b=>commerce.buyers.export(b.id,b.credential,randomUUID());
async function exportRecovery(b){const r=await httpCall('/v1/orders/'+b.id+'/recovery',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'Idempotency-Key':randomUUID()},body:{}});assert.equal(r.status,200);return r.json();}
const importRecovery=(b,capability)=>httpCall('/v1/recovery/import',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'X-Dispatch-Intent':'recovery'},body:{capability}});
const access=(b,id)=>httpCall('/v1/checkouts/'+id,{headers:{Cookie:b.cookie}});
async function grant(b,id){return (await admin.query('SELECT g.confirmed_at FROM buyer_grants g JOIN buyer_sessions s ON s.id=g.session_id WHERE s.capability_hash=$1 AND g.order_id=$2',[digest(b.credential),id])).rows;}

test('B4-C1-01 independent browser HTTP import versus rotation: three overlaps, exact access and no rate-limit substitutes',async()=>{
 for(let i=0;i<3;i++){
  const a=await create(),b=await create();assert.notEqual(a.credential,b.credential);
  const cap=await exportRecovery(a);
  const [rotated,imported]=await Promise.all([exportRecovery(a),importRecovery(b,cap.capability)]);
  assert.ok([200,401].includes(imported.status),'unexpected import status '+imported.status);
  // Launch order does not determine the winner. Existing access depends on actual serialization.
  const rows=await grant(b,a.id);assert.equal(rows.length,imported.status===200?1:0);
  if(rows.length)assert.equal(rows[0].confirmed_at,null);
  assert.equal((await access(b,a.id)).status,imported.status===200?200:401);
  assert.equal((await importRecovery(b,cap.capability)).status,401);
  assert.equal((await importRecovery(b,rotated.capability)).status,200);
  assert.equal((await access(a,b.id)).status,401);assert.equal((await access(b,a.id)).status,200);
  observations.push({schedule:'HTTP overlap',iteration:i,import_status:imported.status});
 }
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts')).rows[0].n,'0');
});

// Pause only between completed real application SQL statements; never replace a query
// or mock a result. Separate service-role connections retain actual transaction/FK locks.
function controlledAccess(pauseAfter){
 const reached=deferred(),release=deferred(),connected=deferred();let paused=false;
 const pool={async connect(){const c=await api.connect();connected.resolve(c.processID);return {
  async query(sql,values){const r=await c.query(sql,values);if(!paused&&pauseAfter(sql)){paused=true;reached.resolve();await release.promise;}return r;},
  on:c.on.bind(c),once:c.once.bind(c),removeListener:c.removeListener.bind(c),
  release(error){c.release(error);}
 };}};
 return {buyer:new BuyerAccess(pool,encryptionKey,origin),reached:reached.promise,release:()=>release.resolve(),pid:connected.promise};
}
async function blocked(waiter,blocker){
 for(let i=0;i<100;i++){
  const r=await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1)) blocked',[waiter,blocker]);
  if(r.rows[0].blocked)return;await delay(10);
 }
 assert.fail('expected real PostgreSQL lock wait did not occur');
}
const orderLock=sql=>sql==='SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE';
for(const winner of ['rotation','import'])test('B4-C1-02 '+winner+' wins a deterministic real-application SQL schedule',async()=>{
 const a=await createDirect(),b=await createDirect(),cap=await exportDirect(a);
 const first=controlledAccess(orderLock),second=controlledAccess(()=>false);
 let firstRun,secondRun;
 try {
  firstRun=winner==='rotation'?first.buyer.export(a.id,a.credential,randomUUID()):first.buyer.import(cap.capability,b.credential);
  await first.reached;
  // Attach rejection handlers before releasing the first operation.
  secondRun=(winner==='rotation'?second.buyer.import(cap.capability,b.credential):second.buyer.export(a.id,a.credential,randomUUID())).then(value=>({value}),error=>({error}));
  await blocked(await second.pid,await first.pid);first.release();
  const result=await firstRun,other=await secondRun;
  if(winner==='rotation'){assert.equal(other.error?.message,'unauthorized');assert.equal((await grant(b,a.id)).length,0);assert.equal((await access(b,a.id)).status,401);}
  else {assert.ok(other.value?.capability);assert.equal(result.credential,b.credential);assert.equal((await grant(b,a.id))[0].confirmed_at,null);assert.equal((await access(b,a.id)).status,200);}
  assert.equal((await importRecovery(b,cap.capability)).status,401);
  observations.push({schedule:winner+' first order lock',wait_observed:true,import_result:winner==='import'?'granted':'unauthorized'});
 } finally {first.release();await Promise.allSettled([firstRun,secondRun].filter(Boolean));}
});

for(const expired of ['recovery','browser'])test('B4-C1-03 '+expired+' expiry during a real order-lock wait is revalidated',async()=>{
 const a=await createDirect(),b=await createDirect(),cap=await exportDirect(a);
 const hash=digest(expired==='recovery'?cap.capability:b.credential);
 // Set a near expiry before import's first authority/identification statement.
 await admin.query("UPDATE buyer_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE capability_hash=$1",[hash]);
 const holder=await admin.connect(),importer=controlledAccess(()=>false);let pending;
 try {
  await holder.query('BEGIN');await holder.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[a.id]);
  pending=importer.buyer.import(cap.capability,b.credential).then(value=>({value}),error=>({error}));
  await blocked(await importer.pid,holder.processID);
  for(let i=0;i<250;i++){if((await admin.query('SELECT expires_at<=clock_timestamp() expired FROM buyer_sessions WHERE capability_hash=$1',[hash])).rows[0].expired)break;await delay(10);}
  assert.equal((await admin.query('SELECT expires_at<=clock_timestamp() expired FROM buyer_sessions WHERE capability_hash=$1',[hash])).rows[0].expired,true);
  await holder.query('COMMIT');assert.equal((await pending).error?.message,'unauthorized');
  assert.equal((await grant(b,a.id)).length,0);
  observations.push({schedule:expired+' expired while order lock blocked',wait_observed:true,import_result:'unauthorized'});
 } finally {await holder.query('ROLLBACK');holder.release();await Promise.allSettled([pending].filter(Boolean));}
});

test('B4-C1-04 imported grant requires confirmation; credential kinds and order/buyer scopes remain distinct',async()=>{
 const a=await createDirect(),b=await createDirect(),c=await createDirect(),cap=await exportDirect(a);
 assert.equal((await importRecovery(b,cap.capability)).status,200);assert.equal((await grant(b,a.id))[0].confirmed_at,null);
 const quote=()=>httpCall('/v1/checkouts/'+a.id+'/quote',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':b.csrf,'Idempotency-Key':randomUUID()},body:{product_version:1,quantity:1,policy_version:'policy-1'}});
 assert.equal((await quote()).status,401);
 for(const credential of [cap.capability,a.credential])assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Authorization:'Bearer '+credential}})).status,401);
 assert.equal((await access(c,a.id)).status,401);assert.equal((await access(b,c.id)).status,401);assert.equal((await access(a,b.id)).status,401);
 assert.equal((await access(b,a.id)).status,200);assert.equal((await quote()).status,200);
 // Revocation prevents a new grant but does not retroactively revoke an already imported browser grant.
 await commerce.buyers.export(a.id,a.credential,randomUUID());assert.equal((await importRecovery(c,cap.capability)).status,401);assert.equal((await grant(c,a.id)).length,0);
 assert.equal((await access(b,a.id)).status,200);
});
