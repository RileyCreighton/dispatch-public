import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setup,teardown,admin,api,worker,policy,newSigner,settle,support} from '../fulfillment/fixtures.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {digest} from '../../dist/packages/db/src/commerce.js';
test.before(setup);test.after(teardown);
test('R5-Q twenty blocked orders must not permanently starve a later eligible paid entitlement',async()=>{
 const store=new DeliveryStore(worker.pool,new Map([['reference',digest('https://127.0.0.1:18444/dispatch/v1/events')]]));const orders=[];
 for(let i=0;i<21;i++){
  await support();await admin.query('TRUNCATE abuse_counters');const directory=process.env.DISPATCH_DB_HOST+'/queue-'+randomUUID(),j=await createPurchase(policy(),directory),saved=await j.read();
  await authorizePurchase(directory,policy(),await newSigner());await settle(saved.order);orders.push({...saved,directory});
  if(i<20)await admin.query("UPDATE orders SET fulfillment_state='blocked' WHERE id=$1",[saved.order]);
 }
 const eligible=orders[20],history=[];
 for(let i=0;i<3;i++){const pending=await store.pending();await deliveryTick(store,new Map());history.push({selected:pending.map(r=>r.id),eligible_entitlements:Number((await admin.query('SELECT count(*) n FROM entitlements WHERE order_id=$1',[eligible.order])).rows[0].n)});}
 const job=(await admin.query("SELECT id,state,attempts FROM outbox_jobs WHERE effect_type='entitlement' AND order_id=$1",[eligible.order])).rows[0];
 // Positive control: the same worker store authorizes and grants this exact order when addressed directly.
 if(job.state!=='done')await store.entitlement(await store.claim(job.id));assert.ok((await retrievePurchase(eligible.directory)).length);
 const report={blocked_orders:20,eligible_order:eligible.order,worker_ticks:history,eligible_job_before_positive_control:job,positive_control:'same purchased order authorizes, creates one entitlement and retrieves real private bytes',expected:'bounded worker scheduling reaches eligible paid work despite blocked older orders'};
 await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/queue-starvation.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 assert.ok(history.some(r=>r.eligible_entitlements===1),'eligible entitlement never selected; the same twenty blocked jobs occupy every pending batch');
});
