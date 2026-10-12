import type { PaymentWorker } from '../../../packages/db/src/payment-worker.js';
import type { ChainReader } from '../../../packages/payments/src/application.js';
import type { FacilitatorTransport } from '../../../packages/payments/src/facilitator.js';
export async function submitInitial(store: PaymentWorker, attempt: string, transport: FacilitatorTransport) {
  const envelope = await store.envelope(attempt);
  const verify = await store.claim(attempt, 'verify');
  const result = await transport.observe('verify', envelope.payment, envelope.requirements);
  if (!await store.save(verify, result.observation) || result.observation.kind !== 'verified'
    || result.observation.status === null || result.observation.status < 200 || result.observation.status >= 300) return;
  const settle = await store.claim(attempt, 'settle');
  const outcome = await transport.observe('settle', envelope.payment, envelope.requirements);
  await store.save(settle, outcome.observation);
}
export async function reconcileKnown(store: PaymentWorker, attempt: string, chain: ChainReader) {
  const lease = await store.claimReconcile(attempt);
  try {
    const binding = await store.binding(attempt), hint = await store.hint(attempt);
    const settled = (await store.pool.query('SELECT id,block_number FROM dispatch.settlements WHERE attempt_id=$1', [attempt])).rows;
    for (const s of settled) {
      await store.quarantine(s.id, await chain.canonicalHash(BigInt(s.block_number)));
      await store.quarantine(s.id, await chain.canonicalHash(binding.preacceptBlock), true);
    }
    if (!hint) return; // AM-B1-001: no invented operation-status API, resubmit or automatic release.
    const evidence = await chain.evidence(binding, hint);
    if (evidence) await store.apply(lease, evidence);
  } finally { await store.defer(lease); }
}
// A bounded tick uses durable availability ordering; claims, not polling selections, grant authority.
export async function paymentTick(store: PaymentWorker, chain: ChainReader, transport: FacilitatorTransport) {
  await store.expireUnbound(); await store.recover();
  const ready = (await store.pool.query(`SELECT a.id FROM dispatch.payment_attempts a JOIN dispatch.outbox_jobs j ON j.attempt_id=a.id
    WHERE a.state='ready_to_submit' AND j.effect_type='submit' AND j.state='queued' AND j.available_at<=clock_timestamp()
    ORDER BY j.available_at,j.id LIMIT 20`)).rows;
  for (const a of ready) {
    try { await submitInitial(store, a.id, transport); } catch { /* Durable claim/history governs recovery. Never resend here. */ }
  }
  const queued = (await store.pool.query(`SELECT attempt_id FROM dispatch.outbox_jobs WHERE effect_type='reconcile'
    AND available_at<=clock_timestamp() AND (state IN ('queued','retry') OR (state='leased' AND lease_until<=clock_timestamp()))
    ORDER BY available_at,id LIMIT 20`)).rows;
  for (const j of queued) {
    try { await reconcileKnown(store, j.attempt_id, chain); } catch { /* Preserve unknown and retry read-only observation later. */ }
  }
}
