import type { FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { supportedResponse } from './facilitator.js';
export class CapabilitySnapshot implements FacilitatorClient {
  readonly #value: SupportedResponse; readonly #expires: number;
  constructor(value: unknown, fetchedAt: number, expiresAt: number) {
    if(!Number.isFinite(fetchedAt)||!Number.isFinite(expiresAt)||fetchedAt>Date.now()||expiresAt<=fetchedAt||expiresAt-fetchedAt>60000)throw new Error('invalid_snapshot_window');
    this.#value=supportedResponse(value);this.#expires=expiresAt;
  }
  async getSupported(){if(Date.now()>=this.#expires)throw new Error('stale_snapshot');return structuredClone(this.#value);}
  async verify():Promise<never>{throw new Error('snapshot_read_only');}
  async settle():Promise<never>{throw new Error('snapshot_read_only');}
}
