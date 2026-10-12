import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { unseal } from '../dist/packages/security/src/index.js';
const host = process.env.DISPATCH_DB_HOST;
if (!host?.startsWith('/tmp/dispatch-b2-')) throw new Error('fixture_only');
const pool = new Pool({ host, port: 55442, user: 'fixture_admin', password: '', database: process.argv[2] ?? 'dispatch' });
try {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='dispatch' ORDER BY tablename")).rows;
  const hashes = {};
  for (const { tablename } of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('invalid_table');
    const rows = (await pool.query(`SELECT row_to_json(t)::text AS row FROM dispatch.${tablename} t ORDER BY row_to_json(t)::text`)).rows;
    hashes[tablename] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  const key = await readFile(host + '/fixture.key');
  for (const row of (await pool.query('SELECT * FROM dispatch.payment_attempts')).rows) {
    const value = unseal({ ciphertext: row.authorization_ciphertext, keyId: row.authz_key_id, iv: row.authz_iv, tag: row.authz_tag }, key, row.id);
    if (value.toString() !== 'SYNTHETIC-AUTHORIZATION' || row.state !== 'pending') throw new Error('recovery_mismatch');
  }
  const sha = b => '0x' + createHash('sha256').update(b).digest('hex');
  const asset = await readFile(host + '/assets/fixture.txt'), manifest = await readFile(host + '/assets/manifest');
  for (const row of (await pool.query('SELECT * FROM dispatch.asset_versions')).rows) {
    if (row.file_sha256 !== sha(asset) || row.manifest_sha256 !== sha(manifest) || Number(row.size_bytes) !== asset.length) throw new Error('asset_mismatch');
  }
  const c = (await pool.query('SELECT * FROM dispatch.merchant_control')).rows[0];
  if (c.mainnet_enabled || !c.payment_paused || c.physical_enabled) throw new Error('unsafe_recovery');
  const history = (await pool.query('SELECT name,sha256 FROM dispatch.schema_migrations ORDER BY name')).rows;
  assert.deepEqual(history.map(r => r.name), ['001_reviewed_schema.sql', '002_local_foundation.sql',
    '003_runtime_binding.sql', '004_function_execute_acl.sql', '005_payment_application.sql',
    '006_buyer_confirmation.sql', '007_private_delivery.sql', '008_operator_operations.sql', '009_refund_invocation_authority.sql']);
  for (const row of history)
    assert.equal(row.sha256, createHash('sha256').update(await readFile('db/migrations/' + row.name)).digest('hex'));
  const names = ['check_call_claim', 'check_grant_scope', 'conservative_exposure', 'protect_order_binding', 'protect_session_identity'];
  const functionAcls = (await pool.query(`SELECT p.proname,pg_get_userbyid(p.proowner) owner,p.prosecdef,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))
      WHERE grantee=0 AND privilege_type='EXECUTE') public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='dispatch' AND p.proname=ANY($1) ORDER BY p.proname`, [names])).rows;
  assert.equal(functionAcls.length, names.length);
  const roles = ['dispatch_api', 'dispatch_worker', 'dispatch_operator', 'local_api', 'local_worker', 'local_operator'];
  for (const fn of functionAcls) {
    assert.equal(fn.owner, 'dispatch_migrator'); assert.equal(fn.prosecdef, false); assert.equal(fn.public_execute, false);
    for (const role of roles)
      assert.equal((await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, `dispatch.${fn.proname}()`])).rows[0].ok, false);
  }
  // Prove restored default privileges affect actual creation, using the same
  // nonsuperuser login and SET ROLE identity as the migration runner.
  const migrator = new Pool({ host, port: 55442, user: 'local_migrator', database: process.argv[2] ?? 'dispatch' });
  const creator = await migrator.connect();
  try {
    await creator.query('BEGIN'); await creator.query('SET LOCAL ROLE dispatch_migrator');
    assert.deepEqual((await creator.query('SELECT current_user,session_user')).rows[0],
      { current_user: 'dispatch_migrator', session_user: 'local_migrator' });
    const defaults = (await creator.query(`SELECT EXISTS(SELECT 1 FROM aclexplode(defaclacl)
      WHERE grantee=0 AND privilege_type='EXECUTE') public_execute
      FROM pg_default_acl WHERE defaclrole=current_user::regrole AND defaclnamespace=0 AND defaclobjtype='f'`)).rows;
    assert.deepEqual(defaults, [{ public_execute: false }]);
    await creator.query('CREATE FUNCTION dispatch.acl_recovery_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
    for (const role of roles)
      assert.equal((await creator.query("SELECT has_function_privilege($1,'dispatch.acl_recovery_probe()','EXECUTE') ok", [role])).rows[0].ok, false);
    assert.equal((await creator.query('SELECT dispatch.acl_recovery_probe() value')).rows[0].value, 1);
  } finally { await creator.query('ROLLBACK'); creator.release(); await migrator.end(); }
  process.stdout.write(JSON.stringify({ table_hashes: hashes, fixture_key_and_assets: 'verified', payments_ready: false,
    migration_checksums: 'verified', function_acls: functionAcls, effective_service_execute: false,
    migrator_future_function: 'denied_to_services' }) + '\n');
} finally { await pool.end(); }
