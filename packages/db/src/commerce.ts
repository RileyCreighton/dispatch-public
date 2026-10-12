import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PaymentRequirements } from '@x402/core/types';
import { canonical } from '../../payments/src/canonical.js';
import { authorization, freshObservation, challenge, required, type ChainReader } from '../../payments/src/application.js';
import { CapabilitySnapshot } from '../../payments/src/capabilities.js';
import { seal } from '../../security/src/index.js';
import { digitalTotal, uuid, key, object } from '../../domain/src/payment.js';
import { loadSupport } from './index.js';
import { BuyerAccess } from './buyer.js';
import { deliveryProjection, handoffProjection } from './delivery.js';
export const digest = (value: string) => '0x' + createHash('sha256').update(value).digest('hex');
export async function transaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await pool.connect();
    // Pool error handlers cover idle clients only. A checked-out client can be
    // terminated between statements (including by the server's idle timeout).
    let connectionError: Error | undefined;
    let discard = false;
    const failed = (error: Error) => { connectionError ??= error; };
    c.on('error', failed);
    try {
      // The control-lock protocol requires a fresh snapshot after a lock wait,
      // regardless of the pool/session's default transaction isolation.
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED'); const result = await fn(c);
      if (connectionError) throw connectionError;
      // If a control-locked financial command crossed UTC midnight, retry its SQL-only
      // work so carry-in precedes terminal state. No provider I/O lives in this callback.
      const day = (await c.query(`SELECT NULLIF(current_setting('dispatch.budget_day',true),'') used_day,
        (clock_timestamp() AT TIME ZONE 'UTC')::date::text today`)).rows[0];
      if (day.used_day && day.used_day !== day.today) throw Object.assign(new Error('utc_day_changed'), { code: '40001' });
      await c.query('COMMIT');
      if (connectionError) throw connectionError;
      return result;
    }
    catch (error) {
      // A lost connection/commit acknowledgement is an unknown outcome, never
      // authority to replay. Failed cleanup must not replace the original error.
      if (!connectionError) {
        try { await c.query('ROLLBACK'); }
        catch { discard = true; }
      }
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (connectionError || discard) throw connectionError ?? error;
      if (attempt === 2 || !['40001', '40P01'].includes(String(code))) throw error;
    } finally {
      c.release(discard || !!connectionError);
      // Destruction can emit a final error; retain its listener until end.
      if (discard || connectionError) c.once('end', () => c.removeListener('error', failed));
      else c.removeListener('error', failed);
    }
    await new Promise(resolve => setTimeout(resolve, 5 + Math.floor(Math.random() * 20)));
  }
  throw new Error('transaction_retry_exhausted');
}
export async function control(c: PoolClient) {
  // Callers must retain this transaction through their state/job disposition.
  // Reject an older transaction snapshot before taking locks or changing state.
  if ((await c.query('SHOW transaction_isolation')).rows[0].transaction_isolation !== 'read committed')
    throw new Error('unsupported_transaction_isolation');
  const r = (await c.query("SELECT * FROM dispatch.merchant_control WHERE merchant_id='single' FOR UPDATE")).rows[0];
  if (!r || r.mainnet_enabled || r.physical_enabled) throw new Error('not_ready');
  // A snapshot taken by the lock statement can predate a quarantine commit.
  // All incident writers take this same control lock; read only after acquiring it.
  r.quarantined = (await c.query("SELECT EXISTS(SELECT 1 FROM dispatch.payment_incidents WHERE kind='reorg' AND resolved_at IS NULL) AS quarantined")).rows[0].quarantined;
  // Observe the date after acquiring the lock, not before a potentially long lock wait.
  r.today = (await c.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text today")).rows[0].today;
  await c.query("SELECT set_config('dispatch.budget_day',$1,true)", [r.today]);
  return r;
}
// Caller owns merchant_control. Carry every unresolved amount before new binds or terminal transitions.
export async function rollover(c: PoolClient, cap: string, today: string) {
  await c.query(`INSERT INTO dispatch.spend_budgets(merchant_id,utc_day,cap) VALUES('single',$1,$2) ON CONFLICT DO NOTHING`, [today, cap]);
  await c.query(`WITH added AS (
    INSERT INTO dispatch.budget_allocations(attempt_id,merchant_id,utc_day,amount)
    SELECT id,'single',$1,amount FROM dispatch.payment_attempts
    WHERE state IN ('bound','ready_to_submit','submitting','pending','review_required')
    ON CONFLICT DO NOTHING RETURNING amount)
    UPDATE dispatch.spend_budgets SET gross_reserved=gross_reserved+(SELECT COALESCE(sum(amount),0) FROM added)
    WHERE merchant_id='single' AND utc_day=$1`, [today]);
  await c.query(`UPDATE dispatch.merchant_control SET budget_rolled_through=$1,version=version+1
    WHERE merchant_id='single' AND budget_rolled_through IS DISTINCT FROM $1::date`, [today]);
}
export async function permitted(c: PoolClient, order: string, credential: string, confirmed = true) {
  key(credential);
  const s = (await c.query(`SELECT s.id,s.kind FROM dispatch.buyer_sessions s JOIN dispatch.buyer_grants g ON g.session_id=s.id
    WHERE s.capability_hash=$1 AND g.order_id=$2 AND s.expires_at>clock_timestamp() AND s.revoked_at IS NULL
    AND ($3=false OR g.confirmed_at IS NOT NULL) FOR UPDATE OF s`, [digest(credential), uuid(order), confirmed])).rows[0];
  if (!s) throw new Error('unauthorized');
  return s;
}
async function replay(c: PoolClient, order: string, op: string, k: string, fp: string) {
  const r = (await c.query('SELECT * FROM dispatch.idempotency_records WHERE scope_id=$1 AND operation=$2 AND key_hash=$3',
    [order, op, digest(key(k))])).rows[0];
  if (r && r.fingerprint !== fp) throw new Error('idempotency_conflict');
  return r;
}
async function remember(c: PoolClient, order: string, op: string, k: string, fp: string, result: string) {
  await c.query(`INSERT INTO dispatch.idempotency_records(scope_id,operation,key_hash,fingerprint,operation_id,result_reference)
    VALUES($1,$2,$3,$4,$5,$6)`, [order, op, digest(k), fp, randomUUID(), result]);
}
export class StalePolicyError extends Error {
  constructor(readonly nextAction: 'review_policy' | 'create_checkout') { super('stale_policy'); }
}
// Node 24's native rawJSON preserves the full PostgreSQL bigint range as an exact
// JSON integer token. Never round a version through Number outside its safe range.
function statusVersion(value: string): number | { readonly rawJSON: string } {
  const n = BigInt(value);
  if (n < 0n) throw new Error('invalid_status_version');
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  const json = JSON as JSON & { rawJSON(text: string): { readonly rawJSON: string } };
  return json.rawJSON(n.toString());
}
export class Commerce {
  readonly #key: Buffer;
  readonly buyers: BuyerAccess;
  constructor(readonly pool: Pool, encryptionKey: Buffer, readonly chain: ChainReader, readonly origin: string, readonly providerOrigin: string, readonly runtimeGate?: () => Promise<void>) {
    const url = new URL(origin), provider = new URL(providerOrigin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.hostname !== '127.0.0.1'
      || provider.protocol !== 'https:' || provider.origin !== providerOrigin || !!provider.username || !!provider.password || encryptionKey.length !== 32) throw new Error('local_only');
    this.#key = Buffer.from(encryptionKey);
    this.buyers = new BuyerAccess(pool, encryptionKey, origin);
  }
  async snapshot() {
    const s = await loadSupport(this.pool, this.providerOrigin);
    return new CapabilitySnapshot({ kinds: s.supported_kinds, extensions: [], signers: {} }, s.fetched_at, s.expires_at);
  }
  async readiness() {
    await this.runtimeGate?.();
    const snapshot = await this.snapshot();
    const observation = await this.chain.preaccept('0x0000000000000000000000000000000000000001', ('0x' + randomBytes(32).toString('hex')) as `0x${string}`);
    freshObservation(observation); return snapshot;
  }
  async create(input: unknown, browserCredential?: string) {
    const v = object(input, ['product_id', 'product_version', 'quantity', 'client_kind']);
    const product = uuid(v.product_id);
    if (!Number.isSafeInteger(v.product_version) || v.quantity !== 1 || !['agent', 'browser'].includes(String(v.client_kind))) throw new Error('invalid_input');
    if (v.client_kind === 'browser' && !this.origin.startsWith('https:')) throw new Error('https_required');
    await this.readiness();
    const credential = browserCredential ?? randomBytes(32).toString('base64url');
    return transaction(this.pool, async c => {
      const ctl = await control(c);
      if (ctl.payment_paused || ctl.quarantined || !ctl.config_id) throw new Error('not_ready');
      const config = (await c.query('SELECT * FROM dispatch.merchant_config_versions WHERE id=$1', [ctl.config_id])).rows[0];
      const p = (await c.query(`SELECT p.* FROM dispatch.products p JOIN dispatch.product_publication u
        ON (p.product_id,p.version)=(u.product_id,u.version) WHERE p.product_id=$1 AND p.version=$2 AND u.enabled`, [product, v.product_version])).rows[0];
      if (!p || p.kind !== 'digital' || p.policy_version !== config.policy_version || config.pay_origin !== this.origin
        || config.finality_policy !== 'safe' || !Array.isArray(config.policy_urls) || !config.policy_urls.length) throw new Error('not_ready');
      digitalTotal(p.unit_amount, p.tax_status, p.tax_source, p.tax_version);
      const id = randomUUID(); let session = randomUUID(), expires: Date;
      await c.query('INSERT INTO dispatch.orders(id,config_id,product_id,product_version) VALUES($1,$2,$3,$4)', [id, config.id, product, p.version]);
      if (browserCredential) {
        const existing = (await c.query(`SELECT id,expires_at FROM dispatch.buyer_sessions WHERE capability_hash=$1
          AND kind='browser' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [digest(key(browserCredential))])).rows[0];
        if (!existing || v.client_kind !== 'browser') throw new Error('unauthorized');
        session = existing.id; expires = existing.expires_at;
      } else {
        expires = (await c.query(`INSERT INTO dispatch.buyer_sessions(id,capability_hash,kind,expires_at)
          VALUES($1,$2,$3,clock_timestamp()+CASE WHEN $3='browser' THEN interval '24 hours' ELSE interval '30 days' END) RETURNING expires_at`,
        [session, digest(credential), v.client_kind])).rows[0].expires_at;
      }
      await c.query('INSERT INTO dispatch.buyer_grants(session_id,order_id) VALUES($1,$2)', [session, id]);
      return { id, status_path: `/v1/checkouts/${id}`, credential_confirmed: false, agent_capability: credential,
        expires_at: expires.toISOString(), policy_version: config.policy_version, policy_urls: config.policy_urls };
    });
  }
  async status(order: string, credential: string, requestId: string = randomUUID()) {
    return transaction(this.pool, async c => {
      const ctl = await control(c);
      const s = await permitted(c, order, credential, false);
      await c.query('UPDATE dispatch.buyer_sessions SET confirmed_at=COALESCE(confirmed_at,clock_timestamp()) WHERE id=$1', [s.id]);
      await c.query('UPDATE dispatch.buyer_grants SET confirmed_at=COALESCE(confirmed_at,clock_timestamp()) WHERE session_id=$1 AND order_id=$2', [s.id, order]);
      const r = (await c.query(`SELECT o.id,o.state,o.fulfillment_state,o.shipment_state,o.version,cv.policy_version,cv.policy_urls,
        COALESCE((SELECT a.state FROM dispatch.payment_attempts a WHERE a.order_id=o.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1),'none') payment_state
        FROM dispatch.orders o JOIN dispatch.merchant_config_versions cv ON cv.id=o.config_id WHERE o.id=$1`, [order])).rows[0];
      const refund = (await c.query(`SELECT r.state FROM dispatch.refunds r JOIN dispatch.settlements s ON s.id=r.settlement_id WHERE s.order_id=$1 ORDER BY r.created_at DESC LIMIT 1`,[order])).rows[0];
      const q = (await c.query('SELECT id FROM dispatch.quotes WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [order])).rows[0];
      const presentation = (await c.query(`SELECT cv.merchant_name,p.title,p.description,p.product_id,p.version
        FROM dispatch.orders o JOIN dispatch.merchant_config_versions cv ON cv.id=o.config_id
        JOIN dispatch.products p ON (p.product_id,p.version)=(o.product_id,o.product_version) WHERE o.id=$1`, [order])).rows[0];
      return { id: r.id, order_state: r.state, payment_state: r.payment_state,
        merchant_name: presentation.merchant_name,
        product: { id: presentation.product_id, version: presentation.version, title: presentation.title, description: presentation.description },
        ...(q ? { quote: await this.quoteView(c, q.id) } : {}),
        delivery: await deliveryProjection(c, order, ctl), merchant_handoff: await handoffProjection(c,order), refund_state: refund?.state ?? 'none', shipment_state: r.shipment_state,
        policy_version: r.policy_version, policy_urls: r.policy_urls, version: statusVersion(r.version),
        credential_confirmed: true, status_path: `/v1/checkouts/${order}`, request_id: uuid(requestId),
        next_action: r.state === 'review_required' || r.payment_state !== 'none' ? 'poll_status'
          : r.state === 'draft' ? 'review_policy' : r.state === 'quoted' ? 'review_quote'
            : ['expired', 'cancelled'].includes(r.state) ? 'create_checkout' : 'none' };
    });
  }
  async quote(order: string, credential: string, k: string, input: unknown) {
    const v = object(input, ['product_version', 'quantity', 'policy_version']);
    if (v.quantity !== 1 || !Number.isInteger(v.product_version) || typeof v.policy_version !== 'string') throw new Error('invalid_input');
    const fp = digest(canonical({ order, operation: 'quote', input: v }));
    await this.readiness();
    return transaction(this.pool, async c => {
      const ctl = await control(c); await permitted(c, order, credential);
      const o = (await c.query('SELECT * FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order])).rows[0];
      // Existing financial state takes precedence even over replayed quote commands.
      const bound = (await c.query(`SELECT id FROM dispatch.payment_attempts WHERE order_id=$1
        AND state IN ('bound','ready_to_submit','submitting','pending','review_required','settled') LIMIT 1`, [order])).rows[0];
      if (bound || !['draft', 'quoted'].includes(o.state)) throw new Error('quote_unavailable');
      const prior = await replay(c, order, 'quote', k, fp);
      if (prior) return this.quoteView(c, prior.result_reference);
      if (ctl.payment_paused || ctl.quarantined) throw new Error('quote_unavailable');
      const cv = (await c.query('SELECT * FROM dispatch.merchant_config_versions WHERE id=$1', [o.config_id])).rows[0];
      const p = (await c.query('SELECT * FROM dispatch.products WHERE product_id=$1 AND version=$2', [o.product_id, o.product_version])).rows[0];
      if (v.policy_version !== cv.policy_version) throw new StalePolicyError('review_policy');
      if (v.product_version !== o.product_version) throw new Error('stale_product');
      const old = (await c.query('SELECT * FROM dispatch.quotes WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [order])).rows[0];
      if (old && old.expires_at.getTime() > Date.now()) {
        await remember(c, order, 'quote', k, fp, old.id); return this.quoteView(c, old.id);
      }
      const active = (await c.query('SELECT policy_version FROM dispatch.merchant_config_versions WHERE id=$1', [ctl.config_id])).rows[0];
      if (!active || active.policy_version !== cv.policy_version || p.policy_version !== cv.policy_version) throw new StalePolicyError('create_checkout');
      if (p.kind !== 'digital') throw new Error('not_ready');
      const total = digitalTotal(p.unit_amount, p.tax_status, p.tax_source, p.tax_version);
      const id = randomUUID(), expires = new Date(Date.now() + 120000);
      const hash = digest(canonical({ id, order, config: o.config_id, product: o.product_id, product_version: o.product_version,
        quantity: 1, unit: total, discount: '0', tax: '0', shipping: '0', total, token: cv.token, network: cv.network,
        payee: cv.payee, tax_status: p.tax_status, tax_source: p.tax_source, tax_version: p.tax_version,
        shipping_source: 'not_applicable', policy_version: cv.policy_version, policy_urls: cv.policy_urls, expires: expires.toISOString() }));
      await c.query(`INSERT INTO dispatch.quotes(id,order_id,version,config_id,product_id,product_version,quantity,
        unit_amount,tax_amount,shipping_amount,total,network,token,payee,tax_status,tax_source,tax_version,
        shipping_source,policy_version,inputs_hash,quote_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,1,$7,0,0,$7,$8,$9,$10,$11,$12,$13,'not_applicable',$14,$15,$16,$17)`,
      [id, order, (old?.version ?? 0) + 1, o.config_id, o.product_id, o.product_version, total, cv.network, cv.token,
        cv.payee, p.tax_status, p.tax_source, p.tax_version, cv.policy_version, fp, hash, expires]);
      await c.query("UPDATE dispatch.orders SET state='quoted',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [order]);
      await remember(c, order, 'quote', k, fp, id); return this.quoteView(c, id);
    });
  }
  private async quoteView(c: PoolClient, id: string) {
    const q = (await c.query(`SELECT q.*,cv.policy_urls FROM dispatch.quotes q JOIN dispatch.merchant_config_versions cv ON cv.id=q.config_id WHERE q.id=$1`, [id])).rows[0];
    return { id: q.id, order_id: q.order_id, product_id: q.product_id, product_version: q.product_version, quantity: 1,
      unit_atomic: q.unit_amount, discount_atomic: q.discount_amount, tax_atomic: q.tax_amount, shipping_atomic: q.shipping_amount,
      total_atomic: q.total, tax_status: q.tax_status, tax_source: q.tax_source, tax_version: q.tax_version,
      shipping_source: q.shipping_source, policy_version: q.policy_version, policy_urls: q.policy_urls, network: q.network,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payee: q.payee, expires_at: q.expires_at.toISOString(), server_time: new Date().toISOString(), quote_hash: q.quote_hash };
  }
  async paymentChallenge(order: string, credential: string, quote: string, quoteHash: string) {
    const url = `${this.origin}/v1/checkouts/${uuid(order)}/pay`;
    const read = await transaction(this.pool, async c => {
      const ctl = await control(c); await permitted(c, order, credential);
      const o = (await c.query('SELECT state FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order])).rows[0];
      if (o.state !== 'quoted') return null;
      if (ctl.payment_paused || ctl.quarantined) throw new Error('not_ready');
      const q = (await c.query('SELECT * FROM dispatch.quotes WHERE id=$1 AND order_id=$2 AND quote_hash=$3', [uuid(quote), order, quoteHash])).rows[0];
      if (!q || q.expires_at.getTime() <= Date.now()) throw new Error('quote_unavailable');
      return q;
    });
    if (!read) return null;
    const snapshot = await this.readiness();
    // SDK work is outside transaction; commit-time checks below fence concurrent expiry/bind/pause.
    const built = await challenge({ amount: read.total, payee: read.payee, deadline: read.expires_at.getTime(), url }, snapshot);
    const saved = await transaction(this.pool, async c => {
      const ctl = await control(c); await permitted(c, order, credential);
      const o = (await c.query('SELECT state FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order])).rows[0];
      if (o.state !== 'quoted') return null;
      if (ctl.payment_paused || ctl.quarantined) throw new Error('not_ready');
      await c.query(`INSERT INTO dispatch.payment_challenges(quote_id,order_id,resource_url,requirements,deadline)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [quote, order, url, built, read.expires_at]);
      return (await c.query('SELECT * FROM dispatch.payment_challenges WHERE quote_id=$1', [quote])).rows[0];
    });
    if (!saved) return null;
    const req = saved.requirements as PaymentRequirements;
    const result = await required(req, url, snapshot);
    if (Date.now() + req.maxTimeoutSeconds * 1000 + 5000 > saved.deadline.getTime()) throw new Error('approval_window_exhausted');
    return result;
  }
  async bind(order: string, credential: string, k: string, quote: string, quoteHash: string, input: unknown) {
    input = structuredClone(input); uuid(order); uuid(quote); key(k);
    // Authenticate before cryptographic/RPC work. No public proof is access authority.
    const saved = await transaction(this.pool, async c => {
      await permitted(c, order, credential);
      return (await c.query(`SELECT ch.*,q.quote_hash FROM dispatch.payment_challenges ch JOIN dispatch.quotes q ON q.id=ch.quote_id
        WHERE ch.quote_id=$1 AND ch.order_id=$2 AND q.quote_hash=$3`, [quote, order, quoteHash])).rows[0];
    });
    if (!saved) throw new Error('challenge_required');
    const { payment, binding: b } = await authorization(input, saved.requirements);
    if (payment.resource?.url !== saved.resource_url) throw new Error('binding_mismatch');
    const plain = canonical({ operation: 'payCheckout', order, quote, quoteHash, payment, requirements: saved.requirements }), fp = digest(plain);
    // Exact durable replay bypasses RPC freshness and pause, but never access checks.
    const existing = await transaction(this.pool, async c => {
      await control(c); await permitted(c, order, credential);
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order]);
      const idem = await replay(c, order, 'pay', k, fp);
      const prior = (await c.query(`SELECT id,order_id,quote_id,request_fingerprint FROM dispatch.payment_attempts
        WHERE network='eip155:8453' AND token=$1 AND authorizer=$2 AND nonce=$3`, [b.token, b.from, b.nonce])).rows[0];
      if (prior && (prior.order_id !== order || prior.quote_id !== quote || prior.request_fingerprint !== fp)) throw new Error('binding_conflict');
      if (prior && !idem) await remember(c, order, 'pay', k, fp, prior.id);
      return prior?.id as string | undefined;
    });
    if (existing) return existing;
    await this.snapshot();
    const observation = structuredClone(await this.chain.preaccept(b.from, b.nonce)); freshObservation(observation);
    return transaction(this.pool, async c => {
      const ctl = await control(c); await permitted(c, order, credential);
      const o = (await c.query('SELECT * FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order])).rows[0];
      const idem = await replay(c, order, 'pay', k, fp); if (idem) return idem.result_reference as string;
      const prior = (await c.query(`SELECT * FROM dispatch.payment_attempts WHERE network='eip155:8453' AND token=$1 AND authorizer=$2 AND nonce=$3`, [b.token, b.from, b.nonce])).rows[0];
      if (prior) {
        if (prior.order_id !== order || prior.quote_id !== quote || prior.request_fingerprint !== fp) throw new Error('binding_conflict');
        await remember(c, order, 'pay', k, fp, prior.id); return prior.id as string;
      }
      if (ctl.payment_paused || ctl.quarantined || o.state !== 'quoted' || (await c.query('SELECT 1 FROM dispatch.payment_attempts WHERE order_id=$1', [order])).rowCount)
        throw new Error('payment_unavailable');
      freshObservation(observation);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (saved.deadline.getTime() <= Date.now() || BigInt(b.validBefore) * 1000n > BigInt(saved.deadline.getTime())
        || BigInt(b.validBefore) <= now || BigInt(b.validBefore) <= observation.chainTime
        || BigInt(b.validAfter) > now || BigInt(b.validAfter) >= observation.chainTime) throw new Error('invalid_window');
      await rollover(c, ctl.max_day_gross, ctl.today);
      if (BigInt(b.value) > BigInt(ctl.max_order)) throw new Error('budget_exceeded');
      const reserved = await c.query(`UPDATE dispatch.spend_budgets SET gross_reserved=gross_reserved+$1
        WHERE merchant_id='single' AND utc_day=$2 AND gross_reserved+$1<=LEAST(cap,$3::numeric) RETURNING gross_reserved`, [b.value, ctl.today, ctl.max_day_gross]);
      if (!reserved.rowCount) throw new Error('budget_exceeded');
      const id = randomUUID(), encrypted = seal(Buffer.from(plain), this.#key, 'local-application', id + ':' + b.digest);
      await c.query(`INSERT INTO dispatch.payment_attempts(id,order_id,quote_id,network,token,authorizer,payee,amount,nonce,
        typed_digest,request_fingerprint,operation_id,requirements,valid_after,valid_before,authorization_ciphertext,
        authz_key_id,authz_iv,authz_tag,preaccept_block,preaccept_hash,preaccept_chain_time,preaccept_observed_at,state)
        VALUES($1,$2,$3,'eip155:8453',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,to_timestamp($21),$22,'ready_to_submit')`,
      [id, order, quote, b.token, b.from, b.to, b.value, b.nonce, b.digest, fp, randomUUID(), saved.requirements,
        b.validAfter, b.validBefore, encrypted.ciphertext, encrypted.keyId, encrypted.iv, encrypted.tag,
        observation.block.toString(), observation.hash, observation.chainTime.toString(), new Date(observation.observedAt)]);
      await c.query(`INSERT INTO dispatch.budget_allocations(attempt_id,merchant_id,utc_day,amount) VALUES($1,'single',$2,$3)`, [id, ctl.today, b.value]);
      await c.query(`INSERT INTO dispatch.outbox_jobs(id,order_id,attempt_id,effect_type,effect_version,effect_key,payload_reference,state)
        VALUES($1,$2,$3,'submit',1,$4,$3,'queued')`, [randomUUID(), order, id, 'submit:' + id]);
      await c.query("UPDATE dispatch.orders SET state='payment_pending',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [order]);
      await remember(c, order, 'pay', k, fp, id); return id;
    });
  }
  async cancel(order: string, credential: string, k: string) {
    return transaction(this.pool, async c => {
      await control(c); await permitted(c, order, credential);
      const o = (await c.query('SELECT * FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order])).rows[0];
      const fp = digest(canonical({ order, operation: 'cancel' }));
      if (await replay(c, order, 'cancel', k, fp)) return;
      if (!['draft', 'quoted', 'cancelled', 'expired'].includes(o.state)
        || (await c.query('SELECT 1 FROM dispatch.payment_attempts WHERE order_id=$1', [order])).rowCount) throw new Error('unresolved_payment');
      await c.query("UPDATE dispatch.orders SET state='cancelled',version=version+1,updated_at=clock_timestamp() WHERE id=$1", [order]);
      await remember(c, order, 'cancel', k, fp, order);
    });
  }
}
