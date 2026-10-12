import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrate } from '../../dist/packages/db/src/migrate.js';
import { control, transaction } from '../../dist/packages/db/src/commerce.js';
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
import { pools,pool,admin,workerPool,worker,encryptionKey,seed,purchase,bind,pending,evidence } from './helpers.mjs';
let fixture,keepFinalQuarantine=false;
const hash='0x'+'cd'.repeat(32);
const row=async(sql,args=[]) => (await admin.query(sql,args)).rows[0];
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
// Hooks schedule real worker transactions; all SQL still executes on real service-role clients.
function instrument(hook, backing=workerPool) {
 return new PaymentWorker({query:backing.query.bind(backing),async connect(){
  const c=await backing.connect();
  return {on:c.on.bind(c),once:c.once.bind(c),removeListener:c.removeListener.bind(c),
   release:(error)=>c.release(error),async query(sql,args){
   return hook({sql,args,c,run:()=>c.query(sql,args)});
  }};
 }},encryptionKey);
}
async function waitForLocks(n) {
 const until=Date.now()+4000;
 while(Date.now()<until) {
  const rows=(await admin.query(`SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity
   WHERE usename='local_worker' AND wait_event_type='Lock'
   AND query LIKE 'SELECT %FROM dispatch.merchant_control%FOR UPDATE%'`)).rows;
  if(rows.length>=n){assert.ok(rows.every(r=>r.blockers.length));console.log(JSON.stringify({control_waiters:rows}));return;}
  await new Promise(r=>setImmediate(r));
 }
 throw Error('control lock wait not observed');
}
async function prepared() {
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 return {order:p.order,id,lease:await worker.claimReconcile(id),proof:evidence(await worker.binding(id))};
}
async function credited() {const p=await prepared();return {...p,sid:await worker.apply(p.lease,p.proof)};}
async function disposition(p,expected) {
 const r=await row(`SELECT o.state,o.fulfillment_state,a.state attempt_state,
  (SELECT count(*) FROM settlements WHERE order_id=o.id AND disposition='credited') credits,
  (SELECT count(*) FROM settlements WHERE order_id=o.id AND disposition='review') reviews,
  (SELECT count(*) FROM outbox_jobs WHERE order_id=o.id AND effect_type='entitlement') jobs,
  (SELECT count(*) FROM budget_allocations WHERE attempt_id=a.id AND released_at IS NOT NULL) released,
  (SELECT count(*) FROM call_intents WHERE attempt_id=a.id AND operation='settle') settle_calls
  FROM orders o JOIN payment_attempts a ON a.order_id=o.id WHERE o.id=$1`,[p.order]);
 assert.equal(r.released,'0');assert.equal(r.settle_calls,'1');
 assert.equal(r.credits,expected==='credited'?'1':'0');assert.equal(r.jobs,expected==='credited'?'1':'0');
 if(expected==='review'){assert.equal(r.state,'review_required');assert.equal(r.fulfillment_state,'blocked');assert.equal(r.attempt_state,'review_required');assert.ok(Number(r.reviews)>0);}
 return r;
}
// Fixture-only incident resolution retains history and follows the same lock ordering.
async function resolveFixtureIncidents() {
 await transaction(admin,async c=>{await control(c);await c.query("UPDATE payment_incidents SET resolved_at=clock_timestamp() WHERE resolved_at IS NULL");});
}
test.before(async()=>{await migrate(pool('local_migrator'));fixture=await seed();});
test.afterEach(async()=>{if(!keepFinalQuarantine)await resolveFixtureIncidents();});
test.after(async()=>{for(const p of pools)await p.end();});

