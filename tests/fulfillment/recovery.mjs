import { readFile } from 'node:fs/promises';
import { PrivateFiles } from '../../dist/packages/fulfillment/src/files.js';
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
assert.match(process.env.DISPATCH_DB_HOST, /^\/tmp\/dispatch-b4-/);
const pool = new Pool({ host: process.env.DISPATCH_DB_HOST, port: 55442, user: 'fixture_admin', database: process.argv[2] ?? 'dispatch' });
try {
  const tables = (await pool.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('dispatch','merchant_adapter') ORDER BY schemaname,tablename")).rows;
  const hashes = {};
  for (const { schemaname,tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const rows = (await pool.query(`SELECT row_to_json(t)::text r FROM ${schemaname}.${tablename} t ORDER BY row_to_json(t)::text`)).rows;
    hashes[schemaname+'.'+tablename] = { rows: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  assert.equal((await pool.query('SELECT mainnet_enabled FROM dispatch.merchant_control')).rows[0].mainnet_enabled, false);
  const key = await readFile(process.env.DISPATCH_DB_HOST + '/fixture.key');
  const store = new PaymentWorker(pool, key);
  for (const a of (await pool.query('SELECT id FROM dispatch.payment_attempts')).rows) await store.envelope(a.id);
  assert.equal(await readFile(process.env.DISPATCH_DB_HOST + '/assets/fixture.txt', 'utf8'), 'fixture-asset');
  assert.equal(await readFile(process.env.DISPATCH_DB_HOST + '/assets/manifest', 'utf8'), 'fixture-manifest');
  const files=new PrivateFiles(process.env.DISPATCH_DB_HOST+'/assets');
  for(const a of (await pool.query('SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM dispatch.asset_versions')).rows)await files.read(a);
  for(const table of ['merchant_events','merchant_receipts','webhook_results'])assert.ok(hashes['dispatch.'+table].rows>0);
  assert.ok(hashes['merchant_adapter.orders'].rows>0);
  console.log(JSON.stringify({ tables: hashes, restored_authorization_decryption: 'passed', fixture_asset_key_pair: 'passed', purchased_asset_manifest_bytes:'verified', receiver_receipts:'included' }));
} finally { await pool.end(); }
