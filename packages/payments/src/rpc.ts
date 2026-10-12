import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import type { Binding, ChainFixture } from './settlement.js';
import type { ChainReader, Preaccept } from './application.js';
import { TOKEN } from '../../domain/src/payment.js';
const abi = parseAbi(['function authorizationState(address,bytes32) view returns(bool)',
  'function name() view returns(string)', 'function version() view returns(string)',
  'function decimals() view returns(uint8)', 'function DOMAIN_SEPARATOR() view returns(bytes32)']);
// Local independent RPC only. No deployment or live endpoint selection in this local implementation.
export class LocalRpc implements ChainReader {
  readonly client;
  constructor(endpoint: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash)
      throw new Error('local_rpc_required');
    this.client = createPublicClient({ transport: http(endpoint, { retryCount: 0, timeout: 5000, batch: false }) });
  }
  async canonicalHash(height: bigint): Promise<Hex> {
    const b = await this.client.getBlock({ blockNumber: height });
    if (!b.hash) throw new Error('missing_block'); return b.hash;
  }
  async preaccept(authorizer: Address, nonce: Hex): Promise<Preaccept> {
    const chainId = await this.client.getChainId(), block = await this.client.getBlock({ blockTag: 'latest' });
    if (!block.hash || block.number === null) throw new Error('missing_block');
    const address = TOKEN as Address, blockNumber = block.number;
    const [nonceUsed, domainName, domainVersion, decimals, domainSeparator] = await Promise.all([
      this.client.readContract({ address, abi, functionName: 'authorizationState', args: [authorizer, nonce], blockNumber }),
      this.client.readContract({ address, abi, functionName: 'name', blockNumber }),
      this.client.readContract({ address, abi, functionName: 'version', blockNumber }),
      this.client.readContract({ address, abi, functionName: 'decimals', blockNumber }),
      this.client.readContract({ address, abi, functionName: 'DOMAIN_SEPARATOR', blockNumber }),
    ]);
    if (await this.canonicalHash(block.number) !== block.hash || (await this.client.getBytecode({ address: authorizer, blockNumber })))
      throw new Error('preaccept_conflict_or_non_eoa');
    return { chainId, block: block.number, hash: block.hash, chainTime: block.timestamp, observedAt: Date.now(),
      token: address, nonceUsed, domainName, domainVersion, decimals, domainSeparator };
  }
  async evidence(binding: Binding, transaction: Hex): Promise<ChainFixture | null> {
    try {
      const [chainId, tx, receipt, safe] = await Promise.all([this.client.getChainId(), this.client.getTransaction({ hash: transaction }),
        this.client.getTransactionReceipt({ hash: transaction }), this.client.getBlock({ blockTag: 'safe' })]);
      if (!tx.to || !tx.blockHash || tx.blockNumber === null || !safe.hash || safe.number === null
        || tx.hash !== receipt.transactionHash || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) return null;
      const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
      if (!block.hash) return null;
      const evidence: ChainFixture = { chainId, transactionHash: transaction, transactionTo: tx.to, transactionValue: tx.value,
        input: tx.input, receiptStatus: receipt.status, block: receipt.blockNumber, blockHash: receipt.blockHash,
        canonicalHash: block.hash, preacceptCanonicalHash: await this.canonicalHash(binding.preacceptBlock),
        blockTime: block.timestamp, safeHead: safe.number, safeHash: safe.hash,
        logs: receipt.logs.map(l => {
          if (l.logIndex === null || !l.transactionHash || !l.blockHash) throw new Error('incomplete_log');
          return { address: l.address, topics: [...l.topics], data: l.data, logIndex: l.logIndex,
            transactionHash: l.transactionHash, blockHash: l.blockHash, removed: l.removed };
        }) };
      // Reobserve all anchors after reads; changing provider snapshots cannot authorize credit.
      if (await this.canonicalHash(safe.number) !== safe.hash || await this.canonicalHash(receipt.blockNumber) !== block.hash
        || await this.canonicalHash(binding.preacceptBlock) !== evidence.preacceptCanonicalHash) return null;
      return evidence;
    } catch { return null; }
  }
}
