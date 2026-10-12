import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { digest, permitted, transaction } from './commerce.js';
import { key, uuid } from '../../domain/src/payment.js';
const publicToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export class BuyerAccess {
  readonly #secret: Buffer;
  constructor(readonly pool: Pool, secret: Buffer, readonly origin: string) { this.#secret = Buffer.from(secret); }
  csrf(credential: string) { return createHmac('sha256', this.#secret).update('buyer-csrf\0'+key(credential)).digest('base64url'); }
  checkCsrf(credential: string, input: unknown) {
    const expected = this.csrf(credential);
    if (typeof input !== 'string' || input.length !== expected.length || !timingSafeEqual(Buffer.from(input), Buffer.from(expected))) throw new Error('forbidden');
  }
  async session(credential: string, kind: 'browser'|'agent') {
    const r = (await this.pool.query(`SELECT expires_at FROM dispatch.buyer_sessions WHERE capability_hash=$1
      AND kind=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [digest(key(credential)), kind])).rows[0];
    if (!r) throw new Error('unauthorized');
    return { csrf_token: this.csrf(credential), expires_at: r.expires_at.toISOString() };
  }
  async catalog(product?: string) {
    const rows = (await this.pool.query(`SELECT p.product_id,p.version,p.title,p.description,p.unit_amount,cv.merchant_name,cv.policy_urls,
      NOT ctl.payment_paused available FROM dispatch.product_publication pub JOIN dispatch.products p
      ON (p.product_id,p.version)=(pub.product_id,pub.version) CROSS JOIN dispatch.merchant_control ctl
      JOIN dispatch.merchant_config_versions cv ON cv.id=ctl.config_id
      WHERE pub.enabled AND p.kind='digital' AND p.policy_version=cv.policy_version
      AND p.tax_status IN ('tax_included','merchant_attested_zero') AND ($1::uuid IS NULL OR p.product_id=$1)
      ORDER BY p.product_id,p.version DESC LIMIT 100`, [product ? uuid(product) : null])).rows;
    return { products: rows.map(p => ({ id: p.product_id, version: p.version, title: p.title, description: p.description,
      merchant_name: p.merchant_name, kind: 'digital' as const, indicative_amount_atomic: p.unit_amount,
      network: 'eip155:8453' as const, asset: publicToken, purchase_path: '/buy/'+p.product_id,
      policy_urls: p.policy_urls as string[], available: p.available as boolean })) };
  }
  async export(order: string, credential: string, operation: string) {
    uuid(order); key(operation);
    // Deterministic, secret-keyed output permits exact idempotent replay without plaintext storage.
    const capability = createHmac('sha256', this.#secret).update('buyer-recovery\0'+order+'\0'+operation).digest('base64url');
    return transaction(this.pool, async c => {
      await permitted(c, order, credential);
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [order]);
      let row = (await c.query(`SELECT s.id,s.expires_at,s.revoked_at FROM dispatch.buyer_sessions s
        JOIN dispatch.buyer_grants g ON g.session_id=s.id WHERE s.capability_hash=$1 AND g.order_id=$2 AND s.kind='recovery'`, [digest(capability), order])).rows[0];
      if (!row) {
        await c.query(`UPDATE dispatch.buyer_sessions SET revoked_at=clock_timestamp() WHERE kind='recovery' AND id IN
          (SELECT session_id FROM dispatch.buyer_grants WHERE order_id=$1) AND revoked_at IS NULL`, [order]);
        row = await this.insert(c, capability, 'recovery', '365 days');
        await c.query('INSERT INTO dispatch.buyer_grants(session_id,order_id) VALUES($1,$2)', [row.id, order]);
      }
      if (row.revoked_at || row.expires_at.getTime() <= Date.now()) throw new Error('recovery_rotated');
      return { version: 1 as const, order_id: order, origin: this.origin, capability, expires_at: row.expires_at.toISOString() };
    });
  }
  private async insert(c: PoolClient, credential: string, kind: string, duration: string) {
    return (await c.query(`INSERT INTO dispatch.buyer_sessions(id,capability_hash,kind,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+$4::interval) RETURNING id,expires_at`, [randomUUID(), digest(credential), kind, duration])).rows[0];
  }
  async import(capability: string, existing?: string) {
    key(capability);
    const credential = existing ?? randomBytes(32).toString('base64url');
    return transaction(this.pool, async c => {
      const browser = existing ? (await c.query(`SELECT id,expires_at FROM dispatch.buyer_sessions WHERE capability_hash=$1
        AND kind='browser' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [digest(key(existing))])).rows[0]
        : await this.insert(c, credential, 'browser', '24 hours');
      if (!browser) throw new Error('unauthorized');
      // Identification only: serialize with export in browser -> order -> recovery order.
      // The grant insert also takes an order key-share lock through its foreign key.
      const identified = (await c.query(`SELECT id,bound_order_id FROM dispatch.buyer_sessions
        WHERE capability_hash=$1 AND kind='recovery'`, [digest(capability)])).rows[0];
      if (!identified?.bound_order_id) throw new Error('unauthorized');
      await c.query('SELECT id FROM dispatch.orders WHERE id=$1 FOR UPDATE', [identified.bound_order_id]);
      await c.query('SELECT id FROM dispatch.buyer_sessions WHERE id=$1 FOR UPDATE', [identified.id]);
      // Fresh statement after all lock waits: neither the lookup nor a pre-wait expiry
      // check confers authority. Revalidate the exact binding and both locked sessions.
      const saved = (await c.query(`SELECT s.id,g.order_id FROM dispatch.buyer_sessions s JOIN dispatch.buyer_grants g ON g.session_id=s.id
        JOIN dispatch.buyer_sessions b ON b.id=$4
        WHERE s.id=$1 AND s.capability_hash=$2 AND s.kind='recovery' AND s.bound_order_id=$3 AND g.order_id=$3
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND b.kind='browser' AND b.revoked_at IS NULL AND b.expires_at>clock_timestamp()`,
      [identified.id, digest(capability), identified.bound_order_id, browser.id])).rows[0];
      if (!saved) throw new Error('unauthorized');
      await c.query('INSERT INTO dispatch.buyer_grants(session_id,order_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [browser.id, saved.order_id]);
      return { credential, csrf_token: this.csrf(credential), expires_at: browser.expires_at.toISOString() };
    });
  }
}
