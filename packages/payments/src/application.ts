import { hashTypedData, hashDomain } from 'viem';
import type { Address, Hex } from 'viem';
import { PaymentPayloadV2Schema } from '@x402/core/schemas';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { CapabilitySnapshot } from './capabilities.js';
import { canonical } from './canonical.js';
import { typed, validateAuthorization, type Binding, type ChainFixture } from './settlement.js';
import { NETWORK, TOKEN } from '../../domain/src/payment.js';
import { atomicAmount } from '../../domain/src/index.js';
export interface Preaccept {
  block: bigint; hash: Hex; chainTime: bigint; observedAt: number; nonceUsed: boolean;
  chainId: number; token: Address; domainName: string; domainVersion: string; domainSeparator: Hex; decimals: number;
}
export interface ChainReader {
  preaccept(authorizer: Address, nonce: Hex): Promise<Preaccept>;
  evidence(binding: Binding, transaction: Hex): Promise<ChainFixture | null>;
  canonicalHash(block: bigint): Promise<Hex>;
}
export function freshObservation(o: Preaccept, now = Date.now()) {
  const expected = hashDomain({ domain: { name: 'USD Coin', version: '2', chainId: 8453n, verifyingContract: TOKEN },
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } });
  if (o.chainId !== 8453 || o.token.toLowerCase() !== TOKEN || o.decimals !== 6 || o.domainName !== 'USD Coin'
    || o.domainVersion !== '2' || o.domainSeparator !== expected || o.nonceUsed || o.block < 0n
    || !/^0x[0-9a-f]{64}$/.test(o.hash) || !Number.isFinite(o.observedAt) || o.observedAt > now
    || now - o.observedAt > 5000 || BigInt(Math.floor(now / 1000)) - o.chainTime > 30n
    || o.chainTime > BigInt(Math.floor(now / 1000) + 5)) throw new Error('preaccept_unusable');
}
export async function authorization(input: unknown, requirements: PaymentRequirements): Promise<{payment: PaymentPayload; binding: Binding}> {
  const payment = structuredClone(input) as PaymentPayload;
  PaymentPayloadV2Schema.parse(payment);
  if (payment.x402Version !== 2 || canonical(payment.accepted) !== canonical(requirements)
    || requirements.scheme !== 'exact' || requirements.network !== NETWORK || requirements.asset.toLowerCase() !== TOKEN
    || requirements.extra?.assetTransferMethod !== 'eip3009' || requirements.extra?.name !== 'USD Coin'
    || requirements.extra?.version !== '2') throw new Error('binding_mismatch');
  const a = payment.payload.authorization as Record<string, unknown> | undefined;
  if (!a || Object.keys(a).sort().join(',') !== 'from,nonce,to,validAfter,validBefore,value'
    || typeof a.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.from)
    || typeof a.to !== 'string' || a.to.toLowerCase() !== requirements.payTo.toLowerCase()
    || typeof a.nonce !== 'string' || !/^0x[0-9a-f]{64}$/.test(a.nonce)
    || a.value !== requirements.amount || typeof payment.payload.signature !== 'string'
    || !/^0x[0-9a-fA-F]{130}$/.test(payment.payload.signature)) throw new Error('binding_mismatch');
  const after = atomicAmount(a.validAfter), before = atomicAmount(a.validBefore); atomicAmount(a.value);
  if (before <= after) throw new Error('invalid_window');
  const tuple = { token: TOKEN as Address, from: a.from.toLowerCase() as Address, to: a.to.toLowerCase() as Address,
    value: a.value as string, validAfter: after.toString(), validBefore: before.toString(), nonce: a.nonce as Hex,
    domainName: 'USD Coin', domainVersion: '2' };
  const binding: Binding = { ...tuple, digest: hashTypedData(typed(tuple)), preacceptBlock: 0n,
    preacceptHash: ('0x' + '00'.repeat(32)) as Hex, nonceState: 'unused', preacceptObservedAt: 0 };
  await validateAuthorization(binding, payment.payload.signature as Hex);
  return { payment, binding };
}
export async function challenge(input: { amount: string; payee: string; deadline: number; url: string }, snapshot: CapabilitySnapshot) {
  const remaining = Math.floor((input.deadline - Date.now() - 5000) / 1000);
  if (remaining < 1) throw new Error('approval_window_exhausted');
  const resource = new x402ResourceServer(snapshot).register(NETWORK, new ExactEvmScheme());
  await resource.initialize();
  const requirements = (await resource.buildPaymentRequirements({ scheme: 'exact', network: NETWORK, payTo: input.payee,
    price: { asset: TOKEN, amount: input.amount, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' } },
    maxTimeoutSeconds: Math.min(30, remaining) }))[0];
  if (!requirements || Date.now() + requirements.maxTimeoutSeconds * 1000 + 5000 > input.deadline)
    throw new Error('approval_window_exhausted');
  return requirements;
}
export async function required(requirements: PaymentRequirements, url: string, snapshot: CapabilitySnapshot) {
  const resource = new x402ResourceServer(snapshot).register(NETWORK, new ExactEvmScheme());
  await resource.initialize();
  return resource.createPaymentRequiredResponse([requirements], { url });
}
