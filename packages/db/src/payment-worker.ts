import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import type { Hex } from 'viem';
import { unseal } from '../../security/src/index.js';
import { exactSettlement, type Binding, type ChainFixture } from '../../payments/src/settlement.js';
import type { Observation } from '../../payments/src/facilitator.js';
import { canonical } from '../../payments/src/canonical.js';
import { transaction, control, rollover, digest } from './commerce.js';
export type Lease = Readonly<{ attempt: string; order: string; job: string; owner: string; fence: string }>;
export type Call = Lease & Readonly<{ id: string; operation: 'verify' | 'settle' }>;
export class PaymentWorker {
  readonly #key: Buffer;
  constructor(readonly pool: Pool, encryptionKey: Buffer) { this.#key = Buffer.from(encryptionKey); }
  async envelope(id: string): Promise<{payment: PaymentPayload; requirements: PaymentRequirements}> {
    const a = (await this.pool.query('SELECT * FROM dispatch.payment_attempts WHERE id=$1', [id])).rows[0];
    if (!a) throw new Error('missing_attempt');
    const plain = unseal({ ciphertext: a.authorization_ciphertext, keyId: a.authz_key_id, iv: a.authz_iv, tag: a.authz_tag }, this.#key, id + ':' + a.typed_digest).toString();
    if (digest(plain) !== a.request_fingerprint) throw new Error('envelope_corrupt');
    const parsed = JSON.parse(plain) as { operation: string; order: string; quote: string; quoteHash: string; payment: PaymentPayload; requirements: PaymentRequirements };
    if (parsed.operation !== 'payCheckout' || parsed.order !== a.order_id || parsed.quote !== a.quote_id
      || canonical(parsed.requirements) !== canonical(a.requirements)) throw new Error('envelope_corrupt');
    return { payment: parsed.payment, requirements: parsed.requirements };
  }
  async binding(id: string): Promise<Binding> {
    const a = (await this.pool.query('SELECT * FROM dispatch.payment_attempts WHERE id=$1', [id])).rows[0];
    if (!a) throw new Error('missing_attempt');
    return { token: a.token, from: a.authorizer, to: a.payee, value: a.amount, nonce: a.nonce, digest: a.typed_digest,
      validAfter: a.valid_after, validBefore: a.valid_before, domainName: a.requirements.extra.name,
      domainVersion: a.requirements.extra.version, preacceptBlock: BigInt(a.preaccept_block), preacceptHash: a.preaccept_hash,
      nonceState: 'unused', preacceptObservedAt: a.preaccept_observed_at.getTime() };
  }
  async claim(id: string, operation: 'verify' | 'settle'): Promise<Call> {
    if (!['verify', 'settle'].includes(operation)) throw new Error('operation_disabled');
    return transaction(this.pool, async c => {
      const ctl = await control(c); if (ctl.payment_paused || ctl.quarantined) throw new Error('payments_paused');
      const reference = (await c.query('SELECT order_id FROM dispatch.payment_attempts WHERE id=$1', [id])).rows[0];
      if (!reference) throw new Error('missing_attempt');
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [reference.order_id]);
      await rollover(c, ctl.max_day_gross, ctl.today);
      const a = (await c.query('SELECT * FROM dispatch.payment_attempts WHERE id=$1 FOR UPDATE', [id])).rows[0];
      const j = (await c.query(`SELECT *,lease_until>clock_timestamp() live FROM dispatch.outbox_jobs
        WHERE attempt_id=$1 AND effect_type='submit' FOR UPDATE`, [id])).rows[0];
      if (!j || !['ready_to_submit', 'submitting'].includes(a.state)) throw new Error('not_dispatchable');
      const calls = (await c.query(`SELECT i.*,o.verified FROM dispatch.call_intents i LEFT JOIN dispatch.call_outcomes o ON o.call_id=i.id WHERE i.attempt_id=$1`, [id])).rows;
      if (calls.some(x => x.operation === operation)) throw new Error('already_claimed_reconcile');
      if (operation === 'verify') {
        if (calls.length || a.state !== 'ready_to_submit' || !['queued', 'retry'].includes(j.state)) throw new Error('not_dispatchable');
      } else {
        const v = calls.find(x => x.operation === 'verify');
        if (!v?.verified || j.state !== 'leased' || !j.live || v.job_id !== j.id || v.lease_owner !== j.lease_owner || v.fence !== j.fence)
          throw new Error('stale_or_unverified');
      }
      const owner = randomUUID();
      const row = (await c.query(`UPDATE dispatch.outbox_jobs SET state='leased',lease_owner=$2,lease_until=clock_timestamp()+interval '1 minute',
        fence=fence+1,attempts=attempts+1 WHERE id=$1 RETURNING fence`, [j.id, owner])).rows[0];
      await c.query(`UPDATE dispatch.payment_attempts SET state='submitting',version=version+1,
        submit_start_block=COALESCE(submit_start_block,preaccept_block),submit_started_at=COALESCE(submit_started_at,clock_timestamp()) WHERE id=$1`, [id]);
      const call: Call = Object.freeze({ id: randomUUID(), attempt: id, order: a.order_id, job: j.id, owner, fence: row.fence, operation });
      await c.query(`INSERT INTO dispatch.call_intents(id,attempt_id,order_id,operation,job_id,lease_owner,fence)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [call.id, id, a.order_id, operation, j.id, owner, call.fence]);
      return call;
    });
  }
  async save(call: Call, observation: Observation): Promise<boolean> {
    call = structuredClone(call); observation = structuredClone(observation);
    return transaction(this.pool, async c => {
      await control(c);
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [call.order]);
      await c.query('SELECT id FROM dispatch.payment_attempts WHERE id=$1 FOR UPDATE', [call.attempt]);
      const j = (await c.query('SELECT *,lease_until>clock_timestamp() live FROM dispatch.outbox_jobs WHERE id=$1 FOR UPDATE', [call.job])).rows[0];
      const i = (await c.query('SELECT * FROM dispatch.call_intents WHERE id=$1', [call.id])).rows[0];
      if (!i || i.attempt_id !== call.attempt || i.order_id !== call.order || i.operation !== call.operation || i.job_id !== call.job
        || i.lease_owner !== call.owner || i.fence !== call.fence || observation.operation !== call.operation) throw new Error('invalid_claim');
      const verified = call.operation === 'verify' && observation.kind === 'verified' && observation.status !== null && observation.status >= 200 && observation.status < 300;
      const code = ['pending', 'hint_success'].includes(observation.kind) ? observation.kind : 'unknown';
      const hint = observation.transaction && /^0x[0-9a-f]{64}$/.test(observation.transaction) ? observation.transaction : null;
      await c.query(`INSERT INTO dispatch.call_outcomes(call_id,safe_code,transaction_hash,verified) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [call.id, code, hint, verified]);
      if (call.operation === 'settle') await c.query(`INSERT INTO dispatch.submission_observations(id,attempt_id,call_number,provider_code,transaction_hash,outcome)
        VALUES($1,$2,1,$3,$4,$3) ON CONFLICT(attempt_id,call_number) DO NOTHING`, [randomUUID(), call.attempt, code, hint]);
      const current = j?.state === 'leased' && j.live && j.lease_owner === call.owner && j.fence === call.fence;
      if (!current) return false;
      // A second save uses the first durable outcome, never a changed caller result.
      const first = (await c.query('SELECT verified FROM dispatch.call_outcomes WHERE call_id=$1', [call.id])).rows[0];
      if (call.operation === 'verify' && first.verified) return true;
      await c.query(`UPDATE dispatch.payment_attempts SET state='pending',version=version+1 WHERE id=$1 AND state='submitting'`, [call.attempt]);
      await c.query("UPDATE dispatch.outbox_jobs SET state='done' WHERE id=$1", [call.job]);
      await this.enqueueReconcile(c, call.attempt, call.order); return true;
    });
  }
  private async enqueueReconcile(c: import('pg').PoolClient, attempt: string, order: string) {
    await c.query(`INSERT INTO dispatch.outbox_jobs(id,order_id,attempt_id,effect_type,effect_version,effect_key,payload_reference,state)
      VALUES($1,$2,$3,'reconcile',1,$4,$3,'queued') ON CONFLICT(effect_key) DO NOTHING`, [randomUUID(), order, attempt, 'reconcile:' + attempt]);
  }
  async expireUnbound(): Promise<number> {
    return transaction(this.pool, async c => {
      await control(c);
      const rows = await c.query(`UPDATE dispatch.orders o SET state='expired',version=version+1,updated_at=clock_timestamp()
        WHERE o.id IN (SELECT x.id FROM dispatch.orders x WHERE x.state='quoted'
        AND NOT EXISTS(SELECT 1 FROM dispatch.payment_attempts a WHERE a.order_id=x.id)
        AND NOT EXISTS(SELECT 1 FROM dispatch.quotes q WHERE q.order_id=x.id AND q.expires_at>clock_timestamp())
        ORDER BY x.id FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING o.id`);
      return rows.rowCount ?? 0;
    });
  }
  async recover(): Promise<number> {
    return transaction(this.pool, async c => {
      const ctl = await control(c); await rollover(c, ctl.max_day_gross, ctl.today);
      const rows = (await c.query(`SELECT a.id,a.order_id FROM dispatch.payment_attempts a JOIN dispatch.outbox_jobs j
        ON j.attempt_id=a.id AND j.effect_type='submit' WHERE a.state IN ('submitting','pending','review_required')
        AND (j.state='done' OR j.lease_until<=clock_timestamp())
        AND (a.state='submitting' OR NOT EXISTS (
          SELECT 1 FROM dispatch.outbox_jobs r WHERE r.effect_key='reconcile:' || a.id::text
          AND r.state IN ('queued','retry','leased')))
        ORDER BY a.order_id LIMIT 100`)).rows;
      for (const a of rows) {
        await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [a.order_id]);
        await c.query('SELECT id FROM dispatch.payment_attempts WHERE id=$1 FOR UPDATE', [a.id]);
        await c.query("UPDATE dispatch.payment_attempts SET state='pending',version=version+1 WHERE id=$1 AND state='submitting'", [a.id]);
        await this.enqueueReconcile(c, a.id, a.order_id);
        // Terminal jobs do not cover an unresolved attempt. Reuse the durable effect,
        // retaining its failure/attempt history and invalidating any old lease.
        await c.query(`UPDATE dispatch.outbox_jobs SET state='retry',available_at=clock_timestamp(),
          lease_owner=NULL,lease_until=NULL,fence=fence+1 WHERE effect_key=$1 AND state IN ('done','dead_letter')`, ['reconcile:' + a.id]);
      }
      return rows.length;
    });
  }
  async claimReconcile(id: string): Promise<Lease> {
    return transaction(this.pool, async c => {
      await control(c);
      const a = (await c.query('SELECT * FROM dispatch.payment_attempts WHERE id=$1', [id])).rows[0];
      if (!a?.submit_started_at) throw new Error('not_reconcilable');
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [a.order_id]);
      await c.query('SELECT id FROM dispatch.payment_attempts WHERE id=$1 FOR UPDATE', [id]);
      const owner = randomUUID();
      const j = (await c.query(`UPDATE dispatch.outbox_jobs SET state='leased',lease_owner=$2,fence=fence+1,
        lease_until=clock_timestamp()+interval '1 minute',attempts=attempts+1 WHERE id=(SELECT id FROM dispatch.outbox_jobs
        WHERE attempt_id=$1 AND effect_type='reconcile' AND available_at<=clock_timestamp()
        AND (state IN ('queued','retry') OR (state='leased' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id,fence`, [id, owner])).rows[0];
      if (!j) throw new Error('lease_busy');
      return Object.freeze({ attempt: id, order: a.order_id, job: j.id, owner, fence: j.fence });
    });
  }
  async hint(id: string): Promise<Hex | null> {
    return (await this.pool.query(`SELECT transaction_hash FROM dispatch.call_outcomes o JOIN dispatch.call_intents i ON i.id=o.call_id
      WHERE i.attempt_id=$1 AND transaction_hash IS NOT NULL ORDER BY observed_at DESC LIMIT 1`, [id])).rows[0]?.transaction_hash ?? null;
  }
  async defer(lease: Lease) {
    await this.pool.query(`UPDATE dispatch.outbox_jobs SET state='retry',available_at=clock_timestamp()+interval '30 seconds'
      WHERE id=$1 AND state='leased' AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp()`, [lease.job, lease.owner, lease.fence]);
  }
  async apply(lease: Lease, evidence: ChainFixture): Promise<string> {
    lease = structuredClone(lease); evidence = structuredClone(evidence);
    const b = await this.binding(lease.attempt);
    let proof: ReturnType<typeof exactSettlement>;
    const evidenceDigest = digest(canonical(JSON.parse(JSON.stringify(evidence, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v))));
    try { proof = exactSettlement(b, evidence); }
    catch {
      await this.pool.query(`INSERT INTO dispatch.chain_observations(id,attempt_id,evidence_digest,transaction_hash,result)
        VALUES($1,$2,$3,$4,'conflict')`, [randomUUID(), lease.attempt, evidenceDigest, evidence.transactionHash]);
      throw new Error('settlement_review_required');
    }
    await this.pool.query(`INSERT INTO dispatch.chain_observations(id,attempt_id,evidence_digest,transaction_hash,result)
      VALUES($1,$2,$3,$4,'exact')`, [randomUUID(), lease.attempt, evidenceDigest, evidence.transactionHash]);
    return transaction(this.pool, async c => {
      const ctl = await control(c);
      const o = (await c.query('SELECT * FROM dispatch.orders WHERE id=$1 FOR UPDATE', [lease.order])).rows[0];
      if (!o || (await c.query('SELECT finality_policy FROM dispatch.merchant_config_versions WHERE id=$1', [o.config_id])).rows[0]?.finality_policy !== 'safe') throw new Error('unsupported_finality_policy');
      const fundsDay = (await c.query("SELECT (to_timestamp($1) AT TIME ZONE 'UTC')::date::text AS funds_day", [evidence.blockTime.toString()])).rows[0].funds_day;
      const days = [...new Set([ctl.today as string, fundsDay as string])].sort();
      await c.query(`INSERT INTO dispatch.spend_budgets(merchant_id,utc_day,cap)
        SELECT 'single',budget_day,$2 FROM unnest($1::date[]) AS days(budget_day) ORDER BY budget_day ON CONFLICT DO NOTHING`, [days, ctl.max_day_gross]);
      await c.query("SELECT utc_day FROM dispatch.spend_budgets WHERE merchant_id='single' AND utc_day=ANY($1::date[]) ORDER BY utc_day FOR UPDATE", [days]);
      await rollover(c, ctl.max_day_gross, ctl.today);
      const a = (await c.query('SELECT * FROM dispatch.payment_attempts WHERE id=$1 FOR UPDATE', [lease.attempt])).rows[0];
      const j = (await c.query('SELECT *,lease_until>clock_timestamp() live FROM dispatch.outbox_jobs WHERE id=$1 FOR UPDATE', [lease.job])).rows[0];
      if (!a || a.order_id !== lease.order || j?.attempt_id !== a.id || j.effect_type !== 'reconcile' || j.state !== 'leased'
        || j.lease_owner !== lease.owner || j.fence !== lease.fence || !j.live || !a.submit_started_at) throw new Error('stale_settlement');
      const duplicate = (await c.query('SELECT id,attempt_id FROM dispatch.settlements WHERE chain_id=8453 AND tx_hash=$1 AND transfer_log_index=$2', [proof.transaction, proof.transferIndex])).rows[0];
      if (duplicate) {
        if (duplicate.attempt_id !== a.id) throw new Error('settlement_conflict');
        return duplicate.id as string;
      }
      const credited = (await c.query("SELECT id FROM dispatch.settlements WHERE order_id=$1 AND disposition='credited'", [a.order_id])).rows[0];
      // Projections may have changed since the original observation. Retained ledger
      // dispositions and unresolved quarantine remain authoritative under these locks.
      const history = (await c.query(`SELECT
        EXISTS(SELECT 1 FROM dispatch.settlements WHERE order_id=$1 AND disposition='late') AS late,
        EXISTS(SELECT 1 FROM dispatch.settlements WHERE order_id=$1 AND disposition='review') AS review,
        EXISTS(SELECT 1 FROM dispatch.payment_incidents WHERE order_id=$1 AND resolved_at IS NULL) AS incident`, [a.order_id])).rows[0];
      const blocked = ctl.quarantined || history.review || history.incident || o.state === 'review_required'
        || ['blocked', 'revoked'].includes(o.fulfillment_state) || a.state === 'review_required';
      const disposition = history.late || ['cancelled', 'expired'].includes(o.state) ? 'late'
        : blocked ? 'review' : credited ? 'surplus' : 'credited';
      const id = randomUUID();
      await c.query(`INSERT INTO dispatch.settlements(id,attempt_id,order_id,chain_id,tx_hash,call_path,authorization_log_index,
        transfer_log_index,block_number,block_hash,chain_time,amount,observed_head,observed_head_hash,observation_policy,verifier_version,evidence_digest,disposition)
        VALUES($1,$2,$3,8453,$4,'direct',$5,$6,$7,$8,to_timestamp($9),$10,$11,$12,'safe','build003-direct-1',$13,$14)`,
      [id, a.id, a.order_id, proof.transaction, proof.authorizerIndex, proof.transferIndex, proof.block, proof.blockHash,
        evidence.blockTime.toString(), a.amount, evidence.safeHead.toString(), evidence.safeHash, proof.evidenceDigest, disposition]);
      if (disposition === 'credited') {
        await c.query("UPDATE dispatch.payment_attempts SET state='settled',version=version+1 WHERE id=$1", [a.id]);
        await c.query("UPDATE dispatch.orders SET state='paid',fulfillment_state='queued',version=version+1 WHERE id=$1", [a.order_id]);
        await c.query(`INSERT INTO dispatch.outbox_jobs(id,order_id,attempt_id,effect_type,effect_version,effect_key,payload_reference,state)
          VALUES($1,$2,$3,'entitlement',1,$4,$5,'queued') ON CONFLICT(effect_key) DO NOTHING`, [randomUUID(), a.order_id, a.id, 'entitlement:' + a.order_id, id]);
      } else {
        // Extra actual funds count even over cap; no new entitlement. Never discard a second exact transfer.
        await c.query(`UPDATE dispatch.spend_budgets SET gross_reserved=gross_reserved+$1 WHERE merchant_id='single' AND utc_day=$2`, [a.amount, fundsDay]);
        await c.query(`INSERT INTO dispatch.payment_incidents(id,order_id,attempt_id,settlement_id,kind,evidence)
          VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), a.order_id, a.id, id, disposition, { evidence_digest: proof.evidenceDigest }]);
        if (disposition === 'late' || disposition === 'review') {
          await c.query('UPDATE dispatch.payment_attempts SET state=$2,version=version+1 WHERE id=$1',
            [a.id, disposition === 'late' ? 'settled' : 'review_required']);
          await c.query("UPDATE dispatch.orders SET state='review_required',fulfillment_state='blocked',version=version+1 WHERE id=$1", [a.order_id]);
        }
      }
      const done = await c.query(`UPDATE dispatch.outbox_jobs SET state='retry',available_at=clock_timestamp()+interval '30 seconds'
        WHERE id=$1 AND lease_owner=$2 AND fence=$3 AND lease_until>clock_timestamp()`, [lease.job, lease.owner, lease.fence]);
      if (done.rowCount !== 1) throw new Error('stale_settlement');
      return id;
    });
  }
  async quarantine(settlement: string, observedHash: Hex, anchor = false) {
    return transaction(this.pool, async c => {
      await control(c);
      const s = (await c.query('SELECT * FROM dispatch.settlements WHERE id=$1', [settlement])).rows[0];
      if (!s) return;
      const expected = anchor ? (await c.query('SELECT preaccept_hash FROM dispatch.payment_attempts WHERE id=$1', [s.attempt_id])).rows[0].preaccept_hash : s.block_hash;
      if (expected === observedHash) return;
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [s.order_id]);
      await c.query(`INSERT INTO dispatch.payment_incidents(id,order_id,attempt_id,settlement_id,kind,evidence)
        VALUES($1,$2,$3,$4,'reorg',$5) ON CONFLICT DO NOTHING`, [randomUUID(), s.order_id, s.attempt_id, s.id, { prior_hash: expected, observed_hash: observedHash, preaccept_anchor: anchor }]);
      await c.query("UPDATE dispatch.orders SET state='review_required',fulfillment_state='blocked',version=version+1 WHERE id=$1", [s.order_id]);
      await c.query("UPDATE dispatch.entitlements SET state='blocked' WHERE order_id=$1", [s.order_id]);
    });
  }
}
