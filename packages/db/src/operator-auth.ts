import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { control, digest, transaction } from './commerce.js';
import { rateLimit } from './index.js';
import { key } from '../../domain/src/payment.js';
import { checkPassword, makeVerifier } from '../../security/src/operator.js';
export type OperatorAuthority = { token: string; csrf?: string };
export const csrfFor = (token: string) => digest('operator-csrf:' + token).slice(2);
export async function localBootstrap(pool: Pool, origin: string, lifetimeSeconds = 900): Promise<string> {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 900) throw new Error('invalid_lifetime');
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.hostname !== '127.0.0.1') throw new Error('local_origin_required');
  const secret = randomBytes(32).toString('base64url');
  await transaction(pool, async c => {
    await control(c);
    const result = await c.query(`INSERT INTO dispatch.operator_identity(merchant_id,trusted_origin,bootstrap_hash,bootstrap_expires_at)
      VALUES('single',$1,$2,clock_timestamp()+$3::integer*interval '1 second')
      ON CONFLICT(merchant_id) DO UPDATE SET bootstrap_hash=EXCLUDED.bootstrap_hash,bootstrap_expires_at=EXCLUDED.bootstrap_expires_at
      WHERE operator_identity.initialized_at IS NULL AND operator_identity.bootstrap_expires_at<=clock_timestamp() AND operator_identity.trusted_origin=EXCLUDED.trusted_origin RETURNING merchant_id`, [origin, digest(secret), lifetimeSeconds]);
    if (result.rowCount !== 1) throw new Error('bootstrap_unavailable');
  });
  return secret;
}
export async function completeLocalBootstrap(pool: Pool, secret: string, input: unknown) {
  const { salt, verifier } = await makeVerifier(input);
  await transaction(pool, async c => {
    await control(c);
    const r = await c.query(`UPDATE dispatch.operator_identity SET password_salt=$1,password_verifier=$2,initialized_at=clock_timestamp()
      WHERE merchant_id='single' AND bootstrap_hash=$3 AND initialized_at IS NULL AND bootstrap_expires_at>clock_timestamp()`,
    [salt, verifier, digest(key(secret))]);
    if (r.rowCount !== 1) throw new Error('bootstrap_unavailable');
  });
}
export class OperatorAuth {
  constructor(readonly pool: Pool, readonly origin: string) {}
  async identity(c: Pool | PoolClient = this.pool) {
    const row = (await c.query("SELECT * FROM dispatch.operator_identity WHERE merchant_id='single'")).rows[0];
    if (!row || !row.initialized_at || row.trusted_origin !== this.origin) throw new Error('unauthorized');
    return row;
  }
  async challenge() {
    if (!await rateLimit(this.pool, 'operator-challenge', 12)) throw new Error('rate_limited');
    await this.identity();
    const token = randomBytes(32).toString('base64url'), csrf = csrfFor(token);
    const r = await this.pool.query(`INSERT INTO dispatch.operator_challenges(token_hash,csrf_hash,expires_at)
      VALUES($1,$2,clock_timestamp()+interval '5 minutes') RETURNING expires_at`, [digest(token), digest(csrf)]);
    return { token, csrf_token: csrf, expires_at: r.rows[0].expires_at.toISOString() };
  }
  async login(challenge: string, csrf: string, input: unknown) {
    if (!await rateLimit(this.pool, 'operator-login', 8)) throw new Error('rate_limited');
    const ident = await this.identity(), good = await checkPassword(input, ident.password_salt, ident.password_verifier);
    // No password-derived fingerprints or saved authentication successes.
    return transaction(this.pool, async c => {
      await control(c); const current = await this.identity(c);
      if (!good || !current.password_verifier.equals(ident.password_verifier)) throw new Error('unauthorized');
      const used = await c.query(`UPDATE dispatch.operator_challenges SET consumed_at=clock_timestamp()
        WHERE token_hash=$1 AND csrf_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING token_hash`,
      [digest(key(challenge)), digest(csrf)]);
      if (used.rowCount !== 1) throw new Error('unauthorized');
      const token = randomBytes(32).toString('base64url'), csrfToken = csrfFor(token);
      const r = await c.query(`INSERT INTO dispatch.operator_sessions(id,token_hash,csrf_hash,expires_at,last_seen_at,fresh_auth_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '8 hours',clock_timestamp(),clock_timestamp()) RETURNING expires_at`,
      [randomUUID(), digest(token), digest(csrfToken)]);
      return { token, csrf_token: csrfToken, expires_at: r.rows[0].expires_at.toISOString() };
    });
  }
  async require(c: PoolClient, auth: OperatorAuthority, fresh = false, mutation = false) {
    await this.identity(c);
    // Lock first, then re-read clock/authority after any waiter is released.
    const s = (await c.query('SELECT id FROM dispatch.operator_sessions WHERE token_hash=$1 FOR UPDATE', [digest(key(auth.token))])).rows[0];
    if (!s) throw new Error('unauthorized');
    const row = (await c.query(`SELECT * FROM dispatch.operator_sessions WHERE id=$1 AND revoked_at IS NULL
      AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '30 minutes'
      AND ($2=false OR fresh_auth_at>clock_timestamp()-interval '5 minutes')`, [s.id, fresh])).rows[0];
    if (!row) throw new Error('unauthorized');
    if (mutation && (!auth.csrf || row.csrf_hash !== digest(auth.csrf))) throw new Error('forbidden');
    await c.query('UPDATE dispatch.operator_sessions SET last_seen_at=clock_timestamp() WHERE id=$1', [row.id]);
    return row;
  }
  async session(auth: OperatorAuthority) {
    return transaction(this.pool, async c => { await control(c); const row = await this.require(c, auth);
      return { csrf_token: csrfFor(auth.token), expires_at: row.expires_at.toISOString() }; });
  }
  async reauth(auth: OperatorAuthority, input: unknown) {
    if (!await rateLimit(this.pool, 'operator-reauth', 8)) throw new Error('rate_limited');
    await this.session(auth); const ident = await this.identity();
    const good = await checkPassword(input, ident.password_salt, ident.password_verifier);
    return transaction(this.pool, async c => {
      await control(c); const row = await this.require(c, auth, false, true), current = await this.identity(c);
      if (!good || !current.password_verifier.equals(ident.password_verifier)) throw new Error('unauthorized');
      await c.query('UPDATE dispatch.operator_sessions SET fresh_auth_at=clock_timestamp() WHERE id=$1', [row.id]);
      return { csrf_token: csrfFor(auth.token), expires_at: row.expires_at.toISOString() };
    });
  }
  async logout(auth: OperatorAuthority) {
    return transaction(this.pool, async c => { await control(c); const row = await this.require(c, auth, false, true);
      await c.query('UPDATE dispatch.operator_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [row.id]); });
  }
}
