// Direct-call synthetic fixture decoder. Provider traces/batches remain unsupported.
import { decodeFunctionData, decodeEventLog, parseAbi, hashTypedData, verifyTypedData, keccak256, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { authorizationTypes } from './wallet.js';
export const tokenAbi = parseAbi([
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export type Binding = {
  token: Address; from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex;
  domainName: string; domainVersion: string; digest: Hex; preacceptBlock: bigint; preacceptHash: Hex;
  nonceState:'unused'|'used'|'cancelled'; preacceptObservedAt:number;
};
export function typed(binding: Omit<Binding,'digest'|'preacceptBlock'|'preacceptHash'|'nonceState'|'preacceptObservedAt'>) {
  return { domain: { name: binding.domainName,version:binding.domainVersion,chainId:8453,verifyingContract:binding.token },
    types: authorizationTypes, primaryType:'TransferWithAuthorization' as const,
    message:{from:binding.from,to:binding.to,value:BigInt(binding.value),validAfter:BigInt(binding.validAfter),validBefore:BigInt(binding.validBefore),nonce:binding.nonce} };
}
export async function validateAuthorization(binding: Binding, signature: Hex) {
  const data=typed(binding);
  if (hashTypedData(data)!==binding.digest || !await verifyTypedData({...data,address:binding.from,signature})) throw new Error('invalid_authorization');
}
export type ChainFixture = {
  chainId: number; transactionHash: Hex; transactionTo: Address; transactionValue: bigint; input: Hex;
  receiptStatus: 'success'|'reverted'; block: bigint; blockHash: Hex; canonicalHash: Hex; preacceptCanonicalHash: Hex;
  blockTime: bigint; safeHead: bigint; safeHash: Hex;
  logs: {address:Address;topics:Hex[];data:Hex;logIndex:number;transactionHash:Hex;blockHash:Hex;removed:boolean}[];
};
export function exactSettlement(binding: Binding, evidence: ChainFixture) {
  const fail=()=>{throw new Error('settlement_review_required');};
  if(evidence.chainId!==8453 || evidence.receiptStatus!=='success' || evidence.transactionTo.toLowerCase()!==binding.token.toLowerCase()
    || evidence.transactionValue!==0n || evidence.block<=binding.preacceptBlock || evidence.block>evidence.safeHead
    || evidence.blockHash!==evidence.canonicalHash || evidence.preacceptCanonicalHash!==binding.preacceptHash
    || (evidence.block===evidence.safeHead && evidence.blockHash!==evidence.safeHash)
    || evidence.blockTime<=BigInt(binding.validAfter) || evidence.blockTime>=BigInt(binding.validBefore)) return fail();
  const call=decodeFunctionData({abi:tokenAbi,data:evidence.input});
  if(call.functionName!=='transferWithAuthorization') return fail();
  const [from,to,value,validAfter,validBefore,nonce]=call.args;
  if(from.toLowerCase()!==binding.from.toLowerCase() || to.toLowerCase()!==binding.to.toLowerCase() || value!==BigInt(binding.value)
    || validAfter!==BigInt(binding.validAfter) || validBefore!==BigInt(binding.validBefore) || nonce!==binding.nonce
    || hashTypedData(typed(binding))!==binding.digest) return fail();
  // Narrow allowlist: exactly the token's Used then Transfer; any extra token log is ambiguous.
  const logs=evidence.logs.filter(l=>l.address.toLowerCase()===binding.token.toLowerCase());
  if(logs.length!==2 || logs.some(l=>l.removed || l.transactionHash!==evidence.transactionHash || l.blockHash!==evidence.blockHash)) return fail();
  const [used,transfer]=logs;
  if(!used || !transfer || used.logIndex>=transfer.logIndex) return fail();
  const u=decodeEventLog({abi:tokenAbi,topics:used.topics as [Hex,...Hex[]],data:used.data,strict:true});
  const tr=decodeEventLog({abi:tokenAbi,topics:transfer.topics as [Hex,...Hex[]],data:transfer.data,strict:true});
  if(u.eventName!=='AuthorizationUsed' || u.args.authorizer.toLowerCase()!==binding.from.toLowerCase() || u.args.nonce!==binding.nonce
    || tr.eventName!=='Transfer' || tr.args.from.toLowerCase()!==binding.from.toLowerCase() || tr.args.to.toLowerCase()!==binding.to.toLowerCase() || tr.args.value!==BigInt(binding.value)) return fail();
  return { transaction:evidence.transactionHash,block:evidence.block.toString(),blockHash:evidence.blockHash,
    authorizerIndex:used.logIndex,transferIndex:transfer.logIndex,callPath:'direct',policy:'safe',
    evidenceDigest:keccak256(toHex(JSON.stringify(evidence,(_k,v)=>typeof v==='bigint'?v.toString():v))) };
}
