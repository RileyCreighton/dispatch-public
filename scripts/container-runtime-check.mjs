// Disposable foundation container probe, maintained for the nine numbered migrations.
// No provider, payment or production input.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { localPool } from './dist/packages/db/src/config.js';
import { foundationReady } from './dist/packages/db/src/index.js';
const service = process.argv[1];
assert.ok(['api', 'worker', 'migrator'].includes(service));
assert.equal(process.version, 'v24.21.0');
assert.equal(process.getuid(), 1000);
const pool = localPool(service);
const client = await pool.connect();
try {
  const identity = (await client.query(`SELECT current_user,session_user,rolsuper,rolcreatedb,
    rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.equal(identity.current_user, `local_${service}`);
  assert.equal(identity.session_user, `local_${service}`);
  for (const key of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'])
    assert.equal(identity[key], false);
  assert.equal((await client.query("SELECT current_setting('server_version') AS version")).rows[0].version.split(' ')[0], '17.11');
  assert.equal((await client.query('SELECT pg_has_role(current_user,$1,$2) ok', [`dispatch_${service}`, 'MEMBER'])).rows[0].ok, true);
  if (service === 'migrator') {
    await client.query('SET ROLE dispatch_migrator');
    assert.equal((await client.query('SELECT current_user')).rows[0].current_user, 'dispatch_migrator');
  }
  const files = (await readdir('db/migrations')).filter(x => /^\d{3}_[a-z_]+\.sql$/.test(x)).sort();
  assert.equal(files.length, 9);
  const expected = await Promise.all(files.map(async name => ({ name,
    sha256: createHash('sha256').update(await readFile(`db/migrations/${name}`)).digest('hex') })));
  const installed = (await client.query('SELECT name,sha256 FROM dispatch.schema_migrations ORDER BY name')).rows;
  assert.deepEqual(installed, expected);
  assert.equal(await foundationReady(client), true);
  const control = (await client.query('SELECT payment_paused,mainnet_enabled,physical_enabled,config_id FROM dispatch.merchant_control')).rows;
  assert.deepEqual(control, [{ payment_paused: true, mainnet_enabled: false, physical_enabled: false, config_id: null }]);
  for (const table of ['orders', 'merchant_config_versions']) {
    // Table identifiers come exclusively from this literal allowlist.
    assert.equal((await client.query(`SELECT count(*) n FROM dispatch.${table}`)).rows[0].n, '0');
  }
  if (service !== 'migrator') {
    for (const [query, values] of [
      ["SELECT has_schema_privilege(current_user,'dispatch','CREATE') ok", []],
      ["SELECT has_database_privilege(current_user,current_database(),'TEMP') ok", []],
      ["SELECT pg_has_role(current_user,'dispatch_migrator','MEMBER') ok", []],
      ["SELECT has_table_privilege(current_user,'dispatch.schema_migrations','INSERT') ok", []],
    ]) assert.equal((await client.query(query, values)).rows[0].ok, false);
    const functions = (await client.query(`SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='dispatch'`)).rows;
    assert.ok(functions.length >= 8);
    for (const fn of functions)
      assert.equal((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') ok", [fn.oid])).rows[0].ok, false);
    for (const query of [
      'CREATE TABLE dispatch.container_forbidden(id integer)',
      'CREATE TEMP TABLE container_forbidden(id integer)',
      'SET ROLE dispatch_migrator',
      'DELETE FROM dispatch.schema_migrations',
      'SELECT dispatch.protect_session_identity()',
      'SELECT * FROM dispatch.operator_sessions',
    ]) {
      await client.query('BEGIN');
      let code;
      try { await client.query(query); } catch (error) { code = error.code; }
      finally { await client.query('ROLLBACK'); }
      assert.equal(code, '42501', 'expected actual permission denial');
    }
  }
  process.stdout.write(JSON.stringify({ service, identity, migration_checksums: installed,
    role_checks: 'passed', foundation_ready: true, payments_ready: false }) + '\n');
} finally {
  client.release(true);
  await pool.end();
}
