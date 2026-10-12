import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrate } from '../../dist/packages/db/src/migrate.js';
import { localPool } from '../../dist/packages/db/src/config.js';
import { foundationReady, rateLimit, loadSupport } from '../../dist/packages/db/src/index.js';
import { refreshSupport } from '../../dist/apps/worker/src/support.js';
import { seal } from '../../dist/packages/security/src/index.js';
import { apiServer } from '../../dist/apps/api/src/app.js';
const host = process.env.DISPATCH_DB_HOST;
assert.match(host, /^\/tmp\/dispatch-b2-/);
const pools = new Map();
function pool(role, database = 'dispatch') {
  const key = role + database;
  if (!pools.has(key)) pools.set(key, new Pool({ host, port: 55442, user: role, database,
    password: '', max: 5, options: '-c search_path=dispatch,pg_catalog', statement_timeout: 5000 }));
  return pools.get(key);
}
const admin = pool('fixture_admin'), api = pool('local_api'), worker = pool('local_worker'), operator = pool('local_operator');
test.after(async () => { for (const p of pools.values()) await p.end(); });
const hash = x => '0x' + createHash('sha256').update(x).digest('hex');
const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payee = '0x' + '22'.repeat(20);
async function insert(p, table, fields) {
  const names = Object.keys(fields);
  return p.query(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_, i) => '$' + (i + 1)).join(',')})`, Object.values(fields));
}
async function fixture(database = 'dispatch') {
  const admin = pool('fixture_admin', database), api = pool('local_api', database), operator = pool('local_operator', database);
  const id = { config: randomUUID(), asset: randomUUID(), product: randomUUID(), order: randomUUID(),
    quote: randomUUID(), attempt: randomUUID(), job: randomUUID(), owner: randomUUID(), reservation: randomUUID() };
  const version = Number((await admin.query('SELECT COALESCE(max(version),0)+1 AS v FROM merchant_config_versions')).rows[0].v);
  await insert(operator, 'merchant_config_versions', { id: id.config, version, merchant_id: 'single', pay_origin: 'https://fixture.invalid',
    merchant_name: 'Fixture', payee, chain_id: 8453, network: 'eip155:8453', token, decimals: 6,
    policy_version: 'fixture', policy_urls: '{}', finality_policy: 'safe' });
  await insert(operator, 'asset_versions', { id: id.asset, manifest_sha256: hash('fixture-manifest'), file_sha256: hash('fixture-asset'),
    private_relative_path: 'fixture.txt', mime_type: 'text/plain', download_name: 'fixture.txt', size_bytes: 13 });
  await insert(operator, 'products', { product_id: id.product, version: 1, title: 'Fixture', description: 'synthetic only', kind: 'digital',
    asset_id: id.asset, unit_amount: '1', tax_status: 'merchant_attested_zero', tax_source: 'fixture', tax_version: '1', policy_version: 'fixture' });
  await insert(api, 'orders', { id: id.order, config_id: id.config, product_id: id.product, product_version: 1 });
  await insert(api, 'reservations', { id: id.reservation, order_id: id.order, operation_id: randomUUID(), mode: 'dedicated',
    state: 'reserved', expires_at: new Date(Date.now() + 60000) });
  await insert(api, 'quotes', { id: id.quote, order_id: id.order, version: 1, config_id: id.config, product_id: id.product,
    product_version: 1, quantity: 1, unit_amount: '1', tax_amount: '0', shipping_amount: '0', total: '1',
    network: 'eip155:8453', token, payee, tax_status: 'merchant_attested_zero', tax_source: 'fixture', tax_version: '1',
    shipping_source: 'none', policy_version: 'fixture', inputs_hash: hash(id.order), quote_hash: hash(id.quote),
    reservation_id: id.reservation, expires_at: new Date(Date.now() + 60000) });
  const encrypted = seal(Buffer.from('SYNTHETIC-AUTHORIZATION'), await readFile(host + '/fixture.key'), 'fixture-key', id.attempt);
  const attempt = { id: id.attempt, order_id: id.order, quote_id: id.quote, network: 'eip155:8453', token,
    authorizer: '0x' + '33'.repeat(20), payee, amount: '1', nonce: hash(id.attempt), typed_digest: hash('digest'),
    request_fingerprint: hash('fingerprint'), operation_id: randomUUID(), requirements: '{}', valid_after: '0', valid_before: '9999999999',
    authorization_ciphertext: encrypted.ciphertext, authz_key_id: encrypted.keyId, authz_iv: encrypted.iv, authz_tag: encrypted.tag,
    preaccept_block: 100, preaccept_hash: hash('block100'), preaccept_chain_time: new Date(), preaccept_observed_at: new Date(),
    submit_start_block: 100, submit_started_at: new Date(), state: 'pending' };
  await insert(api, 'payment_attempts', attempt);
  await insert(api, 'outbox_jobs', { id: id.job, order_id: id.order, attempt_id: id.attempt, effect_type: 'submit', effect_version: 1,
    effect_key: id.job, payload_reference: id.attempt, state: 'leased', lease_owner: id.owner,
    lease_until: new Date(Date.now() + 60000), fence: 1 });
  await api.query(`INSERT INTO spend_budgets(merchant_id,utc_day,gross_reserved,cap) VALUES('single',current_date,1,10000000)
    ON CONFLICT(merchant_id,utc_day) DO UPDATE SET gross_reserved=spend_budgets.gross_reserved+1`);
  await insert(api, 'budget_allocations', { attempt_id: id.attempt, merchant_id: 'single', utc_day: new Date(), amount: '1' });
  return { ...id, attemptData: attempt };
}
let f;
test('clean install and concurrent migration runners use advisory lock; defaults stay paused with zero config/order', async () => {
  await Promise.all([migrate(pool('local_migrator')), migrate(pool('local_migrator'))]);
  assert.equal(await foundationReady(api), true);
  const control = (await api.query('SELECT * FROM merchant_control')).rows[0];
  assert.equal(control.mainnet_enabled, false); assert.equal(control.payment_paused, true); assert.equal(control.physical_enabled, false);
  assert.equal(control.config_id, null); assert.equal(control.version, '0');
  for (const table of ['orders', 'merchant_config_versions']) assert.equal((await admin.query(`SELECT count(*) n FROM ${table}`)).rows[0].n, '0');
});
test('001 to 002 forward upgrade retains pending authorization and exposure', async () => {
  const p = pool('local_migrator', 'upgrade'); await migrate(p, undefined, '001_reviewed_schema.sql');
  const a = pool('fixture_admin', 'upgrade');
  const pending = await fixture('upgrade');
  await a.query(`INSERT INTO dispatch.abuse_counters VALUES ($1,now(),7)`, [hash('upgrade-sentinel')]);
  await migrate(p, undefined, '002_local_foundation.sql');
  await migrate(p, undefined, '002_local_foundation.sql');
  assert.equal((await a.query('SELECT state FROM payment_attempts WHERE id=$1', [pending.attempt])).rows[0].state, 'pending');
  assert.equal((await a.query('SELECT gross_reserved FROM spend_budgets')).rows[0].gross_reserved, '1');
  assert.equal((await a.query('SELECT count FROM abuse_counters')).rows[0].count, 7);
  assert.equal((await a.query('SELECT count(*) n FROM schema_migrations')).rows[0].n, '2');
});
test('migration checksum drift and missing history reject without rerunning SQL', async () => {
  const temp = await mkdtemp('/tmp/dispatch-b2-migrations-');
  try {
    await cp('db/migrations', temp, { recursive: true });
    await writeFile(temp + '/001_reviewed_schema.sql', '-- changed\n');
    await assert.rejects(migrate(pool('local_migrator'), temp), /checksum/);
    await rm(temp + '/001_reviewed_schema.sql');
    await assert.rejects(migrate(pool('local_migrator'), temp), /history/);
  } finally { await rm(temp, { recursive: true }); }
});
test('failed forward migration rolls back DDL and history', async () => {
  const temp = await mkdtemp('/tmp/dispatch-b2-migrations-');
  try {
    await cp('db/migrations', temp, { recursive: true });
    await writeFile(temp + '/010_failure.sql', 'CREATE TABLE should_rollback(id int); SELECT 1/0;\n');
    await assert.rejects(migrate(pool('local_migrator'), temp), { code: '22012' });
    assert.equal((await admin.query("SELECT to_regclass('dispatch.should_rollback') AS t")).rows[0].t, null);
    assert.equal((await admin.query('SELECT count(*) n FROM schema_migrations')).rows[0].n, '9');
  } finally { await rm(temp, { recursive: true }); }
});
test('actual service role attributes and escalation/DDL denial', async () => {
  for (const role of ['local_api', 'local_worker', 'local_operator', 'local_migrator']) {
    const row = (await pool(role).query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(row, { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  }
  for (const p of [api, worker, operator]) {
    await assert.rejects(p.query('SET ROLE dispatch_migrator'), { code: '42501' });
    await assert.rejects(p.query('CREATE TABLE dispatch.forbidden(id int)'), { code: '42501' });
    await assert.rejects(p.query('CREATE TABLE public.forbidden(id int)'), { code: '42501' });
    await assert.rejects(p.query('CREATE TEMP TABLE forbidden(id int)'), { code: '42501' });
    await assert.rejects(p.query('UPDATE schema_migrations SET sha256=sha256'), { code: '42501' });
  }
  await assert.rejects(api.query('SET ROLE dispatch_operator'), { code: '42501' });
  await assert.rejects(worker.query('SELECT * FROM operator_sessions'), { code: '42501' });
  await assert.rejects(operator.query('SELECT authorization_ciphertext FROM payment_attempts'), { code: '42501' });
});
for (const value of ['-1', '1.1', 'NaN', 'Infinity', '115792089237316195423570985008687907853269984665640564039457584007913129639936'])
  test(`PostgreSQL exact numeric rejects ${value.slice(0, 20)}`, async () => {
    await assert.rejects(api.query('SELECT $1::atomic_amount', [value]), { code: '23514' });
  });
test('PostgreSQL accepts full uint256 maximum without rounding', async () => {
  const n = ((1n << 256n) - 1n).toString(); assert.equal((await api.query('SELECT $1::atomic_amount n', [n])).rows[0].n, n);
});
test('seed synthetic pending purchase using actual roles', async () => { f = await fixture(); });
test('immutable authorization/order/quote and cross-FKs reject reassignment', async () => {
  for (const [table, field, value, id] of [['payment_attempts', 'nonce', hash('new'), f.attempt],
    ['payment_attempts', 'preaccept_block', 0, f.attempt], ['orders', 'config_id', randomUUID(), f.order], ['quotes', 'total', '2', f.quote]])
    await assert.rejects(api.query(`UPDATE ${table} SET ${field}=$1 WHERE id=$2`, [value, id]));
  const spare = randomUUID(), quote = randomUUID();
  await insert(api, 'orders', { id: spare, config_id: f.config, product_id: f.product, product_version: 1 });
  const q = (await api.query('SELECT * FROM quotes WHERE id=$1', [f.quote])).rows[0];
  await insert(api, 'quotes', { ...q, id: quote, order_id: spare, quote_hash: hash(quote), reservation_id: null });
  const candidate = { ...f.attemptData, order_id: spare, quote_id: quote, id: randomUUID(), operation_id: randomUUID(), nonce: hash('cross') };
  await assert.rejects(insert(api, 'payment_attempts', { ...candidate, quote_id: randomUUID() }), { code: '23503' });
  await assert.rejects(insert(api, 'payment_attempts', { ...candidate, amount: '2' }), { code: '23503' });
  await assert.rejects(insert(api, 'payment_attempts', { ...f.attemptData, id: randomUUID(), operation_id: randomUUID(), nonce: hash('duplicate-order') }), { code: '23505' });
  await assert.rejects(api.query("UPDATE payment_attempts SET valid_before='1.5' WHERE id=$1", [f.attempt]));
});
test('conservative exposure cannot be released by direct app-role writes', async () => {
  const before = (await api.query('SELECT gross_reserved FROM spend_budgets')).rows;
  for (const p of [api, worker]) {
    await assert.rejects(p.query('UPDATE spend_budgets SET gross_reserved=0'));
    await assert.rejects(p.query('UPDATE budget_allocations SET released_at=now(),release_evidence=\'{}\''));
    await assert.rejects(p.query("UPDATE payment_attempts SET state='expired_unspent',disposition_evidence='{}' WHERE id=$1", [f.attempt]));
    await assert.rejects(p.query("UPDATE reservations SET state='released',release_evidence='{}' WHERE id=$1", [f.reservation]));
    await assert.rejects(p.query('DELETE FROM payment_attempts WHERE id=$1', [f.attempt]));
  }
  assert.deepEqual((await api.query('SELECT gross_reserved FROM spend_budgets')).rows, before);
  assert.equal((await api.query('SELECT state FROM payment_attempts WHERE id=$1', [f.attempt])).rows[0].state, 'pending');
});
test('concurrent durable initial intent is unique; stale lease, cross-job and retry denied', async () => {
  const fields = { id: randomUUID(), attempt_id: f.attempt, order_id: f.order, operation: 'settle', job_id: f.job, lease_owner: f.owner, fence: 1 };
  await assert.rejects(insert(worker, 'call_intents', { ...fields, lease_owner: randomUUID() }), /invalid_call_lease/);
  await assert.rejects(insert(worker, 'call_intents', { ...fields, call_number: 2 }), { code: '23514' });
  const results = await Promise.allSettled([insert(worker, 'call_intents', fields), insert(worker, 'call_intents', { ...fields, id: randomUUID() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(worker.query('DELETE FROM call_intents'), { code: '42501' });
  await worker.query('UPDATE outbox_jobs SET lease_until=now()-interval \'1 second\' WHERE id=$1', [f.job]);
  await assert.rejects(insert(worker, 'call_intents', { ...fields, id: randomUUID(), operation: 'verify' }), /invalid_call_lease/);
  await worker.query('UPDATE outbox_jobs SET lease_until=now()+interval \'1 minute\',lease_owner=$2,fence=2 WHERE id=$1', [f.job, randomUUID()]);
  await assert.rejects(insert(worker, 'call_intents', { ...fields, id: randomUUID() }));
  assert.equal((await worker.query('SELECT count(*) n FROM call_intents')).rows[0].n, '1');
  assert.equal((await worker.query('SELECT count(*) n FROM settlements')).rows[0].n, '0');
});
test('API cannot credit settlements, write provider snapshot or change controls; operator cannot enable mainnet', async () => {
  await assert.rejects(api.query('INSERT INTO settlements(id) VALUES($1)', [randomUUID()]), { code: '42501' });
  await assert.rejects(api.query('INSERT INTO provider_capability_snapshots(id) VALUES($1)', [randomUUID()]), { code: '42501' });
  for (const p of [api, worker, operator]) await assert.rejects(p.query('UPDATE merchant_control SET mainnet_enabled=true'), { code: '42501' });
  await assert.rejects(admin.query('UPDATE merchant_control SET mainnet_enabled=true'), { code: '23514' });
  assert.equal((await api.query('SELECT mainnet_enabled FROM merchant_control')).rows[0].mainnet_enabled, false);
});
test('provider adapter work occurs outside transaction; snapshot roundtrip and API mutation denial', async () => {
  const origin = 'https://fixture.invalid', now = Date.now();
  const provider = { origin, async getSupported() {
    assert.equal((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname='dispatch' AND state='idle in transaction'")).rows[0].n, '0');
    return { provider_origin: origin, fetched_at: now, expires_at: now + 1000, supported_kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] };
  } };
  await refreshSupport(worker, provider);
  assert.equal((await loadSupport(api, origin, now)).provider_origin, origin);
  await assert.rejects(loadSupport(api, origin, now + 2000), /stale_snapshot/);
  await assert.rejects(refreshSupport(api, provider), { code: '42501' });
  await assert.rejects(worker.query('UPDATE provider_capability_snapshots SET expires_at=now()'), { code: '42501' });
});
test('durable rate counters atomically cap concurrent requests', async () => {
  const identity = randomUUID(); const results = await Promise.all(Array.from({ length: 30 }, () => rateLimit(api, identity, 7)));
  assert.equal(results.filter(Boolean).length, 7);
  assert.equal((await api.query('SELECT count FROM abuse_counters WHERE bucket_hash=$1', [hash(identity)])).rows[0].count, 7);
});
test('health, host/origin, body/header bounds and secret canaries through actual HTTP', async () => {
  const logs = [], canary = 'SYNTHETIC-HEADER-BODY-PII-CANARY';
  const server = apiServer(api, 'http://127.0.0.1:3000', x => logs.push(x));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const send = (path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1:3000', ...headers } }, res => {
      let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('fixture_request_timeout'))); req.end(body);
  });
  try {
    assert.equal((await send('/health/live')).status, 200);
    assert.equal((await send('/health/ready')).status, 503);
    for (const [path, headers, method, body, expected] of [
      ['/health/live?token=' + canary, {}, 'GET', undefined, 400],
      ['/health/live', { host: 'evil.invalid' }, 'GET', undefined, 400],
      ['/health/live', { origin: 'https://evil.invalid' }, 'GET', undefined, 400],
      ['/v1/operator/config', {}, 'POST', undefined, 403],
      ['/v1/operator/config', { origin: 'http://127.0.0.1:3000' }, 'POST', undefined, 404],
      ['/v1/checkouts', { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, 'POST', '{' + canary, 400],
      ['/health/live', { authorization: canary, cookie: canary }, 'GET', undefined, 200],
      ['/health/live', { authorization: canary.repeat(1000) }, 'GET', undefined, 400],
      ['/v1/checkouts', { origin: 'http://127.0.0.1:3000', 'content-length': '16385' }, 'POST', '', 400]]) {
      const result = await send(path, headers, method, body); assert.equal(result.status, expected);
      assert.ok(!result.text.includes(canary)); assert.ok(!result.text.includes('stack'));
    }
    assert.ok(!logs.join('').includes(canary));
    const broken = new Pool({ host, port: 55442, user: 'nonexistent', database: 'dispatch' });
    const down = apiServer(broken, 'http://127.0.0.1:3000', x => logs.push(x)); down.listen(0, '127.0.0.1'); await once(down, 'listening');
    try {
      const result = await new Promise((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: down.address().port, path: '/health/ready', headers: { host: '127.0.0.1:3000' } }, res => {
          let text = ''; res.on('data', b => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, text }));
        }); req.on('error', reject); req.setTimeout(3000, () => req.destroy()); req.end();
      });
      assert.equal(result.status, 503); assert.ok(!result.text.includes('nonexistent'));
    } finally { down.closeAllConnections(); await new Promise(resolve => down.close(resolve)); await broken.end(); }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('API and worker entrypoints boot as separate local processes; readiness stays false', async () => {
  const probe = apiServer(api, 'http://127.0.0.1:3000', () => {}); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { PATH: process.env.PATH, DISPATCH_MODE: 'local', DISPATCH_DB_HOST: host,
    DISPATCH_DB_PORT: '55442', DISPATCH_PORT: String(port), DISPATCH_ORIGIN: `http://127.0.0.1:${port}` };
  const child = spawn(process.execPath, ['dist/apps/api/src/main.js'], { env });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  try {
    for (let i = 0; i < 50 && !output.includes('started'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(output, /started/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 503);
    for (let i = 0; i < 2; i++) {
      const w = spawn(process.execPath, ['dist/apps/worker/src/main.js'], { env: { ...env, DISPATCH_WORKER_ONCE: '1' } });
      let logs = ''; w.stdout.on('data', b => { logs += b; }); w.stderr.on('data', b => { logs += b; });
      const [code] = await once(w, 'exit'); assert.equal(code, 0); assert.ok(!logs.includes('dependency_unavailable'));
      assert.match(logs, /started/); assert.match(logs, /stopped/);
    }
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});
test('dead database writer rolls back uncommitted mutation and committed intent survives process restart', async () => {
  const before = (await api.query('SELECT count FROM abuse_counters ORDER BY bucket_hash')).rows;
  const child = spawn(process.execPath, ['scripts/crash-db-writer.mjs'], { env: {
    PATH: process.env.PATH, DISPATCH_MODE: 'local', DISPATCH_DB_HOST: host, DISPATCH_DB_PORT: '55442' } });
  let output = ''; child.stdout.on('data', b => { output += b; });
  try {
    for (let i = 0; i < 100 && !output.includes('uncommitted'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(output, /uncommitted/);
  } finally { child.kill('SIGKILL'); await once(child, 'exit'); }
  assert.deepEqual((await api.query('SELECT count FROM abuse_counters ORDER BY bucket_hash')).rows, before);
  assert.equal((await worker.query('SELECT count(*) n FROM call_intents')).rows[0].n, '1');
});
test('agent grant races cannot acquire two orders or change session kind', async () => {
  const session = randomUUID();
  await insert(api, 'buyer_sessions', { id: session, capability_hash: hash(session), kind: 'agent', expires_at: new Date(Date.now() + 60000) });
  const orders = (await api.query('SELECT id FROM orders ORDER BY id')).rows;
  const results = await Promise.allSettled(orders.map(o => insert(api, 'buyer_grants', { session_id: session, order_id: o.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(api.query("UPDATE buyer_sessions SET kind='browser' WHERE id=$1", [session]), /immutable_session_identity/);
  await assert.rejects(api.query('UPDATE buyer_grants SET order_id=$1 WHERE session_id=$2', [f.order, session]), { code: '42501' });
});
test('database error detail does not log synthetic private row data', async () => {
  await assert.rejects(insert(api, 'buyer_sessions', { id: randomUUID(), capability_hash: hash('db-canary'),
    kind: 'SYNTHETIC-DB-ERROR-CANARY', expires_at: new Date(Date.now() + 60000) }), { code: '23514' });
});
test('record complete effective table privilege inventory for all actual service logins', async t => {
  const result = await admin.query(`SELECT r.rolname,c.relname,
    has_table_privilege(r.oid,c.oid,'SELECT') AS select_all,has_table_privilege(r.oid,c.oid,'INSERT') AS insert,
    has_table_privilege(r.oid,c.oid,'UPDATE') AS update_all,has_table_privilege(r.oid,c.oid,'DELETE') AS delete,
    has_table_privilege(r.oid,c.oid,'TRUNCATE') AS truncate
    FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE r.rolname IN ('local_api','local_worker','local_operator','local_migrator')
    AND n.nspname='dispatch' AND c.relkind='r' ORDER BY r.rolname,c.relname`);
  for (const row of result.rows.filter(x => x.rolname !== 'local_migrator')) { assert.equal(row.delete, false); assert.equal(row.truncate, false); }
  await writeFile(process.env.DISPATCH_DB_HOST + '/role-inventory.json', JSON.stringify(result.rows, null, 2) + '\n');
  t.diagnostic(`effective table privilege rows: ${result.rows.length}; narrow column grants additionally exercised`);
});

// CC-B2-001 regressions use the exact runtime pool factories, without search_path overrides.
const runtimeApi = localPool('api'), runtimeWorker = localPool('worker');
pools.set('runtime-api', runtimeApi); pools.set('runtime-worker', runtimeWorker);
async function session(p, kind) {
  const id = randomUUID();
  await p.query(`INSERT INTO dispatch.buyer_sessions(id,capability_hash,kind,expires_at)
    VALUES($1,$2,$3,now()+interval '1 hour')`, [id, hash(id), kind]);
  return id;
}
const grant = (p, id, order) => p.query('INSERT INTO dispatch.buyer_grants(session_id,order_id) VALUES($1,$2)', [id, order]);
async function grants(p, id) {
  return (await p.query('SELECT order_id FROM dispatch.buyer_grants WHERE session_id=$1 ORDER BY order_id', [id])).rows.map(r => r.order_id);
}
async function orderPair(p) {
  const orders = (await p.query('SELECT id FROM dispatch.orders ORDER BY id LIMIT 2')).rows.map(r => r.id);
  assert.equal(orders.length, 2); return orders;
}
async function grantRace(p, id, orders, isolation, rollbackFirst = false) {
  assert.ok(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].includes(isolation));
  const first = await p.connect(), second = await p.connect(); let pending;
  try {
    const pid1 = (await first.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pid2 = (await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    assert.notEqual(pid1, pid2);
    await first.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await second.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    // Barrier 1: both snapshots observe the same session before either write.
    const observed = await Promise.all([first, second].map(c => c.query('SELECT id FROM dispatch.buyer_sessions WHERE id=$1', [id])));
    assert.ok(observed.every(r => r.rowCount === 1));
    await grant(first, id, orders[0]); // Positive control: the first write must succeed.
    pending = grant(second, id, orders[1]).then(() => ({ accepted: true }), e => ({ accepted: false, code: e.code }));
    // Barrier 2: prove the second backend is waiting for the first transaction.
    // No sleep-based race assumption; all operations also have bounded statement timeouts.
    const deadline = Date.now() + 2000; let blocked = false;
    while (Date.now() < deadline) {
      blocked = (await admin.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) blocked', [pid1, pid2])).rows[0].blocked;
      if (blocked) break;
    }
    assert.equal(blocked, true, 'second grant must be blocked behind the first before resolution');
    await first.query(rollbackFirst ? 'ROLLBACK' : 'COMMIT');
    const result = await pending;
    await second.query(result.accepted ? 'COMMIT' : 'ROLLBACK');
    return result;
  } finally {
    await first.query('ROLLBACK');
    if (pending) await pending;
    await second.query('ROLLBACK'); first.release(); second.release();
  }
}

test('003 runtime pools permit grants, preserve same-order duplicates and browser multi-order behavior', async () => {
  assert.equal((await runtimeApi.query('SHOW search_path')).rows[0].search_path, '"$user", public');
  const orders = await orderPair(runtimeApi);
  for (const kind of ['agent', 'recovery']) {
    const id = await session(runtimeApi, kind);
    await grant(runtimeApi, id, orders[0]);
    assert.deepEqual(await grants(runtimeApi, id), [orders[0]]);
    await assert.rejects(grant(runtimeApi, id, orders[0]), { code: '23505' });
    await assert.rejects(grant(runtimeApi, id, orders[1]), /single_order_grant/);
    assert.equal((await runtimeApi.query('SELECT bound_order_id FROM dispatch.buyer_sessions WHERE id=$1', [id])).rows[0].bound_order_id, orders[0]);
  }
  const browser = await session(runtimeApi, 'browser');
  await Promise.all(orders.map(o => grant(runtimeApi, browser, o)));
  assert.deepEqual(await grants(runtimeApi, browser), orders);
  assert.equal((await runtimeApi.query('SELECT bound_order_id FROM dispatch.buyer_sessions WHERE id=$1', [browser])).rows[0].bound_order_id, null);
});

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
  for (const kind of ['agent', 'recovery']) {
    test(`003 coordinated ${isolation} ${kind} race commits exactly one order`, async t => {
      const id = await session(runtimeApi, kind), orders = await orderPair(runtimeApi);
      const result = await grantRace(runtimeApi, id, orders, isolation);
      assert.equal(result.accepted, false);
      assert.equal(result.code, isolation === 'READ COMMITTED' ? 'P0001' : '40001');
      assert.deepEqual(await grants(runtimeApi, id), [orders[0]]);
      t.diagnostic(JSON.stringify({ isolation, kind, second: result, durable_grants: 1 }));
    });
  }
  test(`003 coordinated ${isolation} rollback releases first binding to the competitor`, async () => {
    const id = await session(runtimeApi, 'recovery'), orders = await orderPair(runtimeApi);
    assert.deepEqual(await grantRace(runtimeApi, id, orders, isolation, true), { accepted: true });
    assert.deepEqual(await grants(runtimeApi, id), [orders[1]]);
    assert.equal((await runtimeApi.query('SELECT bound_order_id FROM dispatch.buyer_sessions WHERE id=$1', [id])).rows[0].bound_order_id, orders[1]);
  });
}

test('003 concurrent same-order grant is still one grant with unique-key duplicate rejection', async () => {
  const id = await session(runtimeApi, 'agent'), orders = await orderPair(runtimeApi);
  const result = await grantRace(runtimeApi, id, [orders[0], orders[0]], 'READ COMMITTED');
  assert.deepEqual(result, { accepted: false, code: '23505' });
  assert.deepEqual(await grants(runtimeApi, id), [orders[0]]);
});

test('003 direct service-role paths cannot rebind session identity or restricted order', async () => {
  const id = await session(runtimeApi, 'agent'), orders = await orderPair(runtimeApi);
  await grant(runtimeApi, id, orders[0]);
  for (const [field, value, error] of [['kind', 'browser', 'immutable_session_identity'],
    ['id', randomUUID(), 'immutable_session_identity'], ['capability_hash', hash('changed'), 'immutable_session_identity'],
    ['bound_order_id', orders[1], 'immutable_session_order_binding'], ['bound_order_id', null, 'immutable_session_order_binding']]) {
    await assert.rejects(runtimeApi.query(`UPDATE dispatch.buyer_sessions SET ${field}=$1 WHERE id=$2`, [value, id]), new RegExp(error));
  }
  await assert.rejects(runtimeApi.query('UPDATE dispatch.buyer_grants SET order_id=$1 WHERE session_id=$2', [orders[1], id]), { code: '42501' });
  await assert.rejects(runtimeApi.query('DELETE FROM dispatch.buyer_grants WHERE session_id=$1', [id]), { code: '42501' });
  await assert.rejects(runtimeApi.query('DELETE FROM dispatch.buyer_sessions WHERE id=$1', [id]), { code: '42501' });
  const prebound = await session(runtimeApi, 'recovery');
  await runtimeApi.query('UPDATE dispatch.buyer_sessions SET bound_order_id=$1 WHERE id=$2', [orders[0], prebound]);
  await assert.rejects(grant(runtimeApi, prebound, orders[1]), /single_order_grant/);
  await grant(runtimeApi, prebound, orders[0]);
  const browser = await session(runtimeApi, 'browser');
  await assert.rejects(runtimeApi.query('UPDATE dispatch.buyer_sessions SET bound_order_id=$1 WHERE id=$2', [orders[0], browser]), { code: '23514' });
  const unbound = await session(runtimeApi, 'agent');
  await assert.rejects(grant(runtimeApi, unbound, randomUUID()), { code: '23503' });
  assert.equal((await runtimeApi.query('SELECT bound_order_id FROM dispatch.buyer_sessions WHERE id=$1', [unbound])).rows[0].bound_order_id, null);
  await grant(runtimeApi, unbound, orders[0]);
  for (const p of [runtimeWorker, operator]) {
    await assert.rejects(grant(p, browser, orders[0]), { code: '42501' });
    await assert.rejects(p.query('UPDATE dispatch.buyer_sessions SET bound_order_id=NULL WHERE id=$1', [id]), { code: '42501' });
  }
});

test('003 runtime call-intent positive control and lease/retry/role denials', async () => {
  const c = await runtimeWorker.connect();
  try {
    await c.query('BEGIN');
    const j = (await c.query("UPDATE dispatch.outbox_jobs SET lease_until=now()+interval '1 minute' WHERE id=$1 RETURNING *", [f.job])).rows[0];
    const claim = (p, overrides = {}) => insert(p, 'dispatch.call_intents', {
      id: randomUUID(), attempt_id: f.attempt, order_id: f.order, operation: 'verify', job_id: j.id,
      lease_owner: j.lease_owner, fence: j.fence, ...overrides });
    async function denied(overrides, expected) {
      await c.query('SAVEPOINT negative');
      await assert.rejects(claim(c, overrides), expected);
      await c.query('ROLLBACK TO SAVEPOINT negative');
    }
    await denied({ lease_owner: randomUUID() }, /invalid_call_lease/);
    await denied({ fence: Number(j.fence) - 1 }, /invalid_call_lease/);
    await denied({ job_id: randomUUID() }, /invalid_call_lease/);
    await denied({ call_number: 2 }, { code: '23514' });
    await c.query("UPDATE dispatch.outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [j.id]);
    await denied({}, /invalid_call_lease/);
    const owner = randomUUID();
    await c.query("UPDATE dispatch.outbox_jobs SET lease_until=now()+interval '1 minute',lease_owner=$2,fence=fence+1 WHERE id=$1", [j.id, owner]);
    await denied({}, /invalid_call_lease/); // Previous owner/fence after takeover.
    const current = { lease_owner: owner, fence: Number(j.fence) + 1 };
    await claim(c, current);
    await denied(current, { code: '23505' });
    for (const p of [runtimeApi, operator]) await assert.rejects(claim(p, current), { code: '42501' });
    assert.equal((await c.query("SELECT count(*) n FROM dispatch.call_intents WHERE attempt_id=$1 AND operation='verify'", [f.attempt])).rows[0].n, '1');
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('003 other affected triggers retain exact release rejection through runtime pools', async () => {
  for (const p of [runtimeApi, runtimeWorker]) {
    await assert.rejects(p.query("UPDATE dispatch.reservations SET state='released' WHERE id=$1", [f.reservation]), /release_disabled/);
    await assert.rejects(p.query('UPDATE dispatch.spend_budgets SET gross_reserved=0'), /release_disabled/);
    await assert.rejects(p.query("UPDATE dispatch.payment_attempts SET state='expired_unspent',disposition_evidence='{}' WHERE id=$1", [f.attempt]), /release_disabled/);
  }
  await assert.rejects(runtimeApi.query('UPDATE dispatch.orders SET config_id=$1 WHERE id=$2', [randomUUID(), f.order]), /immutable_order_binding/);
});

test('004 invoker functions have trusted local paths and effective CREATE/TEMP/EXECUTE denial', async () => {
  const names = ['check_call_claim', 'check_grant_scope', 'conservative_exposure', 'protect_order_binding', 'protect_session_identity'];
  const functions = (await admin.query(`SELECT p.proname,p.prosecdef,p.proconfig,r.rolname,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='dispatch' AND p.proname=ANY($1)`, [names])).rows;
  assert.equal(functions.length, names.length);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, false); assert.equal(fn.rolname, 'dispatch_migrator');
    assert.equal(fn.public_execute, false); assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, pg_temp']);
  }
  for (const p of [runtimeApi, runtimeWorker, operator]) {
    for (const name of names) {
      assert.equal((await p.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') ok",
        [`dispatch.${name}()`])).rows[0].ok, false);
      await assert.rejects(p.query(`SELECT dispatch.${name}()`), { code: '42501' });
    }
    const r = (await p.query(`SELECT has_schema_privilege(current_user,'dispatch','CREATE') app_create,
      has_schema_privilege(current_user,'public','CREATE') public_create,
      has_database_privilege(current_user,current_database(),'TEMP') temp`)).rows[0];
    assert.deepEqual(r, { app_create: false, public_create: false, temp: false });
    await assert.rejects(p.query('CREATE TEMP TABLE buyer_sessions(id uuid,kind text)'), { code: '42501' });
    await assert.rejects(p.query('ALTER FUNCTION dispatch.check_grant_scope() SECURITY DEFINER'), { code: '42501' });
  }
});

test('003 upgrade backfills legitimate grants and retains pending purchase, intent and history', async () => {
  const p = pool('local_migrator', 'upgrade'), a = pool('fixture_admin', 'upgrade');
  const api = pool('local_api', 'upgrade'), worker = pool('local_worker', 'upgrade');
  assert.equal((await a.query('SELECT count(*) n FROM schema_migrations')).rows[0].n, '2');
  assert.equal(await foundationReady(api), false);
  const order = (await api.query('SELECT * FROM orders LIMIT 1')).rows[0];
  const spare = randomUUID(); await insert(api, 'orders', { id: spare, config_id: order.config_id, product_id: order.product_id, product_version: order.product_version });
  const ids = {};
  for (const kind of ['agent', 'recovery', 'browser']) {
    ids[kind] = await session(api, kind); await grant(api, ids[kind], order.id);
  }
  ids.empty = await session(api, 'agent'); await grant(api, ids.browser, spare);
  const j = (await worker.query('SELECT * FROM outbox_jobs LIMIT 1')).rows[0];
  await insert(worker, 'call_intents', { id: randomUUID(), attempt_id: j.attempt_id, order_id: j.order_id,
    operation: 'settle', job_id: j.id, lease_owner: j.lease_owner, fence: j.fence });
  const retained = ['payment_attempts', 'orders', 'quotes', 'spend_budgets', 'budget_allocations', 'call_intents', 'buyer_grants'];
  const before = {};
  for (const table of retained) before[table] = (await a.query(`SELECT row_to_json(t)::text row FROM dispatch.${table} t ORDER BY row_to_json(t)::text`)).rows;
  const sessionsBefore = (await a.query('SELECT to_jsonb(s) row FROM buyer_sessions s ORDER BY id')).rows;
  const history = (await a.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  await Promise.all([migrate(p, undefined, '003_runtime_binding.sql'), migrate(p, undefined, '003_runtime_binding.sql')]);
  for (const table of retained) assert.deepEqual((await a.query(`SELECT row_to_json(t)::text row FROM dispatch.${table} t ORDER BY row_to_json(t)::text`)).rows, before[table]);
  assert.deepEqual((await a.query("SELECT to_jsonb(s)-'bound_order_id' row FROM buyer_sessions s ORDER BY id")).rows, sessionsBefore);
  assert.deepEqual((await a.query('SELECT * FROM schema_migrations ORDER BY name LIMIT 2')).rows, history);
  for (const kind of ['agent', 'recovery', 'browser', 'empty']) {
    assert.equal((await a.query('SELECT bound_order_id FROM buyer_sessions WHERE id=$1', [ids[kind]])).rows[0].bound_order_id,
      ['agent', 'recovery'].includes(kind) ? order.id : null);
  }
  assert.equal(await foundationReady(api), false); // 004 ACL correction is still required.
  await assert.rejects(grant(api, ids.agent, spare), /single_order_grant/);
});

test('003 conflicting existing restricted grants stop migration without rewriting rows or history', async () => {
  const p = pool('local_migrator', 'conflict'), a = pool('fixture_admin', 'conflict'), api = pool('local_api', 'conflict');
  await migrate(p, undefined, '002_local_foundation.sql');
  const f = await fixture('conflict'), spare = randomUUID();
  await insert(api, 'orders', { id: spare, config_id: f.config, product_id: f.product, product_version: 1 });
  const id = await session(api, 'agent');
  assert.deepEqual(await grantRace(api, id, [f.order, spare], 'REPEATABLE READ'), { accepted: true });
  const before = await grants(api, id); assert.equal(before.length, 2);
  const sessionBefore = (await a.query('SELECT * FROM buyer_sessions WHERE id=$1', [id])).rows;
  const history = (await a.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  await assert.rejects(migrate(p), /restricted_session_grant_conflict/);
  assert.deepEqual(await grants(api, id), before);
  assert.deepEqual((await a.query('SELECT * FROM buyer_sessions WHERE id=$1', [id])).rows, sessionBefore);
  assert.deepEqual((await a.query('SELECT * FROM schema_migrations ORDER BY name')).rows, history);
  assert.equal((await a.query("SELECT count(*) n FROM information_schema.columns WHERE table_schema='dispatch' AND table_name='buyer_sessions' AND column_name='bound_order_id'")).rows[0].n, '0');
});

test('004 forward ACL repair preserves all rows, definitions and old history', async t => {
  const p = pool('local_migrator', 'upgrade'), a = pool('fixture_admin', 'upgrade');
  const api = pool('local_api', 'upgrade');
  const beforeAcl = (await a.query(`SELECT proacl::text,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner)))
      WHERE grantee=0 AND privilege_type='EXECUTE') public_execute,
    has_function_privilege('local_api',oid,'EXECUTE') api_execute
    FROM pg_proc WHERE oid='dispatch.protect_session_identity()'::regprocedure`)).rows[0];
  assert.deepEqual(beforeAcl, { proacl: null, public_execute: true, api_execute: true });
  const tables = (await a.query("SELECT tablename FROM pg_tables WHERE schemaname='dispatch' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const before = {};
  for (const { tablename } of tables) before[tablename] = (await a.query(`SELECT row_to_json(t)::text row FROM dispatch.${tablename} t ORDER BY row_to_json(t)::text`)).rows;
  const history = (await a.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  assert.equal(history.length, 3);
  const definitions = async () => (await a.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='dispatch' ORDER BY p.proname`)).rows;
  const functionsBefore = await definitions();
  await Promise.all([migrate(p, undefined, '005_payment_application.sql'), migrate(p, undefined, '005_payment_application.sql')]);
  await migrate(p, undefined, '005_payment_application.sql'); // Reapplication is a no-op; old checksums/timestamps stay exact.
  for (const { tablename } of tables) assert.deepEqual((await a.query(`SELECT row_to_json(t)::text row FROM dispatch.${tablename} t ORDER BY row_to_json(t)::text`)).rows, before[tablename]);
  assert.deepEqual(await definitions(), functionsBefore);
  const after = (await a.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  assert.deepEqual(after.slice(0, 3), history);
  assert.equal(after.length, 5); assert.equal(after[3].name, '004_function_execute_acl.sql');
  assert.equal(after[3].sha256, createHash('sha256').update(await readFile('db/migrations/004_function_execute_acl.sql')).digest('hex'));
  for (const role of ['dispatch_api', 'dispatch_worker', 'dispatch_operator', 'local_api', 'local_worker', 'local_operator'])
    assert.equal((await a.query("SELECT has_function_privilege($1,'dispatch.protect_session_identity()','EXECUTE') ok", [role])).rows[0].ok, false);
  assert.equal(await foundationReady(api), false); // This historical forward-upgrade fixture stops at 005; current runtime also requires 006.
  // Legitimate trigger-driven binding still succeeds after the forward revoke.
  const id = await session(api, 'agent'), order = (await api.query('SELECT id FROM orders LIMIT 1')).rows[0].id;
  await grant(api, id, order);
  assert.equal((await api.query('SELECT bound_order_id FROM buyer_sessions WHERE id=$1', [id])).rows[0].bound_order_id, order);
  t.diagnostic(JSON.stringify({ beforeAcl, retained_tables: tables.length, history: after }));
});

test('004 global migrator defaults deny disposable functions in two schemas and allow explicit narrow grants', async t => {
  // Only the fixture administrator creates this disposable second schema; no
  // database CREATE/TEMP or runtime schema privilege is added.
  await admin.query('CREATE SCHEMA acl_fixture AUTHORIZATION dispatch_migrator');
  const c = await pool('local_migrator').connect();
  try {
    await c.query('SET ROLE dispatch_migrator');
    assert.deepEqual((await c.query('SELECT current_user,session_user')).rows[0],
      { current_user: 'dispatch_migrator', session_user: 'local_migrator' });
    const defaults = (await c.query(`SELECT d.defaclnamespace,pg_get_userbyid(a.grantee) grantee,a.privilege_type
      FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclrole=current_user::regrole AND d.defaclobjtype='f' AND d.defaclnamespace=0`)).rows;
    assert.deepEqual(defaults, [{ defaclnamespace: 0, grantee: 'dispatch_migrator', privilege_type: 'EXECUTE' }]);
    for (const schema of ['dispatch', 'acl_fixture']) {
      await c.query(`CREATE FUNCTION ${schema}.acl_future_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 7 $$`);
      const signature = `${schema}.acl_future_probe()`;
      const acl = (await c.query(`SELECT pg_get_userbyid(proowner) owner,prosecdef,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner)))
          WHERE grantee=0 AND privilege_type='EXECUTE') public_execute
        FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0];
      assert.deepEqual(acl, { owner: 'dispatch_migrator', prosecdef: false, public_execute: false });
      for (const role of ['dispatch_api', 'dispatch_worker', 'dispatch_operator', 'local_api', 'local_worker', 'local_operator'])
        assert.equal((await c.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, signature])).rows[0].ok, false);
      assert.equal((await c.query(`SELECT ${signature} value`)).rows[0].value, 7);
    }
    for (const p of [runtimeApi, runtimeWorker, operator])
      await assert.rejects(p.query('SELECT dispatch.acl_future_probe()'), { code: '42501' });
    await c.query('GRANT EXECUTE ON FUNCTION dispatch.acl_future_probe() TO dispatch_api');
    assert.equal((await runtimeApi.query('SELECT dispatch.acl_future_probe() value')).rows[0].value, 7);
    for (const p of [runtimeWorker, operator])
      await assert.rejects(p.query('SELECT dispatch.acl_future_probe()'), { code: '42501' });
    await c.query('REVOKE EXECUTE ON FUNCTION dispatch.acl_future_probe() FROM dispatch_api');
    await assert.rejects(runtimeApi.query('SELECT dispatch.acl_future_probe()'), { code: '42501' });
    t.diagnostic(JSON.stringify({ creator: 'dispatch_migrator', login: 'local_migrator', defaults, schemas: ['dispatch', 'acl_fixture'], service_execute: false, narrow_grant_control: 'passed' }));
  } finally {
    await c.query('DROP FUNCTION IF EXISTS dispatch.acl_future_probe()');
    await c.query('DROP FUNCTION IF EXISTS acl_fixture.acl_future_probe()');
    c.release(true);
    await admin.query('DROP SCHEMA acl_fixture');
  }
});

test('006 forward confirmation preserves existing agent access and requires each browser grant confirmation', async () => {
  const a=pool('fixture_admin','upgrade'),p=pool('local_migrator','upgrade');
  await a.query("UPDATE buyer_sessions SET confirmed_at=clock_timestamp() WHERE kind IN ('agent','browser')");
  const before=(await a.query(`SELECT g.session_id,g.order_id,s.kind,s.confirmed_at FROM buyer_grants g JOIN buyer_sessions s ON s.id=g.session_id ORDER BY g.session_id,g.order_id`)).rows;
  assert.ok(before.some(r=>r.kind==='agent'&&r.confirmed_at));assert.ok(before.some(r=>r.kind==='browser'&&r.confirmed_at));
  const history=(await a.query('SELECT * FROM schema_migrations ORDER BY name')).rows;assert.equal(history.length,5);
  await migrate(p);await migrate(p);
  const after=(await a.query(`SELECT g.session_id,g.order_id,s.kind,g.confirmed_at FROM buyer_grants g JOIN buyer_sessions s ON s.id=g.session_id ORDER BY g.session_id,g.order_id`)).rows;
  assert.deepEqual(after,before.map(r=>({...r,confirmed_at:r.kind==='browser'?null:r.confirmed_at})));
  assert.deepEqual((await a.query('SELECT * FROM schema_migrations ORDER BY name LIMIT 5')).rows,history);
  const runtime=pool('local_api','upgrade');
  assert.equal(await foundationReady(runtime),true);
  await runtime.query('UPDATE buyer_grants SET confirmed_at=clock_timestamp() WHERE session_id=$1 AND order_id=$2',[after[0].session_id,after[0].order_id]);
  await assert.rejects(runtime.query('UPDATE buyer_grants SET order_id=order_id'),{code:'42501'});
});
