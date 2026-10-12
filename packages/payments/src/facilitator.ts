// CC-B1-001: worker-only, one native request per operation. No retry, signer or DB.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest } from 'node:http';
import type { FacilitatorClient, FacilitatorConfig } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, VerifyResponse, SettleResponse, SupportedResponse } from '@x402/core/types';
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from '@x402/core/schemas';

type Operation = 'verify' | 'settle' | 'supported';
type Response = VerifyResponse | SettleResponse | SupportedResponse;
export type Observation = Readonly<{
  operation: Operation; status: number | null;
  kind: 'verified' | 'supported' | 'hint_success' | 'pending' | 'rejection' | 'unknown';
  code: string; transaction: string | null;
}>;
type Result = { observation: Observation; response?: Response };
export class ObservationError extends Error {
  readonly observation: Observation;
  constructor(observation: Observation) { super(`facilitator:${observation.code}`); this.name = 'ObservationError'; this.observation = observation; }
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const hash = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x);
const address = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);
const reasons = new Set(['settlement_pending', 'invalid_signature', 'invalid_network', 'insufficient_funds', 'invalid_payment_requirements', 'invalid_exact_evm_payload_authorization_value', 'nonce_already_used']);
const safeReason = (x: unknown) => typeof x === 'string' && reasons.has(x) ? x : 'provider_rejection';
export function supportedResponse(value: unknown): SupportedResponse {
  if (!object(value) || !Array.isArray(value.kinds) || value.kinds.length !== 1 || !object(value.kinds[0])
    || value.kinds[0].x402Version !== 2 || value.kinds[0].scheme !== 'exact' || value.kinds[0].network !== 'eip155:8453'
    || !Array.isArray(value.extensions) || value.extensions.length !== 0 || !object(value.signers)
    || Object.keys(value.signers).some(key => key !== 'eip155:8453')
    || Object.values(value.signers).some(signers => !Array.isArray(signers) || signers.length > 32 || !signers.every(address))) throw new Error('invalid_supported');
  return { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }], extensions: [],
    signers: Object.fromEntries(Object.entries(value.signers).map(([k,v]) => [k, [...v as string[]]])) };
}
export class FacilitatorTransport implements FacilitatorClient {
  readonly #base: URL;
  readonly #auth: FacilitatorConfig['createAuthHeaders'];
  readonly #timeout: number;
  readonly #limit: number;
  readonly #ca: string | undefined;
  readonly #observations = new WeakMap<object, Observation>();
  constructor(config: { url: string; timeoutMs?: number; maxBytes?: number;
    createAuthHeaders?: FacilitatorConfig['createAuthHeaders']; loopbackFixture?: boolean; fixtureCA?: string }) {
    const base = new URL(config.url);
    const local = base.hostname === '127.0.0.1';
    if (base.username || base.password || base.search || base.hash || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(base.pathname)
      || (base.protocol !== 'https:' && !(base.protocol === 'http:' && config.loopbackFixture && local))
      || (config.fixtureCA !== undefined && !(config.loopbackFixture && local))) throw new Error('invalid_facilitator_config');
    this.#timeout = config.timeoutMs ?? 15000; this.#limit = config.maxBytes ?? 65536;
    if (!Number.isInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 60000
      || !Number.isInteger(this.#limit) || this.#limit < 1 || this.#limit > 1048576) throw new Error('invalid_facilitator_limits');
    base.pathname = base.pathname.replace(/\/$/, '');
    this.#base = base; this.#auth = config.createAuthHeaders; this.#ca = config.fixtureCA;
  }
  observation(response: Response): Observation {
    const result = this.#observations.get(response);
    if (!result) throw new Error('missing_observation');
    return result;
  }
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.#unwrap(await this.observe('verify', payload, requirements)) as VerifyResponse;
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.#unwrap(await this.observe('settle', payload, requirements)) as SettleResponse;
  }
  async getSupported(): Promise<SupportedResponse> { return this.#unwrap(await this.observe('supported')) as SupportedResponse; }
  #unwrap(result: Result): Response {
    if (!result.response || result.observation.status === null || result.observation.status < 200 || result.observation.status >= 300)
      throw new ObservationError(result.observation);
    this.#observations.set(result.response, result.observation);
    return result.response;
  }
  async observe(operation: Operation, payload?: PaymentPayload, requirements?: PaymentRequirements): Promise<Result> {
    let status: number | null = null;
    let transaction: string | null = null;
    const outcome = (code: string, kind: Observation['kind'] = 'unknown', response?: Response): Result => ({
      observation: Object.freeze({ operation, status, kind, code, transaction }), ...(response ? { response } : {}),
    });
    if (!['verify', 'settle', 'supported'].includes(operation)) return outcome('invalid_operation');
    let body: string | undefined;
    try {
      if (operation !== 'supported') {
        PaymentPayloadV2Schema.parse(payload); PaymentRequirementsV2Schema.parse(requirements);
        if (payload?.x402Version !== 2 || requirements?.network !== 'eip155:8453' || requirements.scheme !== 'exact') return outcome('invalid_request');
        body = JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });
        if (Buffer.byteLength(body) > this.#limit) return outcome('request_too_large');
      }
    } catch { return outcome('invalid_request'); }
    const url = new URL(this.#base); url.pathname = this.#base.pathname.replace(/\/$/, '') + '/' + operation;
    return new Promise<Result>(resolve => {
      let completed = false; let req: ClientRequest | undefined;
      const finish = (result: Result) => { if (!completed) { completed = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => { finish(outcome('deadline')); req?.destroy(); }, this.#timeout);
      void (async () => {
        const headers: Record<string, string> = { Accept: 'application/json', Connection: 'close' };
        try {
          const auth = this.#auth ? await this.#auth() : {};
          if (completed) return;
          if (!object(auth) || Object.keys(auth).some(k => !['verify', 'settle', 'supported', 'bazaar'].includes(k))) throw new Error();
          for (const map of Object.values(auth)) {
            if (!object(map) || Object.entries(map).some(([k,v]) => k.toLowerCase() !== 'authorization'
              || typeof v !== 'string' || v.length > 8192 || /[^\x20-\x7e]/.test(v)) || Object.keys(map).length > 1) throw new Error();
          }
          Object.assign(headers, auth[operation]);
        } catch { finish(outcome('auth_invalid')); return; }
        if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(body)); }
        try {
          req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
            method: operation === 'supported' ? 'GET' : 'POST', headers, agent: false,
            maxHeaderSize: 16384, ...(this.#ca ? { ca: this.#ca } : {}), rejectUnauthorized: true,
          }, res => {
            status = res.statusCode ?? null;
            if (status !== null && status >= 300 && status < 400) { finish(outcome('redirect')); res.destroy(); return; }
            if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { finish(outcome('encoding')); res.destroy(); return; }
            let size = 0; const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > this.#limit) { finish(outcome('response_too_large')); res.destroy(); } else chunks.push(chunk);
            });
            res.on('aborted', () => finish(outcome('body_aborted')));
            res.on('error', () => finish(outcome('body_error')));
            res.on('end', () => {
              if (completed) return;
              try {
                if (!res.complete || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) throw new Error();
                const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!object(value)) throw new Error();
                if (operation === 'supported') { const parsed = supportedResponse(value); finish(outcome('supported', 'supported', parsed)); return; }
                if (value.payer !== undefined && !address(value.payer)) throw new Error();
                const payer = typeof value.payer === 'string' ? { payer: value.payer } : {};
                if (operation === 'verify') {
                  if (typeof value.isValid !== 'boolean' || (value.invalidReason !== undefined && typeof value.invalidReason !== 'string')
                    || (!value.isValid && !value.invalidReason) || (value.isValid && value.invalidReason !== undefined)) throw new Error();
                  const reason = safeReason(value.invalidReason);
                  finish(outcome(value.isValid ? 'verified' : reason, value.isValid ? 'verified' : 'rejection',
                    { isValid: value.isValid, ...payer, ...(!value.isValid ? { invalidReason: reason } : {}) })); return;
                }
                if (value.network !== requirements?.network || (typeof value.transaction !== 'string')
                  || (value.transaction !== '' && !hash(value.transaction))) throw new Error();
                transaction = hash(value.transaction) ? value.transaction.toLowerCase() : null;
                if (typeof value.success !== 'boolean' || (value.errorReason !== undefined && typeof value.errorReason !== 'string')
                  || (value.success && !transaction) || (value.success && value.errorReason !== undefined)
                  || (value.amount !== undefined && value.amount !== requirements?.amount) || (!value.success && !value.errorReason)) throw new Error();
                const code = value.success ? 'hint_success' : safeReason(value.errorReason);
                const kind = value.success ? 'hint_success' : code === 'settlement_pending' ? (transaction ? 'pending' : 'unknown') : 'rejection';
                finish(outcome(code, kind, { success: value.success, transaction: transaction ?? '', network: 'eip155:8453',
                  ...payer, ...(!value.success ? { errorReason: code } : {}) }));
              } catch { finish(outcome('invalid_response')); }
            });
          });
          req.on('error', () => finish(outcome('transport_error')));
          req.on('upgrade', (_res, socket) => { status = 101; socket.destroy(); finish(outcome('upgrade_refused')); });
          req.end(body);
        } catch { finish(outcome('transport_error')); }
      })();
    });
  }
}
