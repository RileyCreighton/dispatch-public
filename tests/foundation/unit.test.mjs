import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicAmount, UINT256_MAX } from '../../dist/packages/domain/src/index.js';
import { supportSnapshot, PUBLIC_CONFIG } from '../../dist/packages/contracts/src/index.js';
import { seal, unseal, safeLog } from '../../dist/packages/security/src/index.js';
for (const invalid of ['-1', '1.0', '1e3', '+1', '01', '', ' 1', Number.MAX_SAFE_INTEGER, (UINT256_MAX + 1n).toString()]) {
  test(`atomic amount rejects ${String(invalid).slice(0, 20)}`, () => assert.throws(() => atomicAmount(invalid)));
}
test('atomic amount exact boundaries without float rounding', () => {
  assert.equal(atomicAmount('0'), 0n); assert.equal(atomicAmount(UINT256_MAX.toString()), UINT256_MAX);
});
test('authenticated encryption binds row/key id and uses fresh IVs', () => {
  const key = randomBytes(32), data = Buffer.from('SYNTHETIC-SECRET-CANARY');
  const a = seal(data, key, 'fixture-key', 'order-1'), b = seal(data, key, 'fixture-key', 'order-1');
  assert.notDeepEqual(a.iv, b.iv); assert.ok(!a.ciphertext.includes(data));
  assert.deepEqual(unseal(a, key, 'order-1'), data);
  assert.throws(() => unseal(a, key, 'order-2')); assert.throws(() => unseal(a, randomBytes(32), 'order-1'));
  assert.throws(() => unseal({ ...a, keyId: 'other' }, key, 'order-1'));
  const changed = Buffer.from(a.ciphertext); changed[0] ^= 1;
  assert.throws(() => unseal({ ...a, ciphertext: changed }, key, 'order-1'));
});
test('safe logging cannot serialize request bodies, exceptions or arbitrary codes', () => {
  const lines = []; const canary = 'SYNTHETIC-PII-TOKEN';
  safeLog(x => lines.push(x), 'request', 400, { authorization: canary });
  assert.throws(() => safeLog(x => lines.push(x), canary));
  assert.equal(lines.join(''), '{"code":"request","status":400}\n');
});
test('snapshot rejects stale, future, extra fields, unsupported kinds and wrong provider', () => {
  const now = Date.now(), origin = 'https://fixture.invalid';
  const valid = { provider_origin: origin, fetched_at: now, expires_at: now + 1000,
    supported_kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] };
  assert.deepEqual(supportSnapshot(valid, origin, now), valid);
  for (const bad of [{ ...valid, expires_at: now }, { ...valid, fetched_at: now + 1 },
    { ...valid, expires_at: now + 300001 }, { ...valid, secret: 'CANARY' },
    { ...valid, provider_origin: 'https://other.invalid' }, { ...valid, supported_kinds: [] }])
    assert.throws(() => supportSnapshot(bad, origin, now));
});
test('browser-safe contracts contain only public constants and no server imports', async () => {
  const source = await readFile('dist/packages/contracts/src/index.js', 'utf8');
  assert.ok(!/from ['"]|process\.|require\(/.test(source));
  assert.deepEqual(Object.keys(PUBLIC_CONFIG).sort(), ['asset', 'chain_id', 'decimals', 'network', 'payments_enabled', 'physical_enabled']);
  assert.equal(PUBLIC_CONFIG.payments_enabled, false);
});
test('HTTP error vocabulary conforms to the preserved OpenAPI contract', async () => {
  const { safeError } = await import('../../dist/packages/contracts/src/index.js');
  const source = await readFile('docs/architecture/openapi.yaml', 'utf8');
  const codes = source.split('    Error:\n')[1].split('        message:\n')[0];
  const actions = source.split('    NextAction:\n')[1].split('    Error:\n')[0];
  for (const code of ['INVALID_INPUT', 'FORBIDDEN', 'NOT_FOUND', 'NOT_READY', 'RATE_LIMITED']) {
    const error = safeError(code, '00000000-0000-4000-8000-000000000000');
    assert.ok(codes.includes('- ' + error.code + '\n'));
    assert.ok(actions.includes('- ' + error.next_action + '\n'));
    assert.ok(error.message.length <= 240);
  }
});
