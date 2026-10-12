import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export type LogCode = 'started' | 'stopped' | 'request' | 'dependency_unavailable' | 'snapshot_stored';
const codes = new Set<LogCode>(['started', 'stopped', 'request', 'dependency_unavailable', 'snapshot_stored']);
export function safeLog(write: (line: string) => void, code: LogCode, status?: number) {
  if (!codes.has(code)) throw new Error('invalid_log_code');
  write(JSON.stringify({ code, ...(Number.isInteger(status) && status! >= 100 && status! <= 599 ? { status } : {}) }) + '\n');
}
export interface Sealed { ciphertext: Buffer; iv: Buffer; tag: Buffer; keyId: string }
export function seal(plaintext: Buffer, key: Buffer, keyId: string, binding: string): Sealed {
  if (key.length !== 32 || !/^[a-zA-Z0-9_-]{1,64}$/.test(keyId) || !binding || plaintext.length > 65536)
    throw new Error('invalid_encryption_input');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${keyId}:${binding}`));
  return { ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), iv, tag: cipher.getAuthTag(), keyId };
}
export function unseal(value: Sealed, key: Buffer, binding: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, value.iv);
  decipher.setAAD(Buffer.from(`${value.keyId}:${binding}`)); decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}
