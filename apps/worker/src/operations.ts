import type { Pool } from 'pg';
import type { RefundRpc } from '../../../packages/payments/src/refund.js';
import { DeliveryStore } from '../../../packages/db/src/delivery.js';
import type { WebhookTransport } from '../../../packages/fulfillment/src/transport.js';
import { deliveryTick } from './delivery.js';
import { refundTick } from './refunds.js';
export async function operationsTick(pool:Pool,chain:RefundRpc,targets:ReadonlyMap<string,WebhookTransport>) {
  await deliveryTick(new DeliveryStore(pool,new Map([...targets].map(([id,target])=>[id,target.binding]))),targets);
  await refundTick(pool,chain);
  await pool.query(`INSERT INTO dispatch.runtime_health(service,checked_at) VALUES('operations_worker',clock_timestamp())
    ON CONFLICT(service) DO UPDATE SET checked_at=EXCLUDED.checked_at`);
}
