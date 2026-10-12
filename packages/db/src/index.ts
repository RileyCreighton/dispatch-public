import { readFile, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { supportSnapshot, type SupportSnapshot } from '../../contracts/src/index.js';
export async function foundationReady(pool: Pool): Promise<boolean> {
  const r = await pool.query(`SELECT (SELECT array_agg(name ORDER BY name)=
    ARRAY['001_reviewed_schema.sql','002_local_foundation.sql','003_runtime_binding.sql','004_function_execute_acl.sql','005_payment_application.sql','006_buyer_confirmation.sql','007_private_delivery.sql','008_operator_operations.sql','009_refund_invocation_authority.sql']
    FROM dispatch.schema_migrations) AS schema_ok,
    NOT mainnet_enabled AND payment_paused AND NOT physical_enabled AS safe
    FROM dispatch.merchant_control WHERE merchant_id='single'`);
  return r.rows.length === 1 && r.rows[0]?.schema_ok === true && r.rows[0]?.safe === true;
}
export async function rateLimit(pool: Pool, identity: string, limit = 60): Promise<boolean> {
  const hash = '0x' + createHash('sha256').update(identity).digest('hex');
  const result = await pool.query(`INSERT INTO dispatch.abuse_counters(bucket_hash,window_start,count)
    VALUES ($1,date_trunc('minute',clock_timestamp()),1)
    ON CONFLICT(bucket_hash,window_start) DO UPDATE SET count=dispatch.abuse_counters.count+1
    WHERE dispatch.abuse_counters.count<$2 RETURNING count`, [hash, limit]);
  return result.rowCount === 1;
}
export async function storeSupport(pool: Pool, input: unknown, origin: string, now = Date.now()): Promise<string> {
  const v = supportSnapshot(input, origin, now);
  const id = randomUUID(); const digest = '0x' + createHash('sha256').update(JSON.stringify(v)).digest('hex');
  await pool.query(`INSERT INTO dispatch.provider_capability_snapshots
    (id,provider_origin,supported_kinds,fetched_at,expires_at,content_digest) VALUES($1,$2,$3,$4,$5,$6)`,
  [id, v.provider_origin, JSON.stringify(v.supported_kinds), new Date(v.fetched_at), new Date(v.expires_at), digest]);
  return id;
}
export async function loadSupport(pool: Pool, origin: string, now = Date.now()): Promise<SupportSnapshot> {
  const r = await pool.query(`SELECT * FROM dispatch.provider_capability_snapshots
    WHERE provider_origin=$1 ORDER BY fetched_at DESC,id DESC LIMIT 1`, [origin]);
  const v = r.rows[0]; if (!v) throw new Error('support_unavailable');
  const result = supportSnapshot({ provider_origin: v.provider_origin, supported_kinds: v.supported_kinds,
    fetched_at: v.fetched_at.getTime(), expires_at: v.expires_at.getTime() }, origin, now);
  if ('0x' + createHash('sha256').update(JSON.stringify(result)).digest('hex') !== v.content_digest)
    throw new Error('snapshot_digest_mismatch');
  return result;
}
// Local operator composition requires the maintained schema and an active worker.
export async function operationsReady(pool: Pool): Promise<void> {
  const records = (await pool.query('SELECT name,sha256 FROM dispatch.schema_migrations ORDER BY name')).rows;
  const names = (await readdir('db/migrations')).filter(n => /^\d{3}_[a-z_]+\.sql$/.test(n)).sort();
  if (names.length !== 9 || records.length !== names.length) throw new Error('not_ready');
  for (const [i,name] of names.entries()) if (records[i]?.name !== name || records[i]?.sha256 !== createHash('sha256').update(await readFile('db/migrations/'+name)).digest('hex')) throw new Error('not_ready');
  const r = (await pool.query(`SELECT (SELECT count(*) FROM dispatch.schema_migrations)=9 AND
    EXISTS(SELECT 1 FROM dispatch.schema_migrations WHERE name='008_operator_operations.sql') AND
    EXISTS(SELECT 1 FROM dispatch.runtime_health WHERE service='operations_worker' AND checked_at>clock_timestamp()-interval '30 seconds') AND
    NOT mainnet_enabled AND NOT physical_enabled AS ready FROM dispatch.merchant_control WHERE merchant_id='single'`)).rows[0];
  if (!r?.ready) throw new Error('not_ready');
}
