// Browser-safe public contracts. No process, filesystem, DB or provider imports.
export const PUBLIC_CONFIG = Object.freeze({ network: 'eip155:8453', chain_id: 8453,
  asset: 'USDC', decimals: 6, payments_enabled: false, physical_enabled: false } as const);
export type ErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'NOT_READY' | 'RATE_LIMITED' | 'FORBIDDEN';
export function safeError(code: ErrorCode, requestId: string) {
  const messages: Record<ErrorCode, string> = { INVALID_INPUT: 'Invalid request.', NOT_FOUND: 'Not found.',
    NOT_READY: 'Payments are unavailable.', RATE_LIMITED: 'Try again later.', FORBIDDEN: 'Request refused.' };
  return { code, message: messages[code], request_id: requestId,
    retryable: code === 'RATE_LIMITED', next_action: 'none' };
}
export interface SupportSnapshot {
  provider_origin: string;
  fetched_at: number;
  expires_at: number;
  supported_kinds: { x402Version: 2; scheme: 'exact'; network: 'eip155:8453' }[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_contract');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join() !== expected.sort().join()) throw new Error('invalid_contract');
}
export function supportSnapshot(input: unknown, expectedOrigin: string, now: number): SupportSnapshot {
  const v = object(input);
  keys(v, ['provider_origin', 'fetched_at', 'expires_at', 'supported_kinds']);
  const origin = new URL(expectedOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== expectedOrigin || origin.username || origin.password ||
    v.provider_origin !== expectedOrigin || !Number.isSafeInteger(v.fetched_at) || !Number.isSafeInteger(v.expires_at))
    throw new Error('invalid_snapshot');
  const fetched = v.fetched_at as number; const expires = v.expires_at as number;
  if (fetched > now || now - fetched > 300_000 || expires <= now || expires <= fetched || expires - fetched > 300_000)
    throw new Error('stale_snapshot');
  if (!Array.isArray(v.supported_kinds) || v.supported_kinds.length !== 1) throw new Error('invalid_snapshot');
  const kind = object(v.supported_kinds[0]); keys(kind, ['x402Version', 'scheme', 'network']);
  if (kind.x402Version !== 2 || kind.scheme !== 'exact' || kind.network !== 'eip155:8453') throw new Error('unsupported_kind');
  return { provider_origin: expectedOrigin, fetched_at: fetched, expires_at: expires,
    supported_kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] };
}
