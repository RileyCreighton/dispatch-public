import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { LocalRpc } from './rpc.js';
import { TOKEN } from '../../domain/src/payment.js';
export const refundAbi = parseAbi(['function transfer(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
export type RefundBinding = {
  invocation_version?: string; invocation_block?: string; invocation_hash?: string;
  expected_signer: string; destination: string; amount: string; token: string; wallet_account_nonce: string;
  prepare_block: string; prepare_block_hash: string; transaction_calldata: string; tx_hash: string | null;
  scan_cursor: string | null; scan_hash: string | null; original_block: string; original_hash: string;
};
export type RefundObservation = { state:'pending'|'confirmed'|'review_required'; evidence:Record<string,unknown>;
  tx?: string; log?:number; block?:string; hash?:string; cursor?:string; cursorHash?:string };
export function refundCalldata(destination:string,amount:string):Hex {
  return encodeFunctionData({abi:refundAbi,functionName:'transfer',args:[destination as Address,BigInt(amount)]});
}
export class RefundRpc {
  constructor(readonly rpc:LocalRpc) {}
  async original(height:string,hash:string) { return await this.rpc.canonicalHash(BigInt(height)) === hash; }
  async prepare(signer:string) {
    const client=this.rpc.client, address=signer as Address;
    const chain=await client.getChainId(),block=await client.getBlock({blockTag:'latest'});
    if(chain!==8453 || !block.hash || block.number===null || Date.now()/1000-Number(block.timestamp)>30 || Number(block.timestamp)>Date.now()/1000+5) throw new Error('not_ready');
    const [nonce,pending,code]=await Promise.all([client.getTransactionCount({address,blockNumber:block.number}),
      client.getTransactionCount({address,blockTag:'pending'}),client.getBytecode({address,blockNumber:block.number})]);
    if(code || !Number.isSafeInteger(nonce) || nonce<0 || !Number.isSafeInteger(pending) || nonce!==pending || await this.rpc.canonicalHash(block.number)!==block.hash) throw new Error('refund_review_required');
    return {chain:8453,nonce:String(nonce),block:String(block.number),hash:block.hash,observedAt:Date.now()};
  }
  async observe(b:RefundBinding,persistHint?:(hash:string)=>Promise<void>):Promise<RefundObservation> {
    let candidate:string|undefined;
    const review=(reason:string):RefundObservation=>({state:'review_required',...(candidate?{tx:candidate}:{}),evidence:{reason,verifier:'refund-direct-v1',...(candidate?{transaction_hint:candidate}:{})}});
    const client=this.rpc.client;
    try {
      if(!await this.original(b.original_block,b.original_hash) || await this.rpc.canonicalHash(BigInt(b.prepare_block))!==b.prepare_block_hash)
        return review('canonical_anchor_changed');
      if(b.scan_cursor && b.scan_hash && await this.rpc.canonicalHash(BigInt(b.scan_cursor))!==b.scan_hash) return review('scan_reorg');
      const chain=await client.getChainId(),head=await client.getBlock({blockTag:'safe'});
      if(chain!==8453 || !head.hash || head.number===null || b.token!==TOKEN) return review('unsupported_chain_or_token');
      let txHash=b.tx_hash;
      let scanEnd:bigint|undefined,scanHash:Hex|undefined;
      if(!txHash) {
        const start=BigInt(b.scan_cursor??b.prepare_block)+1n,stop=head.number<start+127n?head.number:start+127n;
        let previous=b.scan_hash??b.prepare_block_hash;
        for(let height=start;height<=stop;height++) {
          const block=await client.getBlock({blockNumber:height,includeTransactions:true});
          if(!block.hash || block.parentHash!==previous || block.number!==height) return review('incomplete_scan');
          for(const tx of block.transactions) {
            if(typeof tx==='string')return review('incomplete_transactions');
            if(tx.from.toLowerCase()===b.expected_signer && String(tx.nonce)===b.wallet_account_nonce) {
              if(txHash && txHash!==tx.hash)return review('ambiguous_nonce');txHash=tx.hash;
              candidate=tx.hash;await persistHint?.(tx.hash);
            }
          }
          if(await this.rpc.canonicalHash(height)!==block.hash)return review('scan_reorg');
          previous=block.hash;scanEnd=height;scanHash=block.hash;
        }
        if(!txHash) {
          if(await this.rpc.canonicalHash(head.number)!==head.hash)return review('head_changed');
          return {state:'pending',evidence:{verifier:'refund-direct-v1',scan_start:String(start),safe_head:String(head.number),safe_hash:head.hash,complete:true,
            ...(scanEnd!==undefined&&scanHash ? {scan_end:String(scanEnd),scan_hash:scanHash} : {})},
            ...(scanEnd!==undefined&&scanHash ? {cursor:String(scanEnd),cursorHash:scanHash} : {})};
        }
      }
      const hash=txHash as Hex;candidate=hash;await persistHint?.(hash);
      const [tx,receipt]=await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash})]);
      if(tx.chainId!==8453 || tx.from.toLowerCase()!==b.expected_signer || String(tx.nonce)!==b.wallet_account_nonce || tx.to?.toLowerCase()!==TOKEN
        || tx.value!==0n || tx.input.toLowerCase()!==b.transaction_calldata || tx.input.toLowerCase()!==refundCalldata(b.destination,b.amount)
        || receipt.status!=='success' || tx.hash!==receipt.transactionHash || tx.blockHash!==receipt.blockHash || tx.blockNumber!==receipt.blockNumber)
        return review('transaction_binding_mismatch');
      if(!b.invocation_version || !b.invocation_block || !b.invocation_hash)return review('missing_invocation_association');
      if(await this.rpc.canonicalHash(BigInt(b.invocation_block))!==b.invocation_hash)return review('invocation_anchor_changed');
      if(receipt.blockNumber<=BigInt(b.invocation_block))return review('transfer_precedes_invocation_authority');
      if(receipt.blockNumber<=BigInt(b.prepare_block))return review('historical_transfer');
      if(receipt.blockNumber>head.number)return {state:'pending',tx:hash,evidence:{reason:'awaiting_safe_observation',transaction_hint:hash}};
      const logs=receipt.logs.filter(l=>l.address.toLowerCase()===TOKEN);
      if(logs.length!==1)return review('ambiguous_transfer_logs');
      const log=logs[0]!;
      const event=decodeEventLog({abi:refundAbi,data:log.data,topics:log.topics,strict:true});
      if(event.eventName!=='Transfer' || event.args.from.toLowerCase()!==b.expected_signer || event.args.to.toLowerCase()!==b.destination
        || event.args.value!==BigInt(b.amount) || log.removed || log.transactionHash!==hash || log.blockHash!==receipt.blockHash || log.logIndex===null)
        return review('transfer_mismatch');
      if(await this.rpc.canonicalHash(receipt.blockNumber)!==receipt.blockHash || await this.rpc.canonicalHash(head.number)!==head.hash
        || await this.rpc.canonicalHash(BigInt(b.prepare_block))!==b.prepare_block_hash || !await this.original(b.original_block,b.original_hash) || await this.rpc.canonicalHash(BigInt(b.invocation_block))!==b.invocation_hash)return review('canonical_changed');
      return {state:'confirmed',tx:hash,log:log.logIndex,block:String(receipt.blockNumber),hash:receipt.blockHash,
        evidence:{verifier:'refund-direct-v2',invocation_version:b.invocation_version,invocation_block:b.invocation_block,invocation_hash:b.invocation_hash,chain_id:8453,sender:tx.from.toLowerCase(),nonce:String(tx.nonce),transaction:hash,
          transaction_input:tx.input,transfer_log_index:log.logIndex,prepare_block:b.prepare_block,prepare_hash:b.prepare_block_hash,
          block:String(receipt.blockNumber),block_hash:receipt.blockHash,policy:'safe',observed_head:String(head.number),observed_head_hash:head.hash}};
    }catch{return review('rpc_or_evidence_unavailable');}
  }
}
