import { atomicAmount } from './index.js';
export const NETWORK = 'eip155:8453';
export const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export function digitalTotal(unit: string, taxStatus: string, taxSource: string, taxVersion: string): string {
  const value = atomicAmount(unit);
  if (!value || !['tax_included', 'merchant_attested_zero'].includes(taxStatus) || !taxSource || !taxVersion)
    throw new Error('authoritative_tax_required');
  // Calculated tax needs an authoritative adapter, which is not configured in this local slice.
  return value.toString();
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    throw new Error('invalid_input');
  return value;
}
export function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)))
    throw new Error('invalid_input');
  return input as Record<string, unknown>;
}
export function key(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new Error('invalid_input');
  return value;
}
