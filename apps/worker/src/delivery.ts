import { DeliveryStore } from '../../../packages/db/src/delivery.js';
import type { WebhookTransport } from '../../../packages/fulfillment/src/transport.js';
export async function deliveryTick(store:DeliveryStore,targets:ReadonlyMap<string,WebhookTransport>) {
 for(const job of await store.pending()) {
  let lease:Awaited<ReturnType<DeliveryStore['claim']>>|undefined;
  try {
   lease=await store.claim(job.id);if(!lease)continue;
   if(lease.type==='entitlement'){await store.entitlement(lease);continue;}
   const event=(await store.pool.query('SELECT target_id FROM dispatch.merchant_events WHERE job_id=$1',[lease.job])).rows[0];
   const target=targets.get(event?.target_id as string);if(!target)throw new Error('connector_unavailable');
   const attempt=await store.beginWebhook(lease,target.keyId,target.binding);
   let result:Awaited<ReturnType<WebhookTransport['send']>>|undefined;
   // Following restart/lost response, status may recover the same effect before another POST.
   if(attempt.attempt>1)try{const r=await target.status(attempt.event);if(r.status===200&&r.receipt?.state==='committed')result=r;}catch{/* unknown remains same effect */}
   if(!result)try{result=await target.send(attempt.body,attempt.timestamp);}catch{/* Persist unknown and retry the same identity. */}
   await store.finishWebhook(lease,attempt.id,result?.status===200?result.receipt:undefined,result?.status??null,result?.retryAfterSeconds??0);
  } catch {if(lease)try{await store.defer(lease);}catch{/* Lost lease cannot authorize a write. */}}
 }
}
