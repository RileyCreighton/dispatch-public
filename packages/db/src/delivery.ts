import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction, control, permitted, digest } from './commerce.js';
import { assetMetadata, type Asset } from '../../fulfillment/src/files.js';
import { canonical } from '../../payments/src/canonical.js';
import type { PaidEvent, OperationReceipt } from '../../fulfillment/src/webhook.js';
export type DeliveryLease = Readonly<{job:string;order:string;owner:string;fence:string;type:'entitlement'|'merchant_paid'}>;
// Caller owns control and order locks. Payment pause deliberately does not gate paid delivery.
async function eligible(c: PoolClient, order: string, ctl: { fulfillment_paused: boolean; quarantined: boolean }) {
  const row = (await c.query(`SELECT o.*,s.id settlement_id,s.attempt_id,s.tx_hash,s.authorization_log_index,s.transfer_log_index,
    s.observation_policy,s.recorded_at,a.quote_id,a.amount,a.state payment_state,p.asset_id,p.connector_key
    FROM dispatch.orders o JOIN dispatch.products p ON (p.product_id,p.version)=(o.product_id,o.product_version)
    LEFT JOIN dispatch.settlements s ON s.order_id=o.id AND s.disposition='credited'
    LEFT JOIN dispatch.payment_attempts a ON a.id=s.attempt_id WHERE o.id=$1`, [order])).rows[0];
  const incident = (await c.query(`SELECT EXISTS(SELECT 1 FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL) bad`, [order])).rows[0].bad;
  if (!row || ctl.fulfillment_paused || ctl.quarantined || incident || row.payment_state !== 'settled'
    || !['paid','fulfillment_pending','fulfilled'].includes(row.state) || ['blocked','revoked'].includes(row.fulfillment_state)) throw new Error('delivery_blocked');
  return row;
}
async function asset(c: PoolClient, id: string): Promise<Asset> {
  const r = (await c.query(`SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes
    FROM dispatch.asset_versions WHERE id=$1`, [id])).rows[0] as Asset | undefined;
  if (!r) throw new Error('asset_invalid'); assetMetadata(r); return r;
}
export async function deliveryProjection(c: PoolClient, order: string, ctl: {fulfillment_paused:boolean;quarantined:boolean}) {
  const o = (await c.query('SELECT fulfillment_state FROM dispatch.orders WHERE id=$1',[order])).rows[0];
  if (!o) throw new Error('unauthorized');
  if (o.fulfillment_state === 'revoked') return {state:'revoked'};
  if (ctl.fulfillment_paused || ctl.quarantined) return {state:'blocked'};
  const e = (await c.query('SELECT * FROM dispatch.entitlements WHERE order_id=$1',[order])).rows[0];
  if (!e) {
    const j=(await c.query("SELECT state FROM dispatch.outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[order])).rows[0];
    return {state:j?.state==='leased'?'processing':j?.state==='retry'?'retry_pending':j?.state==='dead_letter'?'blocked':o.fulfillment_state};
  }
  if (e.state !== 'available') return {state:e.state as string};
  try { await eligible(c,order,ctl); return {state:'available',download_path:`/v1/orders/${order}/download`,...assetMetadata(await asset(c,e.asset_id))}; }
  catch { return {state:'blocked'}; }
}
export async function handoffProjection(c:PoolClient,order:string) {
  const j=(await c.query(`SELECT state FROM dispatch.outbox_jobs WHERE order_id=$1 AND effect_type='merchant_paid'`,[order])).rows[0];
  if(!j)return {state:'not_configured'};
  const r=(await c.query(`SELECT r.receipt_id,r.merchant_order_id FROM dispatch.merchant_receipts r
    JOIN dispatch.merchant_events e ON e.event_id=r.event_id WHERE e.order_id=$1`,[order])).rows[0];
  return r?{state:'recorded',receipt_id:r.receipt_id as string,merchant_order_id:r.merchant_order_id as string}:
    {state:j.state==='leased'?'processing':j.state==='retry'?'retry_pending':j.state==='dead_letter'?'blocked':'queued'};
}
export class DeliveryStore {
  constructor(readonly pool: Pool, readonly configuredTargets: ReadonlyMap<string,string> = new Map()) {}
  async authorize(order:string,credential:string): Promise<Asset> {
    return transaction(this.pool,async c=>{
      const ctl=await control(c); const session=await permitted(c,order,credential);
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[order]);
      // Recheck after all waits: a session may expire while acquiring the order lock.
      const live=await c.query(`SELECT 1 FROM dispatch.buyer_sessions s JOIN dispatch.buyer_grants g ON g.session_id=s.id
        WHERE s.id=$1 AND g.order_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND g.confirmed_at IS NOT NULL`,[session.id,order]);
      if(!live.rowCount)throw new Error('unauthorized');
      const o=await eligible(c,order,ctl);
      const e=(await c.query(`SELECT * FROM dispatch.entitlements WHERE order_id=$1 AND state='available'`,[order])).rows[0];
      if(!e || e.settlement_id!==o.settlement_id || e.asset_id!==o.asset_id)throw new Error('delivery_blocked');
      return asset(c,e.asset_id);
    });
  }
  async claim(job:string):Promise<DeliveryLease|undefined> {
    return transaction(this.pool,async c=>{
      const ctl=await control(c), ref=(await c.query('SELECT order_id FROM dispatch.outbox_jobs WHERE id=$1',[job])).rows[0];
      if(!ref)throw new Error('missing_job');
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[ref.order_id]);
      await eligible(c,ref.order_id,ctl);
      const exhausted=await c.query(`UPDATE dispatch.outbox_jobs SET state='dead_letter',last_safe_error='attempt_limit'
        WHERE id=$1 AND effect_type IN ('entitlement','merchant_paid') AND attempts>0 AND attempts%8=0
        AND state='leased' AND lease_until<=clock_timestamp() RETURNING id`,[job]);
      if(exhausted.rowCount)return undefined;
      const owner=randomUUID(),j=(await c.query(`UPDATE dispatch.outbox_jobs SET state='leased',lease_owner=$2,
        lease_until=clock_timestamp()+interval '30 seconds',fence=fence+1,attempts=attempts+1
        WHERE id=$1 AND effect_type IN ('entitlement','merchant_paid') AND available_at<=clock_timestamp()
        AND (state IN ('queued','retry') OR (state='leased' AND lease_until<=clock_timestamp())) RETURNING *`,[job,owner])).rows[0];
      if(!j)throw new Error('lease_busy');
      return {job,order:j.order_id,owner,fence:j.fence,type:j.effect_type};
    });
  }
  private async locked(c:PoolClient,l:DeliveryLease) {
    const j=(await c.query(`SELECT *,lease_until>clock_timestamp() live FROM dispatch.outbox_jobs WHERE id=$1 FOR UPDATE`,[l.job])).rows[0];
    if(!j || j.order_id!==l.order || j.effect_type!==l.type || j.state!=='leased' || !j.live || j.lease_owner!==l.owner || j.fence!==l.fence)throw new Error('stale_delivery');
    return j;
  }
  private async fence(c:PoolClient,l:DeliveryLease,state?:'done') {
    const r=await c.query(`UPDATE dispatch.outbox_jobs SET state=COALESCE($4,state)
      WHERE id=$1 AND state='leased' AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp() RETURNING id`,[l.job,l.owner,l.fence,state??null]);
    if(r.rowCount!==1)throw new Error('stale_delivery');
  }
  async entitlement(l:DeliveryLease) {
    if(l.type!=='entitlement')throw new Error('invalid_effect');
    return transaction(this.pool,async c=>{
      const ctl=await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[l.order]);
      const o=await eligible(c,l.order,ctl),j=await this.locked(c,l);
      if(j.payload_reference!==o.settlement_id || j.attempt_id!==o.attempt_id)throw new Error('invalid_effect');
      await asset(c,o.asset_id);
      const existing=(await c.query('SELECT * FROM dispatch.entitlements WHERE order_id=$1',[l.order])).rows[0];
      if(existing && (existing.state!=='available' || existing.asset_id!==o.asset_id || existing.settlement_id!==o.settlement_id))throw new Error('delivery_blocked');
      await c.query(`INSERT INTO dispatch.entitlements(id,order_id,product_id,product_version,settlement_id,asset_id,state)
        VALUES($1,$2,$3,$4,$5,$6,'available') ON CONFLICT(order_id,product_id,product_version) DO NOTHING`,[randomUUID(),l.order,o.product_id,o.product_version,o.settlement_id,o.asset_id]);
      if(o.connector_key) {
        if(!this.configuredTargets.has(o.connector_key))throw new Error('connector_unavailable');
        const eventId=randomUUID(),effect='merchant_paid:'+l.order,job=randomUUID();
        const event:PaidEvent={type:'dispatch.order.paid.v1',event_id:eventId,effect_id:effect,occurred_at:o.recorded_at.toISOString(),merchant_id:'single',
          merchant_order_id:'dispatch-'+l.order,dispatch_order_id:l.order,quote_id:o.quote_id,product_version:o.product_version,
          amount_atomic:o.amount,asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',network:'eip155:8453',payment_reference:{transaction_hash:o.tx_hash,
            authorization_log_index:o.authorization_log_index,transfer_log_index:o.transfer_log_index,observation_policy:o.observation_policy}};
        const inserted=await c.query(`INSERT INTO dispatch.outbox_jobs(id,order_id,attempt_id,effect_type,effect_version,effect_key,payload_reference,state)
          VALUES($1,$2,$3,'merchant_paid',1,$4,$5,'queued') ON CONFLICT(effect_key) DO NOTHING RETURNING id`,[job,l.order,o.attempt_id,effect,eventId]);
        if(inserted.rowCount) {const raw=canonical(event);await c.query(`INSERT INTO dispatch.merchant_events(event_id,job_id,order_id,effect_id,target_id,target_binding,raw_body,body_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[eventId,job,l.order,effect,o.connector_key,this.configuredTargets.get(o.connector_key),raw,digest(raw)]);}
      }
      await c.query("UPDATE dispatch.orders SET state='fulfilled',fulfillment_state='available',version=version+1 WHERE id=$1",[l.order]);
      await this.fence(c,l,'done');
    });
  }
  async beginWebhook(l:DeliveryLease,keyId:string,targetBinding:string) {
    if(l.type!=='merchant_paid')throw new Error('invalid_effect');
    return transaction(this.pool,async c=>{
      const ctl=await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[l.order]);
      await eligible(c,l.order,ctl);const j=await this.locked(c,l);
      if(!(await c.query("SELECT id FROM dispatch.entitlements WHERE order_id=$1 AND state='available'",[l.order])).rowCount)throw new Error('delivery_blocked');
      const e=(await c.query('SELECT * FROM dispatch.merchant_events WHERE job_id=$1',[l.job])).rows[0];
      if(!e || e.event_id!==j.payload_reference || this.configuredTargets.get(e.target_id)!==e.target_binding || targetBinding!==e.target_binding || digest(e.raw_body)!==e.body_hash)throw new Error('invalid_effect');
      const id=randomUUID(),signed=(await c.query("SELECT floor(extract(epoch FROM clock_timestamp()))::text stamp")).rows[0].stamp as string;
      await c.query(`INSERT INTO dispatch.webhook_attempts(id,job_id,event_id,attempt_number,target_id,body_hash,signing_key_id,signed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8))`,[id,l.job,e.event_id,j.attempts,e.target_id,e.body_hash,keyId,signed]);
      await this.fence(c,l);
      return {id,event:e.event_id as string,target:e.target_id as string,body:Buffer.from(e.raw_body as string),timestamp:signed,attempt:j.attempts as number};
    });
  }
  async finishWebhook(l:DeliveryLease,attempt:string,receipt:OperationReceipt|undefined,status:number|null,retryAfterSeconds=0) {
    return transaction(this.pool,async c=>{
      await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[l.order]);
      await this.locked(c,l);
      const e=(await c.query('SELECT * FROM dispatch.merchant_events WHERE job_id=$1',[l.job])).rows[0];
      const a=(await c.query('SELECT * FROM dispatch.webhook_attempts WHERE id=$1 AND job_id=$2',[attempt,l.job])).rows[0];
      if(!a)throw new Error('invalid_attempt');
      const expected=JSON.parse(e.raw_body) as PaidEvent;
      const committed=receipt?.state==='committed' && receipt.operation_id===e.event_id && receipt.effect_id===e.effect_id
        && receipt.merchant_order_id===expected.merchant_order_id && !!receipt.receipt_id;
      await c.query(`INSERT INTO dispatch.webhook_results(attempt_id,http_status,safe_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[attempt,status,committed?'committed':'unknown']);
      if(committed) {
        await c.query(`INSERT INTO dispatch.merchant_receipts(event_id,receipt_id,merchant_order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[e.event_id,receipt.receipt_id,receipt.merchant_order_id]);
        await c.query('UPDATE dispatch.orders SET version=version+1 WHERE id=$1',[l.order]);
        await this.fence(c,l,'done');
      } else await this.retry(c,l,'receiver_unknown',retryAfterSeconds);
    });
  }
  private async retry(c:PoolClient,l:DeliveryLease,reason:string,retryAfterSeconds=0) {
    if(!Number.isSafeInteger(retryAfterSeconds)||retryAfterSeconds<0||retryAfterSeconds>3600)throw new Error('invalid_retry_delay');
    const result=await c.query(`UPDATE dispatch.outbox_jobs SET state=CASE WHEN attempts%8=0 THEN 'dead_letter' ELSE 'retry' END,
      available_at=clock_timestamp()+make_interval(secs=>GREATEST($5,LEAST(60,power(2,(attempts-1)%8)*(0.8+random()*0.4)))),last_safe_error=$2 WHERE id=$1 AND state='leased' AND lease_owner=$3 AND fence=$4 AND lease_until>clock_timestamp() RETURNING id`,[l.job,reason,l.owner,l.fence,retryAfterSeconds]);
    if(result.rowCount!==1)throw new Error('stale_delivery');
  }
  async defer(l:DeliveryLease) {
    return transaction(this.pool,async c=>{await control(c);await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE',[l.order]);
      await this.locked(c,l);await this.retry(c,l,'delivery_unavailable');});
  }
  // Candidate filtering is advisory only: claim/effect paths still lock and recheck.
  // Restricted rows retain identity, attempts and due time, and re-enter on the next
  // selection after clearance. At most 20 candidates are worked per tick.
  async pending() {return (await this.pool.query(`SELECT j.id FROM dispatch.outbox_jobs j
    JOIN dispatch.orders o ON o.id=j.order_id
    JOIN dispatch.settlements s ON s.order_id=o.id AND s.disposition='credited'
    JOIN dispatch.payment_attempts a ON a.id=s.attempt_id
    CROSS JOIN dispatch.merchant_control ctl
    WHERE j.effect_type IN ('entitlement','merchant_paid')
    AND j.available_at<=clock_timestamp() AND (j.state IN ('queued','retry') OR (j.state='leased' AND j.lease_until<=clock_timestamp()))
    AND NOT ctl.fulfillment_paused AND a.state='settled'
    AND NOT EXISTS(SELECT 1 FROM dispatch.payment_incidents q WHERE q.kind='reorg' AND q.resolved_at IS NULL)
    AND o.state IN ('paid','fulfillment_pending','fulfilled') AND o.fulfillment_state NOT IN ('blocked','revoked')
    AND NOT EXISTS(SELECT 1 FROM dispatch.payment_incidents i WHERE i.order_id=o.id AND i.resolved_at IS NULL)
    ORDER BY j.available_at,j.id LIMIT 20`)).rows as {id:string}[];}
}
