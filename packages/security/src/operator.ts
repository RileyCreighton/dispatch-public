import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || Buffer.byteLength(value) > 1024) throw new Error('invalid_password');
  return value;
}
export function derivePassword(value: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => argon2('argon2id', {
    message: value, nonce: salt, parallelism: 4, tagLength: 32, memory: 65536, passes: 3,
  }, (error, result) => error ? reject(error) : resolve(result)));
}
export async function makeVerifier(value: unknown) {
  const salt = randomBytes(16), verifier = await derivePassword(password(value), salt);
  return { salt, verifier };
}
export async function checkPassword(value: unknown, salt: Buffer, verifier: Buffer): Promise<boolean> {
  // Fixed-cost dummy verification is used for uninitialized installations by the caller.
  const checked = typeof value === 'string' && Buffer.byteLength(value) <= 1024 ? value : '';
  const candidate = await derivePassword(checked, salt);
  return verifier.length === candidate.length && timingSafeEqual(verifier, candidate);
}
