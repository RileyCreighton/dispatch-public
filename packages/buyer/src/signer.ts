import { hashTypedData,verifyTypedData } from 'viem';
import type { ClientEvmSigner } from '@x402/evm';
import { authorizationTypes } from '../../payments/src/wallet.js';
import { address,canonical,TOKEN,type Quote } from './contracts.js';
// Same accepted exact-EIP3009 approval boundary for an external agent signer.
// The upstream client owns payload construction; this guard cannot sign by itself.
export function approvedSigner(signer:ClientEvmSigner,q:Quote):ClientEvmSigner {
  const account=address(signer.address);
  return {address:signer.address,async signTypedData(data){
    const {domain,types,primaryType,message}=data,now=BigInt(Math.floor(Date.now()/1000));
    if(primaryType!=='TransferWithAuthorization' || canonical(types)!==canonical(authorizationTypes)
      || String(domain.chainId)!=='8453' || domain.name!=='USD Coin' || domain.version!=='2' || domain.salt!==undefined
      || address(domain.verifyingContract)!==TOKEN || address(message.from)!==account || address(message.to)!==address(q.payee)
      || String(message.value)!==q.total_atomic || !/^0x[0-9a-fA-F]{64}$/.test(String(message.nonce))
      || BigInt(String(message.validAfter))<0n || BigInt(String(message.validAfter))>now
      || BigInt(String(message.validBefore))<=now || BigInt(String(message.validBefore))*1000n>BigInt(Date.parse(q.expires_at)))throw new Error('unapproved_typed_data');
    const digest=hashTypedData(data),signature=await signer.signTypedData(data);
    if(digest!==hashTypedData(data) || BigInt(String(message.validBefore))<=BigInt(Math.floor(Date.now()/1000))
      || !await verifyTypedData({...data,address:signer.address,signature}))throw new Error('invalid_wallet_signature');
    return signature;
  }};
}
