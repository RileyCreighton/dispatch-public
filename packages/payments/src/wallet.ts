// Injected EOA bridge. No private-key parameter, personal_sign or transaction RPC.
import { createWalletClient, custom, hashTypedData, verifyTypedData } from 'viem';
import type { EIP1193Provider, Address } from 'viem';
import type { ClientEvmSigner } from '@x402/evm';
const fields = [{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
  {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}];
export const authorizationTypes = { TransferWithAuthorization: fields };
// Only this typed error proves rejection of the signing request itself. Context
// reads before/after signing may also report 4001; those are never retry authority.
export class WalletSignatureRejected extends Error {
  constructor() { super('signature_rejected'); }
}
export function injectedSigner(provider: EIP1193Provider, approval: {
  account: Address; token: Address; payee: Address; amount: string;
  domainName: string; domainVersion: string; quoteExpiresAt: number;
}): ClientEvmSigner {
  const expected = structuredClone(approval);
  const wallet = createWalletClient({ account: expected.account, transport: custom(provider, { retryCount: 0 }) });
  const check = async () => {
    const [chain, accounts] = await Promise.all([provider.request({method:'eth_chainId'}),provider.request({method:'eth_accounts'})]);
    if (chain !== '0x2105' || accounts.length !== 1 || accounts[0]?.toLowerCase() !== expected.account.toLowerCase()) throw new Error('wallet_context_changed');
  };
  return { address: expected.account, async signTypedData(data) {
    await check();
    const {domain,message,types,primaryType} = data;
    const now = Math.floor(Date.now()/1000);
    if (primaryType !== 'TransferWithAuthorization' || JSON.stringify(types) !== JSON.stringify(authorizationTypes)
      || Number(domain.chainId) !== 8453 || domain.name !== expected.domainName || domain.version !== expected.domainVersion
      || String(domain.verifyingContract).toLowerCase() !== expected.token.toLowerCase() || domain.salt !== undefined
      || String(message.from).toLowerCase() !== expected.account.toLowerCase() || String(message.to).toLowerCase() !== expected.payee.toLowerCase()
      || String(message.value) !== expected.amount || !/^0x[0-9a-fA-F]{64}$/.test(String(message.nonce))
      || BigInt(String(message.validAfter)) > BigInt(now) || BigInt(String(message.validAfter)) < 0n
      || BigInt(String(message.validBefore)) <= BigInt(now) || BigInt(String(message.validBefore)) > BigInt(expected.quoteExpiresAt)) throw new Error('unapproved_typed_data');
    const before = hashTypedData(data);
    let signature: `0x${string}`;
    try { signature = await wallet.signTypedData({ ...data, account: expected.account }); }
    catch (error) {
      let cause: unknown = error;
      for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
        const value = cause as { code?: unknown; cause?: unknown };
        if (value.code === 4001) throw new WalletSignatureRejected();
        cause = value.cause;
      }
      throw error;
    }
    await check();
    if(BigInt(String(message.validBefore))<=BigInt(Math.floor(Date.now()/1000)) || Date.now()>=expected.quoteExpiresAt*1000)throw new Error('approval_expired');
    if (before !== hashTypedData(data) || !await verifyTypedData({...data,address:expected.account,signature})) throw new Error('invalid_wallet_signature');
    return signature;
  }};
}
