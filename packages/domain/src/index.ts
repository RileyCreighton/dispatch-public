export const UINT256_MAX = (1n << 256n) - 1n;
export function atomicAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('invalid_amount');
  const amount = BigInt(value);
  if (amount > UINT256_MAX) throw new Error('amount_overflow');
  return amount;
}