test('Q01 quarantine owns control before settlement; fresh query sees committed other-order incident',async()=>{
 const old=await credited(),next=await prepared(),entered=deferred(),release=deferred(),trace=[];
 const q=instrument(async x=>{const r=await x.run();if(x.sql.includes("VALUES($1,$2,$3,$4,'reorg'")){entered.resolve();await release.promise;}return r;});
 const s=instrument(async x=>{const r=await x.run();if(x.sql.includes('AS quarantined'))trace.push(r.rows[0].quarantined);return r;});
 const quarantine=q.quarantine(old.sid,hash);await entered.promise;
 const apply=s.apply(next.lease,next.proof);
 try {await waitForLocks(1);} finally {release.resolve();}
 await Promise.all([quarantine,apply]);assert.deepEqual(trace,[true]);await disposition(next,'review');
 const retained=await row('SELECT tx_hash,block_hash,disposition FROM settlements WHERE order_id=$1',[next.order]);
 assert.equal(retained.tx_hash,next.proof.transactionHash);assert.equal(retained.block_hash,next.proof.blockHash);assert.equal(retained.disposition,'review');
 console.log(JSON.stringify({post_lock_quarantined:trace,other_order:true}));
});

test('Q02 settlement owns control first; credit commits before later quarantine preserves and blocks it',async()=>{
 const p=await prepared(),entered=deferred(),release=deferred();let sid;
 const s=instrument(async x=>{const r=await x.run();if(x.sql.startsWith('INSERT INTO dispatch.settlements')){sid=x.args[0];entered.resolve();await release.promise;}return r;});
 const apply=s.apply(p.lease,p.proof);await entered.promise;
 const quarantine=worker.quarantine(sid,hash);
 try {await waitForLocks(1);} finally {release.resolve();}
 assert.equal(await apply,sid);await quarantine;
 const state=await disposition(p,'credited');assert.equal(state.state,'review_required');assert.equal(state.fulfillment_state,'blocked');
 assert.equal((await row("SELECT count(*) n FROM payment_incidents WHERE settlement_id=$1 AND kind='reorg' AND resolved_at IS NULL",[sid])).n,'1');
});

test('Q03 quarantine rollback unblocks legitimate settlement without false quarantine',async()=>{
 const old=await credited(),next=await prepared(),entered=deferred(),release=deferred();
 const q=instrument(async x=>{const r=await x.run();if(x.sql.includes("VALUES($1,$2,$3,$4,'reorg'")){entered.resolve();await release.promise;throw Error('fixture_quarantine_rollback');}return r;});
 const quarantine=assert.rejects(q.quarantine(old.sid,hash),/fixture_quarantine_rollback/);await entered.promise;
 const apply=worker.apply(next.lease,next.proof);
 try {await waitForLocks(1);} finally {release.resolve();}
 await Promise.all([quarantine,apply]);await disposition(next,'credited');
 assert.equal((await row("SELECT count(*) n FROM payment_incidents WHERE settlement_id=$1 AND kind='reorg'",[old.sid])).n,'0');
});

test('Q04 real SQL serialization failure retries under active quarantine and retains one exact settlement',async()=>{
 const old=await credited(),next=await prepared();await worker.quarantine(old.sid,hash);
 let injected=false;const snapshots=[],levels=[];
 const s=instrument(async x=>{
  if(x.sql.startsWith('BEGIN')){const r=await x.run();levels.push((await x.c.query('SHOW transaction_isolation')).rows[0].transaction_isolation);return r;}
  if(!injected && x.sql.startsWith("UPDATE dispatch.outbox_jobs SET state='retry'")){
   injected=true;await x.c.query("DO $$ BEGIN RAISE SQLSTATE '40001' USING MESSAGE='fixture_serialization_retry'; END $$");
  }
  const r=await x.run();if(x.sql.includes('AS quarantined'))snapshots.push(r.rows[0].quarantined);return r;
 });
 await s.apply(next.lease,next.proof);assert.deepEqual(levels,['read committed','read committed']);assert.deepEqual(snapshots,[true,true]);
 await disposition(next,'review');assert.equal((await row('SELECT count(*) n FROM settlements WHERE order_id=$1',[next.order])).n,'1');
 console.log(JSON.stringify({retry_isolation:levels,retry_quarantine:snapshots}));
});

