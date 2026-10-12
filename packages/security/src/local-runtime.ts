import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Deliberately local-only composition. Endpoints cannot be supplied by request,
// database state, environment URLs or a restored configuration.
export const localRuntime = Object.freeze({
  origin: 'https://127.0.0.1:18443', rpc: 'http://127.0.0.1:18546',
  provider: 'https://127.0.0.1:18447', assets: '/private-assets',
});
export function requireLocalRuntime() {
  if (process.env.DISPATCH_MODE !== 'local' || process.env.DISPATCH_RUNTIME !== 'digital-fixture'
    || process.env.DISPATCH_DB_HOST !== 'postgres'
    || ![undefined, 'quarantined'].includes(process.env.DISPATCH_RECOVERY)) throw new Error('local_container_required');
}
export const recoveryFence = () => process.env.DISPATCH_RECOVERY === 'quarantined';
export async function runtimeMaterial(name: 'encryption.key' | 'encryption.sha256' | 'tls.key' | 'tls.crt' | 'webhook.key' | 'webhook.bearer') {
  const file = await open('/run/dispatch/' + name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 16384)
      throw new Error('private_material_required');
    const bytes = await file.readFile();
    if (name.endsWith('.key') && name !== 'tls.key' && bytes.length !== 32) throw new Error('invalid_key');
    if (name === 'encryption.key') {
      const expected = (await runtimeMaterial('encryption.sha256')).toString();
      if (!/^[0-9a-f]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected)
        throw new Error('recovery_key_mismatch');
    }
    return bytes;
  } finally { await file.close(); }
}
