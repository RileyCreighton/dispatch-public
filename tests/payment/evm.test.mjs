import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPublicClient,http,encodeFunctionData,parseAbi,parseSignature } from 'viem';
import { privateKeyToAccount,generatePrivateKey } from 'viem/accounts';
import solc from './tooling/node_modules/solc/index.js';
import { migrate } from '../../dist/packages/db/src/migrate.js';
import { LocalRpc } from '../../dist/packages/payments/src/rpc.js';
import { digest } from '../../dist/packages/db/src/commerce.js';
import { Commerce } from '../../dist/packages/db/src/commerce.js';
import { typed,tokenAbi,exactSettlement } from '../../dist/packages/payments/src/settlement.js';
import { pools,pool,admin,api,worker,encryptionKey,origin,provider,seed,purchase,bind,pending,token,payee } from './helpers.mjs';
const endpoint='http://127.0.0.1:18545';
const client=createPublicClient({transport:http(endpoint,{retryCount:0,timeout:2000})}),rpc=new LocalRpc(endpoint);
const commerce=new Commerce(api,encryptionKey,rpc,origin,provider);
let node,fixture;
const publicEvidence=[];
function record(label,b,e) { const {input,...publicReceipt}=e; publicEvidence.push({label,binding:b,receipt:publicReceipt,call_sha256:digest(input),synthetic_token_no_balances:true}); }
const relayer='0x'+'44'.repeat(20); // Unlocked local impersonation; no relayer key is loaded.
async function request(method,params=[]) {return client.request({method,params});}
async function send(data) {
 const hash=await request('eth_sendTransaction',[{from:relayer,to:token,data,gas:'0x7a120'}]);
 await client.waitForTransactionReceipt({hash});await request('anvil_mine',['0x40','0x0']);return hash;
}
function calldata(p) {
 const a=p.payment.payload.authorization,s=parseSignature(p.payment.payload.signature);
 return encodeFunctionData({abi:tokenAbi,functionName:'transferWithAuthorization',args:[a.from,a.to,BigInt(a.value),BigInt(a.validAfter),BigInt(a.validBefore),a.nonce,Number(s.v),s.r,s.s]});
}
test.before(async()=>{
 node=spawn('tests/payment/tooling/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil',
  ['--host','127.0.0.1','--port','18545','--chain-id','8453','--accounts','0','--silent'],{stdio:'ignore'});
 for(let i=0;i<50;i++){try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.equal(await client.getChainId(),8453);
 const source=await readFile('tests/payment/TokenFixture.sol','utf8');
 const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'TokenFixture.sol':{content:source}},
  settings:{evmVersion:'cancun',outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}})));
 assert.equal(out.errors?.some(e=>e.severity==='error')??false,false);
 const code='0x'+out.contracts['TokenFixture.sol'].TokenFixture.evm.deployedBytecode.object;
 await request('anvil_setCode',[token,code]);await request('anvil_impersonateAccount',[relayer]);
 await request('anvil_setBalance',[relayer,'0x56bc75e2d63100000']);
 await request('evm_mine');await migrate(pool('local_migrator'));fixture=await seed();
});
test.after(async()=>{await writeFile(process.env.DISPATCH_DB_HOST+'/evm-public-evidence.json',JSON.stringify(publicEvidence,(_k,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');for(const p of pools)await p.end();if(node){node.kill('SIGTERM');await once(node,'exit');}});
test('EVM-01 actual local execution: independent preaccept/domain/EOA proof and exact safe receipt commit',async()=>{
 const p=await purchase(fixture.product,commerce),id=await bind(p,randomUUID(),commerce);await pending(id);
 const hash=await send(calldata(p)),binding=await worker.binding(id),e=await rpc.evidence(binding,hash);
 assert.ok(e);record('exact-transfer',binding,e);
 console.log(JSON.stringify({diagnostic:'local_evm_heads',status:e.receiptStatus,block:String(e.block),anchor:String(binding.preacceptBlock),safe:String(e.safeHead),chainTime:String(e.blockTime),validBefore:binding.validBefore,anchorMatches:e.preacceptCanonicalHash===binding.preacceptHash,canonical:e.blockHash===e.canonicalHash}));
 assert.equal(exactSettlement(binding,e).transaction,hash);
 const l=await worker.claimReconcile(id);await worker.apply(l,e);
 assert.equal((await commerce.status(p.order,p.grant)).order_state,'paid');
 assert.equal((await admin.query("SELECT count(*) n FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0].n,'1');
});
test('EVM-02 historical public signed authorization cannot be rebound to a fresh order',async()=>{
 const p=await purchase(fixture.product,commerce);await send(calldata(p));
 await assert.rejects(bind(p,randomUUID(),commerce),/preaccept_unusable/);
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[p.order])).rows[0].n,'0');
});
test('EVM-03 canonical cancellation consumes nonce without creating a paid settlement or releasing exposure',async()=>{
 const p=await purchase(fixture.product,commerce),id=await bind(p,randomUUID(),commerce);await pending(id);
 const a=p.payment.payload.authorization;
 const sig=await p.account.signTypedData({domain:{name:'USD Coin',version:'2',chainId:8453,verifyingContract:token},
  primaryType:'CancelAuthorization',types:{CancelAuthorization:[{name:'authorizer',type:'address'},{name:'nonce',type:'bytes32'}]},message:{authorizer:a.from,nonce:a.nonce}});
 const s=parseSignature(sig),abi=parseAbi(['function cancelAuthorization(address authorizer,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
 const hash=await send(encodeFunctionData({abi,functionName:'cancelAuthorization',args:[a.from,a.nonce,Number(s.v),s.r,s.s]}));
 const b=await worker.binding(id),e=await rpc.evidence(b,hash);assert.ok(e);record('cancellation',b,e);
 const l=await worker.claimReconcile(id);await assert.rejects(worker.apply(l,e),/settlement_review_required/);
 assert.equal((await admin.query('SELECT count(*) n FROM settlements WHERE order_id=$1',[p.order])).rows[0].n,'0');
 assert.equal((await admin.query('SELECT released_at FROM budget_allocations WHERE attempt_id=$1',[id])).rows[0].released_at,null);
});
test('EVM-04 expired genuine authorization transaction reverts and cannot fulfill',async()=>{
 const p=await purchase(fixture.product,commerce),id=await bind(p,randomUUID(),commerce);await pending(id);
 const snapshot=await request('evm_snapshot');
 try{
  await request('evm_setNextBlockTimestamp',[Number(p.payment.payload.authorization.validBefore)+1]);
  const hash=await send(calldata(p));assert.equal((await client.getTransactionReceipt({hash})).status,'reverted');
  const b=await worker.binding(id),l=await worker.claimReconcile(id),e=await rpc.evidence(b,hash);assert.ok(e);record('expired-reverted',b,e);
  await assert.rejects(worker.apply(l,e),/settlement_review_required/);
 }finally{await request('evm_revert',[snapshot]);}
});
test('EVM-05 actual local reorg changes canonical inclusion and preserves quarantined ledger',async()=>{
 const p=await purchase(fixture.product,commerce),id=await bind(p,randomUUID(),commerce);await pending(id);
 const snapshot=await request('evm_snapshot'),hash=await send(calldata(p));
 const b=await worker.binding(id),e=await rpc.evidence(b,hash);assert.ok(e);record('pre-reorg',b,e);
 const l=await worker.claimReconcile(id),settlement=await worker.apply(l,e);
 await request('evm_revert',[snapshot]);await request('evm_increaseTime',[2]);await request('anvil_mine',['0x40','0x0']);
 const canonical=await rpc.canonicalHash(e.block);assert.notEqual(canonical,e.blockHash);publicEvidence.push({label:'reorg-replacement',block:String(e.block),prior_hash:e.blockHash,canonical_hash:canonical});
 await worker.quarantine(settlement,canonical);
 assert.equal((await commerce.status(p.order,p.grant)).order_state,'review_required');
 assert.equal((await admin.query('SELECT count(*) n FROM settlements WHERE id=$1',[settlement])).rows[0].n,'1');
});
