import type { Pool } from 'pg';
import { reconcileRefund } from '../../../packages/db/src/refunds.js';
import type { RefundRpc } from '../../../packages/payments/src/refund.js';
// Read-only chain observations; never invokes a signing or send RPC.
export async function refundTick(pool:Pool,chain:RefundRpc) {
  const rows=(await pool.query(`SELECT id FROM dispatch.refunds WHERE wallet_started_at IS NOT NULL
    ORDER BY COALESCE((SELECT max(recorded_at) FROM dispatch.refund_observations o WHERE o.refund_id=refunds.id),created_at),id LIMIT 20`)).rows;
  for(const row of rows)await reconcileRefund(pool,row.id,chain);
}
