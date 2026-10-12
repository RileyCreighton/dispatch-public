import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { migrate } from '../../dist/packages/db/src/migrate.js';
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
import { apiServer } from '../../dist/apps/api/src/app.js';
import { pools,pool,admin,api,workerPool,worker,commerce,encryptionKey,origin,seed,purchase,bind,evidence,pending } from './helpers.mjs';
let fixture;
const responses=[];
const row=async(sql,args=[]) => (await admin.query(sql,args)).rows[0];
const count=async(table,order) => Number((await row(`SELECT count(*) n FROM dispatch.${table} WHERE order_id=$1`,[order])).n);
const jobs=async(order) => Number((await row("SELECT count(*) n FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[order])).n);
const available=async(id) => admin.query("UPDATE outbox_jobs SET available_at=clock_timestamp() WHERE attempt_id=$1 AND effect_type='reconcile'",[id]);
async function observe(id,e,store=worker) { await available(id);return store.apply(await store.claimReconcile(id),e); }
async function noCredit(order) {
 assert.equal((await row("SELECT count(*) n FROM settlements WHERE order_id=$1 AND disposition='credited'",[order])).n,'0');
 assert.equal(await jobs(order),0);assert.equal(await count('entitlements',order),0);
 const state=await row('SELECT state,fulfillment_state FROM orders WHERE id=$1',[order]);
 assert.deepEqual(state,{state:'review_required',fulfillment_state:'blocked'});
}
async function serverRun(fn) {
 const server=apiServer(api,origin,()=>{},commerce);await new Promise(r=>server.listen(18083,'127.0.0.1',r));
 try { await fn(); } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}
async function http(p,operation='',body,signature) {
 const headers={Authorization:'Bearer '+p.grant};
 if(body){Object.assign(headers,{Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()});}
 if(signature)headers['PAYMENT-SIGNATURE']=encodePaymentSignatureHeader(signature);
 const response=await fetch(origin+'/v1/checkouts/'+p.order+operation,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});
 const raw=await response.text(),data=JSON.parse(raw);
 if(response.status===200 || response.status===202){assert.equal(data.request_id,response.headers.get('X-Request-ID'));responses.push({schema:'CheckoutStatus',route:operation||'GET',http:response.status,raw});}
 else responses.push({schema:'Error',route:operation,http:response.status,raw});
 return {response,data,raw};
}
test.before(async()=>{await migrate(pool('local_migrator'));fixture=await seed();});
test.after(async()=>{await writeFile(process.env.DISPATCH_DB_HOST+'/schema-responses.json',JSON.stringify(responses,null,2)+'\n');for(const p of pools)await p.end();});

test('B3-C01 timely exact transfer credits once under competing observations and stale lease cannot commit',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const stale=await worker.claimReconcile(id),e=evidence(await worker.binding(id));
 await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[stale.job]);
 const current=await worker.claimReconcile(id);
 await assert.rejects(worker.apply(stale,e),/stale_settlement/);
 const outcomes=await Promise.allSettled([worker.apply(current,e),worker.apply(current,e)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(await count('settlements',p.order),1);assert.equal(await jobs(p.order),1);
 const status=await commerce.status(p.order,p.grant);assert.equal(status.order_state,'paid');assert.equal(status.payment_state,'settled');assert.equal(status.delivery.state,'queued');
});

test('B3-C02 more than one batch of missing recovery jobs progresses under concurrent workers',async()=>{
 const attempts=[];
 for(let i=0;i<102;i++){const p=await purchase(fixture.product),id=await bind(p),claim=await worker.claim(id,'verify');attempts.push({id,claim});}
 await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[attempts.map(a=>a.claim.job)]);
 const second=new PaymentWorker(workerPool,encryptionKey);
 const cycles=await Promise.all([worker.recover(),second.recover(),worker.recover(),second.recover()]);
 assert.ok(cycles.every(n=>n<=100));assert.equal(cycles.reduce((a,b)=>a+b),102);assert.equal(await second.recover(),0);
 for(const {id} of attempts){assert.equal((await row("SELECT count(*) n FROM outbox_jobs WHERE attempt_id=$1 AND effect_type='reconcile'",[id])).n,'1');assert.equal((await row('SELECT state FROM payment_attempts WHERE id=$1',[id])).state,'pending');await assert.rejects(worker.claim(id,'verify'));await assert.rejects(worker.claim(id,'settle'));}
 console.log(JSON.stringify({probe:'correction-missing-recovery-batches',candidates:102,cycles}));
});

test('B3-C03 active and expired leases retain coverage; done and dead-letter jobs resume read-only work once',async()=>{
 const cases=[];
 for(const state of ['queued','retry','leased','expired_lease','done','dead_letter']){
  const p=await purchase(fixture.product),id=await bind(p);await pending(id);
  const lease=await worker.claimReconcile(id);
  await admin.query("UPDATE outbox_jobs SET state=$2,lease_until=clock_timestamp()+$3::interval,last_safe_error='fixture_failure' WHERE id=$1",[lease.job,state==='expired_lease'?'leased':state,state==='expired_lease'?'-1 second':'1 hour']);
  cases.push({p,id,lease,state,before:await row('SELECT * FROM outbox_jobs WHERE id=$1',[lease.job])});
 }
 await admin.query("UPDATE payment_attempts SET state='review_required' WHERE id=$1",[cases.at(-1).id]);
 assert.equal(await worker.recover(),2);assert.equal(await worker.recover(),0);
 for(const {p,id,lease,state,before} of cases){
  const after=await row('SELECT * FROM outbox_jobs WHERE id=$1',[lease.job]);
  if(['done','dead_letter'].includes(state)){
   assert.equal(after.state,'retry');assert.equal(BigInt(after.fence),BigInt(before.fence)+1n);assert.equal(after.attempts,before.attempts);assert.equal(after.last_safe_error,'fixture_failure');
   await assert.rejects(worker.apply(lease,evidence(await worker.binding(id))),/stale_settlement/);
  } else assert.deepEqual(after,before);
  assert.equal(await jobs(p.order),0);assert.equal((await row('SELECT count(*) n FROM call_intents WHERE attempt_id=$1',[id])).n,'2');
 }
 const expired=cases.find(c=>c.state==='expired_lease'),next=await worker.claimReconcile(expired.id);
 await assert.rejects(worker.apply(expired.lease,evidence(await worker.binding(expired.id))),/stale_settlement/);await worker.defer(next);
 assert.equal((await row('SELECT state FROM payment_attempts WHERE id=$1',[cases.at(-1).id])).state,'review_required');
});

test('B3-C04 actual HTTP policy errors preserve safe actions and pending/paid precedence with no new effects',async()=>{
 const d=await commerce.create({product_id:fixture.product,product_version:1,quantity:1,client_kind:'agent'});await commerce.status(d.id,d.agent_capability);
 const draft={order:d.id,grant:d.agent_capability},pendingP=await purchase(fixture.product),priorKey=randomUUID();
 await commerce.quote(pendingP.order,pendingP.grant,priorKey,{product_version:1,quantity:1,policy_version:'policy-1'});
 const pid=await bind(pendingP);await pending(pid);
 await assert.rejects(commerce.quote(pendingP.order,pendingP.grant,priorKey,{product_version:1,quantity:1,policy_version:'policy-1'}),/quote_unavailable/);
 const paid=await purchase(fixture.product),paidId=await bind(paid);await pending(paidId);await observe(paidId,evidence(await worker.binding(paidId)));
 const config=randomUUID();await admin.query(`INSERT INTO merchant_config_versions(id,version,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,policy_version,policy_urls,finality_policy)
 SELECT $1,2,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,'policy-2','["https://fixture.invalid/policy/2"]',finality_policy FROM merchant_config_versions WHERE id=$2`,[config,fixture.config]);
 await admin.query('UPDATE merchant_control SET config_id=$1',[config]);
 try {await serverRun(async()=>{
  for(const [p,policy,code,action] of [[draft,'wrong','STALE_POLICY','review_policy'],[draft,'policy-1','STALE_POLICY','create_checkout'],[pendingP,'wrong','PAYMENT_CONFLICT','poll_status'],[paid,'wrong','PAYMENT_CONFLICT','poll_status']]){
   const before=await row('SELECT (SELECT count(*) FROM quotes) quotes,(SELECT count(*) FROM payment_attempts) attempts,(SELECT count(*) FROM budget_allocations) allocations,(SELECT count(*) FROM outbox_jobs) jobs');
   const r=await http(p,'/quote',{product_version:1,quantity:1,policy_version:policy});assert.equal(r.response.status,409);assert.equal(r.data.code,code);assert.equal(r.data.next_action,action);
   assert.deepEqual(await row('SELECT (SELECT count(*) FROM quotes) quotes,(SELECT count(*) FROM payment_attempts) attempts,(SELECT count(*) FROM budget_allocations) allocations,(SELECT count(*) FROM outbox_jobs) jobs'),before);
  }
 });}finally{await admin.query('UPDATE merchant_control SET config_id=$1',[fixture.config]);}
});

test('B3-C05 HTTP GET and payment 202 share the accepted status contract across durable states',async()=>{
 const p=await purchase(fixture.product);
 await serverRun(async()=>{
  const draft=await commerce.create({product_id:fixture.product,product_version:1,quantity:1,client_kind:'agent'});
  const draftStatus=await http({order:draft.id,grant:draft.agent_capability});assert.equal(draftStatus.data.order_state,'draft');assert.equal(draftStatus.data.next_action,'review_policy');
  let r=await http(p);assert.equal(r.data.order_state,'quoted');assert.equal(r.data.payment_state,'none');
  r=await http(p,'/pay',{quote_id:p.q.id,quote_hash:p.q.quote_hash},p.payment);assert.equal(r.response.status,202);assert.equal(r.data.payment_state,'ready_to_submit');
  const id=(await row('SELECT id FROM payment_attempts WHERE order_id=$1',[p.order])).id;
  const claim=await worker.claim(id,'verify');r=await http(p);assert.equal(r.data.payment_state,'submitting');
  await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[claim.job]);await worker.recover();
  r=await http(p);assert.equal(r.data.order_state,'payment_pending');assert.equal(r.data.payment_state,'pending');
  r=await http(p,'/pay',{quote_id:p.q.id,quote_hash:p.q.quote_hash});assert.equal(r.response.status,202);assert.equal(r.data.payment_state,'pending');
  await observe(id,evidence(await worker.binding(id)));r=await http(p);assert.equal(r.data.order_state,'paid');assert.equal(r.data.delivery.state,'queued');
  r=await http(p,'/pay',{quote_id:p.q.id,quote_hash:p.q.quote_hash});assert.equal(r.response.status,202);assert.equal(r.data.payment_state,'settled');
  for(const state of ['review_required','expired']){const other=await purchase(fixture.product);await admin.query('UPDATE orders SET state=$2,fulfillment_state=$3 WHERE id=$1',[other.order,state,state==='review_required'?'blocked':'not_ready']);r=await http(other);assert.equal(r.data.order_state,state);assert.equal(r.data.payment_state,'none');}
  const unauth=await fetch(origin+'/v1/checkouts/'+p.order);assert.equal(unauth.status,401);assert.equal('payment_state' in await unauth.json(),false);
  const unrelated=await purchase(fixture.product);const denied=await http({...p,grant:unrelated.grant});assert.equal(denied.response.status,401);assert.equal('payment_state' in denied.data,false);
 });
});