for(const quarantined of [false,true])test(`Q05 concurrent workers with quarantine=${quarantined} cannot duplicate effects`,async()=>{
 const old=await credited(),next=await prepared();if(quarantined)await worker.quarantine(old.sid,hash);
 const blocker=await admin.connect();let results;
 try {
  await blocker.query('BEGIN');await blocker.query("SELECT * FROM dispatch.merchant_control WHERE merchant_id='single' FOR UPDATE");
  const first=worker.apply(next.lease,next.proof);await waitForLocks(1);
  const second=new PaymentWorker(workerPool,encryptionKey).apply(next.lease,next.proof);const all=Promise.allSettled([first,second]);await waitForLocks(2);
  await blocker.query('COMMIT');results=await all;
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.message,'stale_settlement');
 await disposition(next,quarantined?'review':'credited');assert.equal((await row('SELECT count(*) n FROM settlements WHERE order_id=$1',[next.order])).n,'1');
});

test('Q06 stronger pool defaults are overridden at BEGIN; direct old-snapshot control calls reject',async()=>{
 const old=await credited(),next=await prepared();
 const clients=[];
 try {
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE','READ UNCOMMITTED']){
   const c=await workerPool.connect();clients.push(c);await c.query('BEGIN ISOLATION LEVEL '+isolation);
   assert.equal((await c.query("SELECT count(*) n FROM dispatch.payment_incidents WHERE kind='reorg' AND resolved_at IS NULL")).rows[0].n,'0');
  }
  await worker.quarantine(old.sid,hash);
  for(const [i,c] of clients.entries()){
   const visible=(await c.query("SELECT count(*) n FROM dispatch.payment_incidents WHERE kind='reorg' AND resolved_at IS NULL")).rows[0].n;
   assert.equal(visible,i<2?'0':'1');
   await assert.rejects(control(c),/unsupported_transaction_isolation/);await c.query('ROLLBACK');
  }
  assert.equal((await row('SELECT count(*) n FROM settlements WHERE order_id=$1',[next.order])).n,'0');
  assert.equal((await row('SELECT state FROM payment_attempts WHERE id=$1',[next.id])).state,'pending');
  console.log(JSON.stringify({old_snapshots:['repeatable read','serializable'],direct_control:'rejected_before_financial_mutation'}));
 }finally{for(const c of clients){await c.query('ROLLBACK');c.release();}}
 for(const isolation of ['repeatable read','serializable','read uncommitted']){
  const p=new Pool({host:process.env.DISPATCH_DB_HOST,port:55442,user:'local_worker',database:'dispatch',
   options:'-c search_path=dispatch,pg_catalog -c default_transaction_isolation='+isolation.replaceAll(' ','\\ ')});pools.push(p);
  assert.equal((await p.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation,isolation);
  await transaction(p,async c=>{assert.equal((await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'read committed');assert.equal((await control(c)).quarantined,true);});
  const s=new PaymentWorker(p,encryptionKey);await s.apply(next.lease,evidence(await s.binding(next.id)));await disposition(next,'review');
  await admin.query("UPDATE outbox_jobs SET available_at=now() WHERE id=$1",[next.lease.job]);next.lease=await s.claimReconcile(next.id);
 }
 assert.equal((await row('SELECT count(*) n FROM settlements WHERE order_id=$1',[next.order])).n,'3');
});

test('Q07 resolved global incident cannot override durable order-specific review',async()=>{
 const old=await credited(),next=await prepared();await worker.quarantine(old.sid,hash);
 await worker.apply(next.lease,next.proof);await resolveFixtureIncidents();
 await admin.query("UPDATE outbox_jobs SET available_at=now() WHERE id=$1",[next.lease.job]);
 await worker.apply(await worker.claimReconcile(next.id),evidence(await worker.binding(next.id)));
 await disposition(next,'review');assert.equal((await row('SELECT count(*) n FROM settlements WHERE order_id=$1',[next.order])).n,'2');
});

test('Q08 retain cross-order quarantine fixture for process/database restart and repeated observations',async()=>{
 const old=await credited(),next=await prepared();await worker.quarantine(old.sid,hash);
 assert.equal((await row("SELECT count(*) n FROM payment_incidents WHERE settlement_id=$1 AND kind='reorg' AND resolved_at IS NULL",[old.sid])).n,'1');
 keepFinalQuarantine=true;
 await writeFile(process.env.DISPATCH_DB_HOST+'/quarantine-restart.json',JSON.stringify({order:next.order,attempt:next.id,source:old.sid}));
});
