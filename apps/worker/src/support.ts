import type { Pool } from 'pg';
import { storeSupport } from '../../../packages/db/src/index.js';
export interface SupportProvider { readonly origin: string; getSupported(): Promise<unknown> }
export async function refreshSupport(pool: Pool, provider: SupportProvider): Promise<string> {
  // Provider I/O is complete before the DB insert; no transaction spans the call.
  const result = await provider.getSupported();
  return storeSupport(pool, result, provider.origin);
}
