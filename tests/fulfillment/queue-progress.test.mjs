import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {Pool} from 'pg';
import {setup,teardown,admin,worker,policy,newSigner,settle,support} from './fixtures.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {digest} from '../../dist/packages/db/src/commerce.js';
import {MerchantReceiver,merchantServer} from '../../dist/examples/merchant-adapter/src/server.js';
import {WebhookTransport} from '../../dist/packages/fulfillment/src/transport.js';
const base=process.env.DISPATCH_DB_HOST,bindings=new Map([['reference',digest('https://127.0.0.1:18444/dispatch/v1/events')]]);
const store=new DeliveryStore(worker.pool,bindings);let receiverPool,server,target;
const history=[];
async function tickProcess(){const child=fork('tests/fulfillment/process.mjs',['worker'],{env:process.env,stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',d=>errors+=d);const [code]=await once(child,'exit');assert.equal(code,0,errors);}
async function concurrentTicks(){
 const runs=Array.from({length:2},()=>{const child=fork('tests/fulfillment/queue-worker-child.mjs',[],{env:process.env,stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',d=>errors+=d);
  const selected=once(child,'message'),done=once(child,'exit').then(([code])=>assert.equal(code,0,errors));return {child,selected,done};});
 const choices=await Promise.all(runs.map(r=>r.selected));assert.deepEqual(choices[0],choices[1]);for(const r of runs)r.child.send({go:true});await Promise.all(runs.map(r=>r.done));
}
async function paid(){await support();await admin.query('TRUNCATE abuse_counters');const directory=base+'/progress-'+randomUUID(),j=await createPurchase(policy(),directory),saved=await j.read();await authorizePurchase(directory,policy(),await newSigner());await settle(saved.order);return {...saved,directory};}
async function jobs(){return (await admin.query("SELECT id,order_id,attempt_id,effect_type,effect_key,payload_reference,state,attempts FROM outbox_jobs WHERE effect_type IN ('entitlement','merchant_paid') ORDER BY id")).rows;}
async function incident(order){await admin.query("INSERT INTO payment_incidents(id,order_id,kind,evidence) VALUES($1,$2,'fixture_order_review','{}')",[randomUUID(),order]);}
async function restrict(p,index){p.restriction=['blocked','revoked','incident','order_review'][index%4];
 if(p.restriction==='incident')await incident(p.order);
 else if(p.restriction==='order_review')await admin.query("UPDATE orders SET state='review_required' WHERE id=$1",[p.order]);
 else{await admin.query('UPDATE orders SET fulfillment_state=$2 WHERE id=$1',[p.order,p.restriction]);if(p.restriction==='revoked')await admin.query("UPDATE entitlements SET state='revoked' WHERE order_id=$1",[p.order]);}
}
test.before(async()=>{
 await setup();assert.deepEqual(await store.pending(),[]);const key=randomBytes(32),bearer=randomBytes(32).toString('base64url'),cert=await readFile(base+'/tls.crt','utf8');
 await writeFile(base+'/webhook.key',key,{mode:0o600});await writeFile(base+'/adapter.bearer',bearer,{mode:0o600});
 await admin.query(await readFile('examples/merchant-adapter/schema.sql','utf8'));
 await admin.query('CREATE ROLE fixture_receiver LOGIN; GRANT USAGE ON SCHEMA merchant_adapter TO fixture_receiver; GRANT SELECT,INSERT ON merchant_adapter.orders TO fixture_receiver');
 receiverPool=new Pool({host:base,port:55442,user:'fixture_receiver',database:'dispatch'});
 server=merchantServer(new MerchantReceiver(receiverPool),{origin:'https://127.0.0.1:18444',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});server.listen(18444,'127.0.0.1');await once(server,'listening');
 target=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18444/dispatch/v1/events',keyId:'fixture-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));await receiverPool?.end();await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/queue-progress.json',JSON.stringify(history,null,2)+'\n');await teardown();});
test('B5-C2 42 mixed restricted jobs, actual concurrent worker restarts, private bytes and receiver receipts',async()=>{
 const prefix=[];
 for(let i=0;i<42;i++){
  const p=await paid();p.pregranted=i<21;
  // Setup application-created merchant jobs; tail progress below uses only deliveryTick.
  if(p.pregranted){const j=(await admin.query("SELECT id FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0];await store.entitlement(await store.claim(j.id));}
  await restrict(p,i);prefix.push(p);
 }
 const tail=await paid(),before=await jobs(),ids=prefix.map(p=>p.order);
 assert.equal(before.filter(j=>ids.includes(j.order_id)&&j.state!=='done').length,42);
 await admin.query('UPDATE merchant_control SET fulfillment_paused=true');assert.equal((await store.pending()).length,0);await tickProcess();assert.deepEqual(await jobs(),before);
 await admin.query('UPDATE merchant_control SET fulfillment_paused=false');
 const quarantine=randomUUID();await admin.query("INSERT INTO payment_incidents(id,kind,evidence) VALUES($1,'reorg','{}')",[quarantine]);
 assert.equal((await store.pending()).length,0);await tickProcess();assert.deepEqual(await jobs(),before);
 await admin.query('UPDATE payment_incidents SET resolved_at=clock_timestamp() WHERE id=$1',[quarantine]);
 const selected=await store.pending();assert.equal(selected.length,1);assert.equal(before.find(j=>j.id===selected[0].id).order_id,tail.order);
 // Eligibility changes after candidate selection. Claim must deny without an attempt.
 class ChangedBeforeClaim extends DeliveryStore{async pending(){const rows=await super.pending();await admin.query("UPDATE orders SET fulfillment_state='blocked' WHERE id=$1",[tail.order]);return rows;}}
 await deliveryTick(new ChangedBeforeClaim(worker.pool,bindings),new Map([['reference',target]]));assert.deepEqual(await jobs(),before);
 await admin.query("UPDATE orders SET fulfillment_state='queued' WHERE id=$1",[tail.order]);
 await concurrentTicks();
 assert.deepEqual(await retrievePurchase(tail.directory),await readFile(base+'/assets/guide.json'));
 assert.equal((await admin.query('SELECT id FROM entitlements WHERE order_id=$1',[tail.order])).rowCount,1);
 assert.deepEqual((await jobs()).filter(j=>ids.includes(j.order_id)),before.filter(j=>ids.includes(j.order_id)));
 history.push({phase:'entitlement_tail',restricted_jobs:42,concurrent_ticks:2,entitlements:1,matching_private_bytes:true});
 // Current guards also apply after lease acquisition, before network authorization.
 class ChangedBeforeEffect extends DeliveryStore{async beginWebhook(...args){await admin.query("UPDATE orders SET fulfillment_state='blocked' WHERE id=$1",[tail.order]);return super.beginWebhook(...args);}}
 await deliveryTick(new ChangedBeforeEffect(worker.pool,bindings),new Map([['reference',target]]));
 assert.equal((await admin.query('SELECT * FROM merchant_adapter.orders')).rowCount,0);
 await admin.query("UPDATE orders SET fulfillment_state='available' WHERE id=$1",[tail.order]);
 const due=(await admin.query("SELECT available_at FROM outbox_jobs WHERE order_id=$1 AND effect_type='merchant_paid'",[tail.order])).rows[0].available_at;
 await new Promise(r=>setTimeout(r,Math.max(0,due.getTime()-Date.now())+20));
 await concurrentTicks();
 const receipt=(await admin.query('SELECT r.*,e.order_id,e.effect_id FROM merchant_receipts r JOIN merchant_events e USING(event_id) WHERE e.order_id=$1',[tail.order])).rows[0];assert.ok(receipt);
 const merchant=(await admin.query('SELECT * FROM merchant_adapter.orders WHERE dispatch_order_id=$1',[tail.order])).rows[0];assert.equal(merchant.receipt_id,receipt.receipt_id);assert.equal(merchant.effect_id,receipt.effect_id);
 assert.deepEqual((await jobs()).filter(j=>ids.includes(j.order_id)),before.filter(j=>ids.includes(j.order_id)));
 history.push({phase:'webhook_tail',restricted_prefix_jobs:42,matching_durable_receipt:true,merchant_effects:1,claim_and_effect_rechecks:true});
 // Restore only reversible fixture restrictions; never revive revoked work.
 for(const p of prefix.filter(p=>p.restriction!=='revoked')){
  if(p.restriction==='incident')await admin.query('UPDATE payment_incidents SET resolved_at=clock_timestamp() WHERE order_id=$1',[p.order]);
  else if(p.restriction==='order_review')await admin.query('UPDATE orders SET state=$2 WHERE id=$1',[p.order,p.pregranted?'fulfilled':'paid']);
  else await admin.query('UPDATE orders SET fulfillment_state=$2 WHERE id=$1',[p.order,p.pregranted?'available':'queued']);
 }
 const allowed=prefix.filter(p=>p.restriction!=='revoked'),dueJobs=allowed.length,newWebhookJobs=allowed.filter(p=>!p.pregranted).length,bound=Math.ceil((dueJobs+newWebhookJobs)/20)+1;
 // Finite allowance for a newly-created final partial webhook batch; no retry-until-pass loop.
 for(let i=0;i<bound;i++){assert.ok((await store.pending()).length<=20);await tickProcess();}
 const downloaded=new Set();
 for(const p of allowed){
  const rows=await admin.query(`SELECT e.id,r.receipt_id,m.receipt_id receiver_receipt FROM entitlements e JOIN merchant_events v ON v.order_id=e.order_id JOIN merchant_receipts r USING(event_id) JOIN merchant_adapter.orders m ON m.dispatch_order_id=e.order_id WHERE e.order_id=$1 AND e.state='available'`,[p.order]);assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].receipt_id,rows.rows[0].receiver_receipt);
  const kind=p.restriction+':'+p.pregranted;if(!downloaded.has(kind)){assert.deepEqual(await retrievePurchase(p.directory),await readFile(base+'/assets/guide.json'));downloaded.add(kind);}
 }
 const after=await jobs();for(const j of before){const now=after.find(n=>n.id===j.id);for(const k of ['id','order_id','attempt_id','effect_type','effect_key','payload_reference'])assert.equal(now[k],j[k]);}
 for(const p of prefix.filter(p=>p.restriction==='revoked')){assert.equal((await admin.query('SELECT * FROM merchant_adapter.orders WHERE dispatch_order_id=$1',[p.order])).rowCount,0);assert.deepEqual(after.filter(j=>j.order_id===p.order),before.filter(j=>j.order_id===p.order));await assert.rejects(retrievePurchase(p.directory));}
 assert.equal((await store.pending()).length,0);await tickProcess();assert.deepEqual(await jobs(),after);
 history.push({phase:'restriction_recovery',eligible_original_jobs:dueJobs,new_webhook_jobs:newWebhookJobs,bound_ticks:bound,observed_ticks:bound,original_identities_preserved:true,revoked_prohibited:true,all_allowed_entitlements_and_receipts_match:true,authenticated_matching_download_classes:downloaded.size,stale_done_jobs_ignored:true,worker_process_restart_each_tick:true});
});
