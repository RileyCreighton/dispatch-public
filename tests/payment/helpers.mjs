import { readFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hashDomain, encodeFunctionData, encodeEventTopics, encodeAbiParameters } from 'viem';
import { Pool } from 'pg';
import { Commerce, digest } from '../../dist/packages/db/src/commerce.js';
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
import { tokenAbi, typed } from '../../dist/packages/payments/src/settlement.js';
import { storeSupport } from '../../dist/packages/db/src/index.js';
export const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payee = '0x' + '22'.repeat(20);
export const origin = 'http://127.0.0.1:18083', provider = 'https://fixture.invalid';
export const pools = [];
export function pool(user) {
  const p = new Pool({ host: process.env.DISPATCH_DB_HOST, port: 55442, user, database: 'dispatch', max: 32,
    options: '-c search_path=dispatch,pg_catalog', statement_timeout: 5000 }); pools.push(p); return p;
}
export const admin = pool('fixture_admin'), api = pool('local_api'), workerPool = pool('local_worker');
export const encryptionKey = readFileSync(process.env.DISPATCH_DB_HOST+'/fixture.key'), worker = new PaymentWorker(workerPool, encryptionKey);
export const domainSeparator = hashDomain({ domain: { name: 'USD Coin', version: '2', chainId: 8453n, verifyingContract: token },
  types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } });
export const chain = {
  async preaccept() {
    return { block: 100n, hash: digest('block100'), chainTime: BigInt(Math.floor(Date.now()/1000)), observedAt: Date.now(), nonceUsed: false,
      chainId: 8453, token, domainName: 'USD Coin', domainVersion: '2', domainSeparator, decimals: 6 };
  },
  async evidence() { return null; }, async canonicalHash() { return digest('block100'); }
};
export const commerce = new Commerce(api, encryptionKey, chain, origin, provider);
export async function support() {
  // One observation defines the fixture window even if execution crosses a millisecond.
  const fetchedAt=Date.now();
  await storeSupport(workerPool, { provider_origin: provider, fetched_at: fetchedAt, expires_at: fetchedAt+60000,
  supported_kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:8453' }] }, provider); }
export async function seed() {
  const config=randomUUID(), asset=randomUUID(), product=randomUUID();
  await admin.query(`INSERT INTO merchant_config_versions(id,version,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,policy_version,policy_urls,finality_policy)
    VALUES($1,1,'single',$2,'Synthetic',$3,8453,'eip155:8453',$4,6,'policy-1','["https://fixture.invalid/policy/1"]','safe')`,[config,origin,payee,token]);
  await admin.query(`INSERT INTO asset_versions(id,manifest_sha256,file_sha256,private_relative_path,mime_type,download_name,size_bytes)
    VALUES($1,$2,$2,'fixture.txt','text/plain','fixture.txt',13)`,[asset,digest('fixture')]);
  await admin.query(`INSERT INTO products(product_id,version,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version)
    VALUES($1,1,'Fixture','Synthetic','digital',$2,1,'merchant_attested_zero','owner-fixture','1','policy-1')`,[product,asset]);
  await admin.query('INSERT INTO product_publication VALUES($1,1,true)',[product]);
  await admin.query('UPDATE merchant_control SET config_id=$1,payment_paused=false,max_order=100,max_day_gross=1000000',[config]);
  await support(); return {product,config,asset};
}
export async function purchase(product, instance=commerce) {
  const created=await instance.create({product_id:product,product_version:1,quantity:1,client_kind:'agent'});
  const grant=created.agent_capability; await instance.status(created.id,grant);
  const q=await instance.quote(created.id,grant,randomUUID(),{product_version:1,quantity:1,policy_version:'policy-1'});
  const required=await instance.paymentChallenge(created.id,grant,q.id,q.quote_hash);
  const account=privateKeyToAccount(generatePrivateKey());
  const a={from:account.address,to:payee,value:q.total_atomic,validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+25),nonce:'0x'+randomBytes(32).toString('hex')};
  const signature=await account.signTypedData(typed({...a,token,domainName:'USD Coin',domainVersion:'2'}));
  const payment={x402Version:2,resource:required.resource,accepted:required.accepts[0],payload:{authorization:a,signature}};
  return {order:created.id,grant,q,payment,account};
}
export function bind(p, k=randomUUID(), instance=commerce) { return instance.bind(p.order,p.grant,k,p.q.id,p.q.quote_hash,p.payment); }
export function evidence(b, tx=digest(randomUUID())) {
  const blockHash=digest('block101');
  const logs=[{address:token,topics:encodeEventTopics({abi:tokenAbi,eventName:'AuthorizationUsed',args:{authorizer:b.from,nonce:b.nonce}}),data:'0x',logIndex:0},
    {address:token,topics:encodeEventTopics({abi:tokenAbi,eventName:'Transfer',args:{from:b.from,to:b.to}}),data:encodeAbiParameters([{type:'uint256'}],[BigInt(b.value)]),logIndex:1}]
    .map(l=>({...l,transactionHash:tx,blockHash,removed:false}));
  return {chainId:8453,transactionHash:tx,transactionTo:token,transactionValue:0n,
    input:encodeFunctionData({abi:tokenAbi,functionName:'transferWithAuthorization',args:[b.from,b.to,BigInt(b.value),BigInt(b.validAfter),BigInt(b.validBefore),b.nonce,27,'0x'+'11'.repeat(32),'0x'+'22'.repeat(32)]}),
    receiptStatus:'success',block:101n,blockHash,canonicalHash:blockHash,preacceptCanonicalHash:b.preacceptHash,
    blockTime:BigInt(Math.floor(Date.now()/1000)),safeHead:101n,safeHash:blockHash,logs};
}
export const verified={operation:'verify',status:200,kind:'verified',code:'verified',transaction:null};
export const unknown={operation:'settle',status:null,kind:'unknown',code:'transport_error',transaction:null};
export async function pending(id) { const v=await worker.claim(id,'verify');await worker.save(v,verified);const s=await worker.claim(id,'settle');await worker.save(s,unknown);return s; }
