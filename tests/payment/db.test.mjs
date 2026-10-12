import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { migrate } from '../../dist/packages/db/src/migrate.js';
import { Commerce, transaction, control, rollover } from '../../dist/packages/db/src/commerce.js';
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
import { FacilitatorTransport } from '../../dist/packages/payments/src/facilitator.js';
import { submitInitial, reconcileKnown } from '../../dist/apps/worker/src/payments.js';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { apiServer } from '../../dist/apps/api/src/app.js';
import { exactSettlement, typed } from '../../dist/packages/payments/src/settlement.js';
import { freshObservation } from '../../dist/packages/payments/src/application.js';
import { digitalTotal } from '../../dist/packages/domain/src/payment.js';
import { pools,pool,admin,api,workerPool,worker,commerce,encryptionKey,chain,origin,provider,seed,purchase,bind,evidence,pending,verified,unknown,support } from './helpers.mjs';
assert.match(process.env.DISPATCH_DB_HOST,/^\/tmp\/dispatch-b2-/);
let fixture;
test.before(async()=>{await migrate(pool('local_migrator'));fixture=await seed();});
test.after(async()=>{for(const p of pools)await p.end();});
const count=async(table,where='',args=[])=>Number((await admin.query(`SELECT count(*) n FROM dispatch.${table} ${where}`,args)).rows[0].n);
test('B3-01 confirmed independent grant precedes quote; public IDs/signatures cannot authorize',async()=>{
 const c=await commerce.create({product_id:fixture.product,product_version:1,quantity:1,client_kind:'agent'});
 await assert.rejects(commerce.quote(c.id,c.agent_capability,randomUUID(),{product_version:1,quantity:1,policy_version:'policy-1'}),/unauthorized/);
 await assert.rejects(commerce.status(c.id,'x'.repeat(43)),/unauthorized/);
 await commerce.status(c.id,c.agent_capability);
 const p=await purchase(fixture.product);
 await assert.rejects(commerce.status(p.order,c.agent_capability),/unauthorized/);
 await assert.rejects(commerce.status(c.id,p.payment.payload.signature),/invalid_input/);
});
test('B3-02 authoritative immutable quote, explicit tax and replay conflict',async()=>{
 const p=await purchase(fixture.product);
 assert.equal(p.q.total_atomic,'1'); assert.equal(p.q.tax_source,'owner-fixture');assert.equal(p.q.shipping_atomic,'0');
 await assert.rejects(api.query('UPDATE quotes SET total=2 WHERE id=$1',[p.q.id]));
 await assert.rejects(commerce.quote(p.order,p.grant,randomUUID(),{product_version:1,quantity:1,policy_version:'policy-1',total:'0'}),/invalid_input/);
 const k=randomUUID(),v={product_version:1,quantity:1,policy_version:'policy-1'};
 assert.equal((await commerce.quote(p.order,p.grant,k,v)).id,p.q.id);
 await assert.rejects(commerce.quote(p.order,p.grant,k,{...v,policy_version:'other'}),/idempotency_conflict/);
 for(const status of ['unknown','calculated',''])assert.throws(()=>digitalTotal('1',status,'source','v'));
 for(const amount of ['0','1.1','-1','1e6'])assert.throws(()=>digitalTotal(amount,'tax_included','source','v'));
 assert.throws(()=>digitalTotal('1','merchant_attested_zero','','v'));
});
test('B3-03 32 identical concurrent deliveries retain one durable attempt, job, allocation',async()=>{
 const p=await purchase(fixture.product),k=randomUUID();const ids=await Promise.all(Array.from({length:32},()=>bind(p,k)));
 assert.equal(new Set(ids).size,1);
 for(const table of ['payment_attempts','outbox_jobs'])assert.equal(await count(table,'WHERE order_id=$1',[p.order]),1);
 assert.equal(await count('budget_allocations','WHERE attempt_id=$1',[ids[0]]),1);
 await admin.query('UPDATE merchant_control SET payment_paused=true');
 assert.equal(await bind(p,k),ids[0]);
 const offline=new Commerce(api,encryptionKey,{...chain,preaccept:async()=>{throw new Error('rpc_down');}},origin,'https://offline.invalid');
 assert.equal(await bind(p,k,offline),ids[0]);
 assert.equal(await offline.paymentChallenge(p.order,p.grant,p.q.id,p.q.quote_hash),null);
 await admin.query('UPDATE merchant_control SET payment_paused=false');
 assert.equal(await commerce.paymentChallenge(p.order,p.grant,p.q.id,p.q.quote_hash),null);
 await assert.rejects(commerce.cancel(p.order,p.grant,randomUUID()),/unresolved_payment/);
});
test('B3-04 distinct nonces concurrently submitted to one order cannot open two attempts',async()=>{
 const p=await purchase(fixture.product);
 const variants=await Promise.all(Array.from({length:32},async()=>{
  const q={...p,payment:structuredClone(p.payment)},a=q.payment.payload.authorization;a.nonce='0x'+randomUUID().replaceAll('-','').repeat(2);
  q.payment.payload.signature=await p.account.signTypedData(typed({...a,token:q.payment.accepted.asset,domainName:'USD Coin',domainVersion:'2'}));return q;
 }));
 const r=await Promise.allSettled(variants.map(x=>bind(x)));assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),1);
});
test('B3-05 same signed authorization cannot bind another authorized order',async()=>{
 const a=await purchase(fixture.product),b=await purchase(fixture.product);await bind(a);
 b.payment.payload=structuredClone(a.payment.payload);
 await assert.rejects(bind(b),/binding_conflict/);assert.equal(await count('payment_attempts','WHERE order_id=$1',[b.order]),0);
});
for(const field of ['network','asset','payTo','amount'])test('B3-06 reject changed '+field+' before durable effect',async()=>{
 const p=await purchase(fixture.product);p.payment.accepted[field]=field==='amount'?'2':'wrong';
 await assert.rejects(bind(p));assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),0);
});
test('B3-07 used/cancelled/historical nonce and stale/foreign chain/domain observations reject',async()=>{
 for(const patch of [{nonceUsed:true},{chainId:1},{decimals:18},{domainName:'other'},{domainSeparator:'0x'+'00'.repeat(32)},
  {observedAt:Date.now()-6000},{chainTime:1n},{hash:'bad'}]){
  const c=new Commerce(api,encryptionKey,{...chain,preaccept:async()=>({...await chain.preaccept(),...patch})},origin,provider);
  const p=await purchase(fixture.product);await assert.rejects(bind(p,randomUUID(),c),/preaccept_unusable/);
  assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),0);
 }
});
test('B3-08 valid rejected signature keeps exclusion, reservation budget and encrypted authorization',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);const claim=await worker.claim(id,'verify');
 await worker.save(claim,{...verified,kind:'rejection',code:'insufficient_funds'});
 assert.equal((await admin.query('SELECT state FROM payment_attempts WHERE id=$1',[id])).rows[0].state,'pending');
 await assert.rejects(worker.claim(id,'settle'));
 await assert.rejects(api.query('UPDATE budget_allocations SET released_at=now(),release_evidence=$2 WHERE attempt_id=$1',[id,{}]));
 await assert.rejects(api.query("UPDATE payment_attempts SET state='expired_unspent',disposition_evidence='{}' WHERE id=$1",[id]));
 const row=(await admin.query('SELECT * FROM payment_attempts WHERE id=$1',[id])).rows[0];
 assert.equal(row.authorization_ciphertext.includes(Buffer.from(p.payment.payload.signature)),false);
 assert.equal((await worker.envelope(id)).payment.payload.signature,p.payment.payload.signature);
 await assert.rejects(new PaymentWorker(workerPool,Buffer.alloc(32)).envelope(id));
});
test('B3-09 actual native adapter: concurrent claimant ownership and no sender transaction across HTTP',async()=>{
 const p=await purchase(fixture.product),id=await bind(p),requests=[],observations=[],failures=[];
 let releaseLoser,startLoser,loserInside;
 const start=new Promise(r=>startLoser=r),inside=new Promise(r=>loserInside=r),release=new Promise(r=>releaseLoser=r);
 let scheduled=false,negativeMode=false,negativeRejected=0;
 const pairs=[0,1].map(i=>{
  const owned=pool('local_worker'),tag='b309_caller_'+i,pids=new Set();owned.options.application_name=tag;
  owned.on('connect',client=>{
   pids.add(client.processID);
   // Install once per physical connection; preserve all pg callback/promise paths.
   const original=client.query.bind(client);
   client.query=function(...args){const result=original(...args);
    if(i===1&&scheduled&&typeof args[0]==='string'&&args[0].includes('FROM dispatch.merchant_control')&&args[0].includes('FOR UPDATE')&&!args.some(a=>typeof a==='function'))
     return result.then(async r=>{loserInside();await release;return r;});
    return result;
   };
  });
  owned.on('remove',client=>pids.delete(client.processID));return {pool:owned,tag,pids};
 });
 const observe=async(pair,boundary)=>{
  const rows=(await admin.query("SELECT pid,backend_start,application_name,state,xact_start IS NOT NULL in_transaction FROM pg_stat_activity WHERE datname='dispatch' AND application_name=ANY($1::text[]) ORDER BY pid",[pairs.map(p=>p.tag)])).rows;
  const sender=rows.filter(r=>pair.pids.has(r.pid));assert.ok(sender.length>0);assert.ok(sender.every(r=>r.application_name===pair.tag));
  observations.push({caller:pair.tag,boundary,negative:negativeMode,rows});
  assert.equal(sender.filter(r=>r.in_transaction).length,0,'sending operation owns an open transaction during HTTP');
  return rows;
 };
 // Exercise actual pg promise/callback acquisitions and physical backend reuse.
 for(const pair of pairs){
  const c=await pair.pool.connect(),pid=c.processID;await c.query('SELECT 1');c.release();
  const reused=await pair.pool.connect();assert.equal(reused.processID,pid);reused.release();
  await new Promise((resolve,reject)=>pair.pool.connect((e,c,done)=>{if(e)return reject(e);c.query('SELECT 1',(e)=>{done();e?reject(e):resolve();});}));
  await pair.pool.query('SELECT 1');await new Promise((resolve,reject)=>pair.pool.query('SELECT 1',(e)=>e?reject(e):resolve()));
 }
 class Sender extends PaymentWorker{async claim(...args){const claim=await super.claim(...args);if(scheduled&&args[1]==='verify'){startLoser();await inside;}return claim;}}
 pairs[0].store=new Sender(pairs[0].pool,encryptionKey);pairs[1].store=new PaymentWorker(pairs[1].pool,encryptionKey);
 const servers=[];
 try{
  for(const pair of pairs){const server=createServer(async(req,res)=>{
   try{
    const rows=await observe(pair,'request');
    if(scheduled&&req.url==='/verify')assert.ok(rows.some(r=>r.application_name===pairs[1].tag&&r.in_transaction),'legitimate losing claimant must remain concurrent');
    requests.push(req.url);req.resume();await once(req,'end');await observe(pair,'response');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/verify'?{isValid:true}:{success:true,network:'eip155:8453',transaction:'0x'+'ab'.repeat(32)}));
   }catch(e){if(negativeMode){assert.match(e.message,/sending operation owns/);negativeRejected++;}else failures.push(e.message);res.destroy();}
   finally{if(scheduled&&req.url==='/verify')releaseLoser();}
  });servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));
   pair.transport=new FacilitatorTransport({url:`http://127.0.0.1:${server.address().port}`,loopbackFixture:true,timeoutMs:2000});
  }
  const negative=await pairs[0].pool.connect();negativeMode=true;
  try{await negative.query('BEGIN');const result=await pairs[0].transport.observe('verify',p.payment,p.payment.accepted);
   assert.equal(result.observation.kind,'unknown');assert.equal(negativeRejected,1);assert.equal(requests.length,0);
  }finally{await negative.query('ROLLBACK');negative.release();negativeMode=false;}
  scheduled=true;
  const results=await Promise.allSettled([submitInitial(pairs[0].store,id,pairs[0].transport),(async()=>{await start;return submitInitial(pairs[1].store,id,pairs[1].transport);})()]);
  scheduled=false;assert.deepEqual(failures,[]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.deepEqual(requests,['/verify','/settle']);
  assert.equal(await count('settlements','WHERE order_id=$1',[p.order]),0);assert.equal(await count('outbox_jobs',"WHERE order_id=$1 AND effect_type='entitlement'",[p.order]),0);
  for(const pair of pairs)await assert.rejects(submitInitial(pair.store,id,pair.transport));assert.equal(requests.length,2);
  console.log('B309_OWNERSHIP_OBSERVATIONS',JSON.stringify({observations,negative_control_rejected:negativeRejected,connection_paths:['promise_connect','callback_connect','promise_query','callback_query','reuse']}));
 }finally{releaseLoser();for(const server of servers)await new Promise(r=>server.close(r));}
});
test('B3-10 exact settlement with current lease atomically credits and enqueues once',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const lease=await worker.claimReconcile(id),e=evidence(await worker.binding(id));
 const settlement=await worker.apply(lease,e);
 assert.equal((await commerce.status(p.order,p.grant)).order_state,'paid');
 assert.equal(await count('outbox_jobs',"WHERE order_id=$1 AND effect_type='entitlement'",[p.order]),1);
 assert.equal(await count('entitlements','WHERE order_id=$1',[p.order]),0); // Delivery is exercised by its integration suite.
 await admin.query("UPDATE outbox_jobs SET available_at=now() WHERE id=$1",[lease.job]);
 const second=await worker.claimReconcile(id);assert.equal(await worker.apply(second,e),settlement);
 assert.equal(await count('settlements','WHERE order_id=$1',[p.order]),1);await worker.defer(second);
});
for(const [name,mutate] of [
 ['wrong chain',e=>e.chainId=1],['wrong token',e=>e.transactionTo='0x'+'11'.repeat(20)],['reverted',e=>e.receiptStatus='reverted'],
 ['historical block',e=>e.block=100n],['not safe',e=>e.safeHead=100n],['reorg inclusion',e=>e.canonicalHash='0x'+'11'.repeat(32)],
 ['reorg anchor',e=>e.preacceptCanonicalHash='0x'+'11'.repeat(32)],['missing transfer',e=>e.logs.pop()],
 ['removed log',e=>e.logs[0].removed=true],['extra token log',e=>e.logs.push(e.logs[1])],['unsupported call',e=>e.input='0x12345678'],
 ['expired chain time',e=>e.blockTime=9999999999n]])test('B3-11 settlement rejects '+name,async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const lease=await worker.claimReconcile(id),e=evidence(await worker.binding(id));mutate(e);
 await assert.rejects(worker.apply(lease,e),/settlement_review_required/);
 assert.equal(await count('settlements','WHERE order_id=$1',[p.order]),0);await worker.defer(lease);
});
test('B3-12 stale fence and expired lease cannot credit; exact late evidence retained',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const old=await worker.claimReconcile(id),e=evidence(await worker.binding(id));
 await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.job]);
 await assert.rejects(worker.apply(old,e),/stale_settlement/);
 const current=await worker.claimReconcile(id);await assert.rejects(worker.apply(old,e),/stale_settlement/);
 await worker.apply(current,e);assert.equal(await count('chain_observations','WHERE attempt_id=$1',[id]),3);
});
test('B3-13 rollback after settlement insertion cannot leave paid state or fulfillment job',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);const lease=await worker.claimReconcile(id),e=evidence(await worker.binding(id));
 await admin.query(`CREATE FUNCTION dispatch.test_fail_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.effect_type='entitlement' THEN RAISE EXCEPTION 'synthetic_fault'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER test_fail_effect BEFORE INSERT ON dispatch.outbox_jobs FOR EACH ROW EXECUTE FUNCTION dispatch.test_fail_effect()`);
 try{await assert.rejects(worker.apply(lease,e),/synthetic_fault/);assert.equal(await count('settlements','WHERE order_id=$1',[p.order]),0);
 assert.equal((await commerce.status(p.order,p.grant)).order_state,'payment_pending');}
 finally{await admin.query('DROP TRIGGER test_fail_effect ON dispatch.outbox_jobs; DROP FUNCTION dispatch.test_fail_effect()');}
 await worker.apply(lease,e);
});
test('B3-14 surplus funds retain separate ledger and incident without another effect',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);let l=await worker.claimReconcile(id);
 await worker.apply(l,evidence(await worker.binding(id)));await admin.query('UPDATE outbox_jobs SET available_at=now() WHERE id=$1',[l.job]);
 l=await worker.claimReconcile(id);await worker.apply(l,evidence(await worker.binding(id)));
 assert.equal(await count('settlements',"WHERE order_id=$1 AND disposition='surplus'",[p.order]),1);
 assert.equal(await count('payment_incidents',"WHERE order_id=$1 AND kind='surplus'",[p.order]),1);
 assert.equal(await count('outbox_jobs',"WHERE order_id=$1 AND effect_type='entitlement'",[p.order]),1);
});
test('B3-15 midnight carry-in once before settlement and new claims; no exposure release',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const day=(await admin.query("SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date+1)::text d")).rows[0].d;
 await transaction(workerPool,async c=>{const ctl=await control(c);await rollover(c,ctl.max_day_gross,day);});
 const before=(await admin.query('SELECT gross_reserved FROM spend_budgets WHERE utc_day=$1',[day])).rows[0].gross_reserved;
 await transaction(workerPool,async c=>{const ctl=await control(c);await rollover(c,ctl.max_day_gross,day);});
 assert.equal((await admin.query('SELECT gross_reserved FROM spend_budgets WHERE utc_day=$1',[day])).rows[0].gross_reserved,before);
 assert.equal(await count('budget_allocations','WHERE attempt_id=$1',[id]),2);
 await assert.rejects(api.query('UPDATE spend_budgets SET gross_reserved=0 WHERE utc_day=$1',[day]));
});
test('B3-16 concurrent gross cap conditional claims never oversubscribe',async()=>{
 const ps=await Promise.all(Array.from({length:4},()=>purchase(fixture.product)));
 const n=(await admin.query("SELECT gross_reserved FROM spend_budgets WHERE utc_day=(clock_timestamp() AT TIME ZONE 'UTC')::date")).rows[0].gross_reserved;
 await admin.query('UPDATE merchant_control SET max_order=1,max_day_gross=$1',[String(BigInt(n)+1n)]);
 try{const r=await Promise.allSettled(ps.map(p=>bind(p)));assert.equal(r.filter(x=>x.status==='fulfilled').length,1);}
 finally{await admin.query('UPDATE merchant_control SET max_order=100,max_day_gross=1000000');}
});
test('B3-17 process death after durable call intent recovers read-only, with no second call',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);
 const child=spawn(process.execPath,['tests/payment/crash.mjs',id],{env:{PATH:process.env.PATH,DISPATCH_DB_HOST:process.env.DISPATCH_DB_HOST},stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',code=>reject(new Error('early exit '+code)));});
 child.kill('SIGKILL');await once(child,'exit');
 await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE attempt_id=$1",[id]);
 await worker.recover();await assert.rejects(worker.claim(id,'verify'));await assert.rejects(worker.claim(id,'settle'));
 assert.equal(await count('call_intents','WHERE attempt_id=$1',[id]),1);
 await reconcileKnown(worker,id,chain);assert.equal((await commerce.status(p.order,p.grant)).order_state,'payment_pending');
});
test('B3-18 HTTP unauthorized, wrong Origin, cookie and body mutation have zero financial effect',async()=>{
 const p=await purchase(fixture.product),logs=[];const server=apiServer(api,origin,line=>logs.push(line),commerce);
 await new Promise(r=>server.listen(18083,'127.0.0.1',r));
 try{
  for(const headers of [{},{Authorization:'Bearer '+p.payment.payload.signature},{Authorization:'Bearer '+p.grant,Cookie:'canary=value'}]){
   const r=await fetch(origin+'/v1/checkouts/'+p.order,{headers});assert.equal(r.status,401);
  }
  const r=await fetch(origin+'/v1/checkouts/'+p.order+'/pay',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json',Authorization:'Bearer '+p.grant},body:JSON.stringify({})});assert.equal(r.status,400);
  assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),0);
  assert.equal(logs.join('').includes(p.grant),false);assert.equal(logs.join('').includes(p.payment.payload.signature),false);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('B3-21 independent RPC callback runs after the same single-connection pool is released',async()=>{
 const one=pool('local_api');one.options.max=1;let checked=false;
 const c=new Commerce(one,encryptionKey,{...chain,preaccept:async()=>{
  await Promise.race([one.query('SELECT 1'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('pool held across network')),1000))]);
  checked=true;return chain.preaccept();
 }},origin,provider);
 const p=await purchase(fixture.product);await bind(p,randomUUID(),c);assert.equal(checked,true);
});
test('B3-22 full loopback HTTP quote/challenge/pay/replay/status path binds only once',async()=>{
 const logs=[],server=apiServer(api,origin,line=>logs.push(line),commerce);await new Promise(r=>server.listen(18083,'127.0.0.1',r));
 try{
  const p=await purchase(fixture.product),headers={Origin:origin,Authorization:'Bearer '+p.grant,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'};
  const body=JSON.stringify({quote_id:p.q.id,quote_hash:p.q.quote_hash});
  const challenge=await fetch(origin+'/v1/checkouts/'+p.order+'/pay',{method:'POST',headers,body});assert.equal(challenge.status,402);
  headers['PAYMENT-SIGNATURE']=encodePaymentSignatureHeader(p.payment);
  const paid=await fetch(origin+'/v1/checkouts/'+p.order+'/pay',{method:'POST',headers,body});assert.equal(paid.status,202);
  assert.equal((await paid.json()).order_state,'payment_pending');
  const replay=await fetch(origin+'/v1/checkouts/'+p.order+'/pay',{method:'POST',headers,body});assert.equal(replay.status,202);
  assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),1);
  assert.equal(logs.join('').includes(p.grant),false);assert.equal(logs.join('').includes(p.payment.payload.signature),false);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('B3-23 delayed quote window rejects signing/binding without renewing or canceling an accepted attempt',async()=>{
 const p=await purchase(fixture.product),original=Date.now;
 try{
  Date.now=()=>new Date(p.q.expires_at).getTime()-1000;
  await assert.rejects(commerce.paymentChallenge(p.order,p.grant,p.q.id,p.q.quote_hash),/approval_window_exhausted|stale_snapshot/);
  await assert.rejects(bind(p),/invalid_window|stale_snapshot/);
 }finally{Date.now=original;}
 assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),0);
 const id=await bind(p);await pending(id);
 await worker.expireUnbound();assert.equal((await commerce.status(p.order,p.grant)).order_state,'payment_pending');
});
test('B3-24 binding rollback after idempotency insert leaves no attempt, allocation or job',async()=>{
 const p=await purchase(fixture.product);
 await admin.query(`CREATE FUNCTION dispatch.test_fail_idempotency() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.operation='pay' THEN RAISE EXCEPTION 'synthetic_bind_fault'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER test_fail_idempotency AFTER INSERT ON dispatch.idempotency_records FOR EACH ROW EXECUTE FUNCTION dispatch.test_fail_idempotency()`);
 try{await assert.rejects(bind(p),/synthetic_bind_fault/);
 assert.equal(await count('payment_attempts','WHERE order_id=$1',[p.order]),0);assert.equal(await count('outbox_jobs','WHERE order_id=$1',[p.order]),0);
 assert.equal((await commerce.status(p.order,p.grant)).order_state,'quoted');}
 finally{await admin.query('DROP TRIGGER test_fail_idempotency ON dispatch.idempotency_records; DROP FUNCTION dispatch.test_fail_idempotency()');}
 await bind(p);
});
test('B3-25 genuine adapter disconnect after settle keeps one intent and never autonomously resends',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);let settles=0;
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{
  if(req.url==='/settle'){settles++;req.socket.destroy();return;}
  res.setHeader('Content-Type','application/json');res.end('{"isValid":true}');
 });});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const t=new FacilitatorTransport({url:`http://127.0.0.1:${server.address().port}`,loopbackFixture:true,timeoutMs:1000});
 await submitInitial(worker,id,t);await worker.recover();await reconcileKnown(worker,id,chain);
 await assert.rejects(submitInitial(worker,id,t));assert.equal(settles,1);assert.equal((await commerce.status(p.order,p.grant)).order_state,'payment_pending');
 assert.equal(await count('outbox_jobs',"WHERE order_id=$1 AND effect_type='entitlement'",[p.order]),0);
 }finally{await new Promise(r=>server.close(r));}
});
test('B3-26 settlement carries yesterday-only unresolved exposure into current UTC day before terminal state',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 const yesterday=(await admin.query("SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date-1)::text d")).rows[0].d;
 // Arrange a legitimate prior-day allocation using the fixture administrator; no runtime release API.
 await admin.query("INSERT INTO spend_budgets(merchant_id,utc_day,cap,gross_reserved) VALUES('single',$1,1000000,1) ON CONFLICT DO NOTHING",[yesterday]);
 await admin.query("INSERT INTO budget_allocations(attempt_id,merchant_id,utc_day,amount) VALUES($1,'single',$2,1)",[id,yesterday]);
 await admin.query("DELETE FROM budget_allocations WHERE attempt_id=$1 AND utc_day=(clock_timestamp() AT TIME ZONE 'UTC')::date",[id]);
 const l=await worker.claimReconcile(id);await worker.apply(l,evidence(await worker.binding(id)));
 assert.equal(await count('budget_allocations','WHERE attempt_id=$1',[id]),2);
 assert.equal((await admin.query('SELECT state FROM payment_attempts WHERE id=$1',[id])).rows[0].state,'settled');
});
test('B3-27 SQL roles cannot rewrite saved challenge, outcomes, or create chain evidence from buyer connection',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 await assert.rejects(api.query('UPDATE payment_challenges SET requirements=$2 WHERE quote_id=$1',[p.q.id,{}]));
 await assert.rejects(api.query("INSERT INTO chain_observations(id,attempt_id,evidence_digest,result) VALUES($1,$2,$3,'exact')",[randomUUID(),id,'0x'+'11'.repeat(32)]));
 await assert.rejects(workerPool.query('UPDATE call_outcomes SET verified=false'));
 await assert.rejects(api.query('DELETE FROM payment_attempts WHERE id=$1',[id]));
});
test('B3-28 changed policy blocks an unquoted draft and preserves the already issued quote',async()=>{
 const issued=await purchase(fixture.product),draft=await commerce.create({product_id:fixture.product,product_version:1,quantity:1,client_kind:'agent'});
 await commerce.status(draft.id,draft.agent_capability);const config=randomUUID();
 await admin.query(`INSERT INTO merchant_config_versions(id,version,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,policy_version,policy_urls,finality_policy)
 SELECT $1,2,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,'policy-2','["https://fixture.invalid/policy/2"]',finality_policy FROM merchant_config_versions WHERE id=$2`,[config,fixture.config]);
 await admin.query('UPDATE merchant_control SET config_id=$1',[config]);
 try{
  await assert.rejects(commerce.quote(draft.id,draft.agent_capability,randomUUID(),{product_version:1,quantity:1,policy_version:'policy-1'}),/stale_policy/);
  assert.equal(await count('quotes','WHERE order_id=$1',[draft.id]),0);
  assert.ok(await commerce.paymentChallenge(issued.order,issued.grant,issued.q.id,issued.q.quote_hash));
  assert.equal((await commerce.status(issued.order,issued.grant)).policy_version,'policy-1');
 }finally{await admin.query('UPDATE merchant_control SET config_id=$1',[fixture.config]);}
});
test('B3-29 late exact funds on a legacy expired order append review ledger without fulfillment',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);
 // Legacy-state fixture only: the public cancel/expiry commands cannot do this to a bound attempt.
 await admin.query("UPDATE orders SET state='expired' WHERE id=$1",[p.order]);
 const l=await worker.claimReconcile(id);await worker.apply(l,evidence(await worker.binding(id)));
 assert.equal(await count('settlements',"WHERE order_id=$1 AND disposition='late'",[p.order]),1);
 assert.equal(await count('outbox_jobs',"WHERE order_id=$1 AND effect_type='entitlement'",[p.order]),0);
 assert.equal((await commerce.status(p.order,p.grant)).order_state,'review_required');
});
test('B3-30 UTC rollover at commit rolls back financial work and retries SQL atomically',async()=>{
 let runs=0;const event=randomUUID();
 await transaction(workerPool,async c=>{
  const ctl=await control(c);await rollover(c,ctl.max_day_gross,ctl.today);runs++;
  await c.query("INSERT INTO audit_events(id,actor_kind,action,safe_fields) VALUES($1,'system','utc-retry-fixture','{}')",[event]);
  // Controlled date rollover at the final guard; a duplicate event would expose partial commit.
  if(runs===1)await c.query("SELECT set_config('dispatch.budget_day','2000-01-01',true)");
 });
 assert.equal(runs,2);assert.equal(await count('audit_events','WHERE id=$1',[event]),1);
});
test('B3-19 reorg quarantines without removing paid ledger; replay cannot regrant fulfillment',async()=>{
 const p=await purchase(fixture.product),id=await bind(p);await pending(id);const l=await worker.claimReconcile(id);
 const sid=await worker.apply(l,evidence(await worker.binding(id)));await worker.quarantine(sid,'0x'+'cc'.repeat(32));
 assert.equal((await commerce.status(p.order,p.grant)).delivery.state,'blocked');assert.equal(await count('settlements','WHERE id=$1',[sid]),1);
 await worker.quarantine(sid,'0x'+'cc'.repeat(32));assert.equal(await count('payment_incidents',"WHERE settlement_id=$1 AND kind='reorg'",[sid]),1);
});
test('B3-20 default mainnet and physical flags cannot be enabled by runtime roles',async()=>{
 await assert.rejects(api.query('UPDATE merchant_control SET mainnet_enabled=true'));
 await assert.rejects(admin.query('UPDATE merchant_control SET mainnet_enabled=true'));
 await assert.rejects(api.query('UPDATE merchant_control SET physical_enabled=true'));
 await admin.query('UPDATE merchant_control SET payment_paused=true');
});