test('B3-C06 full PostgreSQL bigint versions serialize as exact JSON integer tokens',async()=>{
 const p=await purchase(fixture.product);
 await serverRun(async()=>{for(const version of ['0','9007199254740991','9007199254740992','9007199254740993','9223372036854775807']){
  await admin.query('UPDATE orders SET version=$2 WHERE id=$1',[p.order,version]);const r=await http(p);
  assert.equal(r.response.status,200);assert.match(r.raw,new RegExp('"version":'+version+'[,}]'));responses.at(-1).expected_version=version;
 }});
});

test('B3-C07 late/cancelled historical disposition wins over changed projection, concurrent observations and stale leases',async()=>{
 for(const terminal of ['expired','cancelled']){
  const p=await purchase(fixture.product),id=await bind(p);await pending(id);await admin.query('UPDATE orders SET state=$2 WHERE id=$1',[p.order,terminal]);
  const b=await worker.binding(id),first=evidence(b),sid=await observe(id,first);await noCredit(p.order);
  // Prove the immutable ledger, not only the mutable projection, prevents credit.
  await admin.query("UPDATE orders SET state='payment_pending',fulfillment_state='not_ready' WHERE id=$1",[p.order]);
  const restart=new PaymentWorker(workerPool,encryptionKey),replacement=evidence(b);assert.notEqual(replacement.transactionHash,first.transactionHash);
  await available(id);const stale=await restart.claimReconcile(id);await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[stale.job]);
  const current=await restart.claimReconcile(id);await assert.rejects(restart.apply(stale,replacement),/stale_settlement/);
  const results=await Promise.allSettled([restart.apply(current,replacement),worker.apply(current,replacement)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await noCredit(p.order);assert.equal(await count('settlements',p.order),2);
  assert.equal(await observe(id,first,restart),sid);await noCredit(p.order);assert.equal(await count('settlements',p.order),2);
  assert.equal((await row('SELECT count(*) n FROM budget_allocations WHERE attempt_id=$1 AND released_at IS NOT NULL',[id])).n,'0');
 }
});

test('B3-C08 current blocked states and retained review settlement never authorize fulfillment',async()=>{
 for(const blocked of ['order','delivery','attempt','history']){
  const p=await purchase(fixture.product),id=await bind(p);await pending(id);
  if(blocked==='order'||blocked==='history')await admin.query("UPDATE orders SET state='review_required' WHERE id=$1",[p.order]);
  if(blocked==='delivery')await admin.query("UPDATE orders SET fulfillment_state='blocked' WHERE id=$1",[p.order]);
  if(blocked==='attempt')await admin.query("UPDATE payment_attempts SET state='review_required' WHERE id=$1",[id]);
  const b=await worker.binding(id);await observe(id,evidence(b));await noCredit(p.order);
  if(blocked==='history'){
   await admin.query("UPDATE orders SET state='payment_pending',fulfillment_state='not_ready' WHERE id=$1",[p.order]);await admin.query("UPDATE payment_attempts SET state='pending' WHERE id=$1",[id]);
   await admin.query('UPDATE payment_incidents SET resolved_at=now() WHERE order_id=$1',[p.order]);await observe(id,evidence(b));await noCredit(p.order);
  }
 }
});

test('B3-C09 unresolved reorg and global quarantine retain late/replacement evidence with zero authority',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const other=await purchase(fixture.product),otherId=await bind(other);await pending(otherId);
 await admin.query("UPDATE orders SET state='expired' WHERE id=$1",[p.order]);
 const b=await worker.binding(id),sid=await observe(id,evidence(b));await worker.quarantine(sid,'0x'+'cd'.repeat(32));
 await observe(id,evidence(b));await observe(id,evidence(b));await noCredit(p.order);
 await observe(otherId,evidence(await worker.binding(otherId)));await noCredit(other.order);
 assert.equal((await row("SELECT count(*) n FROM payment_incidents WHERE order_id=$1 AND kind='reorg' AND resolved_at IS NULL",[p.order])).n,'1');
 assert.equal(await count('settlements',p.order),3);assert.equal((await row('SELECT count(DISTINCT attempt_id) n FROM settlements WHERE order_id=$1',[p.order])).n,'1');
 await writeFile(process.env.DISPATCH_DB_HOST+'/correction-restart.json',JSON.stringify({order:p.order,attempt:id}));
});
