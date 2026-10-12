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
import { PaymentWorker } from '../../dist/packages/db/src/payment-worker.js';
import { Commerce } from '../../dist/packages/db/src/commerce.js';
import { typed,tokenAbi,exactSettlement } from '../../dist/packages/payments/src/settlement.js';
import { pools,pool,admin,api,workerPool,worker,encryptionKey,origin,provider,seed,purchase,bind,pending,token,payee } from './helpers.mjs';
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
test('EVM-C01 regression: a reorg replacement must not fulfill a previously late expired order',async()=>{
 const p=await purchase(fixture.product,commerce),id=await bind(p,randomUUID(),commerce);await pending(id);
 // Same legacy expired-order arrangement used by author B3-29; current cancel cannot expire a bound attempt.
 await admin.query("UPDATE dispatch.orders SET state='expired' WHERE id=$1",[p.order]);
 const snapshot=await request('evm_snapshot'),firstHash=await send(calldata(p));
 const binding=await worker.binding(id),firstEvidence=await rpc.evidence(binding,firstHash);assert.ok(firstEvidence);record('late-before-reorg',binding,firstEvidence);
 let lease=await worker.claimReconcile(id);const firstSettlement=await worker.apply(lease,firstEvidence);
 assert.equal((await commerce.status(p.order,p.grant)).delivery.state,'blocked');
 await request('evm_revert',[snapshot]);await request('evm_increaseTime',[1]);
 // Resubmit the same authorization on the replacement chain in a distinct genuine transaction.
 const secondHash=await request('eth_sendTransaction',[{from:relayer,to:token,data:calldata(p),gas:'0x7a121'}]);
 await client.waitForTransactionReceipt({hash:secondHash});await request('anvil_mine',['0x40','0x0']);assert.notEqual(secondHash,firstHash);
 const secondEvidence=await rpc.evidence(binding,secondHash);assert.ok(secondEvidence);record('late-replacement-after-reorg',binding,secondEvidence);
 await worker.quarantine(firstSettlement,await rpc.canonicalHash(firstEvidence.block));
 await admin.query('UPDATE dispatch.outbox_jobs SET available_at=now() WHERE id=$1',[lease.job]);lease=await worker.claimReconcile(id);
 await worker.apply(lease,secondEvidence);
 const status=await commerce.status(p.order,p.grant);
 const jobs=Number((await admin.query("SELECT count(*) n FROM dispatch.outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0].n);
 const dispositions=(await admin.query('SELECT disposition FROM dispatch.settlements WHERE order_id=$1 ORDER BY recorded_at',[p.order])).rows;
 const incidents=(await admin.query('SELECT kind FROM dispatch.payment_incidents WHERE order_id=$1 ORDER BY created_at',[p.order])).rows;
 console.log(JSON.stringify({probe:'genuine-reorg-late-replacement',firstHash,secondHash,state:status.order_state,fulfillment_state:status.delivery.state,dispositions,incidents,entitlement_jobs:jobs}));
 assert.equal(jobs,0,'reorg replacement of late funds must retain blocked fulfillment');
 assert.equal((await admin.query("SELECT count(*) n FROM dispatch.settlements WHERE order_id=$1 AND disposition='credited'",[p.order])).rows[0].n,'0');
 assert.equal((await admin.query('SELECT count(*) n FROM dispatch.entitlements WHERE order_id=$1',[p.order])).rows[0].n,'0');
 assert.equal(status.order_state,'review_required');assert.equal(status.delivery.state,'blocked');
 assert.equal((await admin.query("SELECT count(*) n FROM dispatch.payment_incidents WHERE order_id=$1 AND kind='reorg' AND resolved_at IS NULL",[p.order])).rows[0].n,'1');
 assert.equal((await admin.query('SELECT count(DISTINCT attempt_id) n FROM dispatch.settlements WHERE order_id=$1',[p.order])).rows[0].n,'1');
 const restarted=new PaymentWorker(workerPool,encryptionKey);
 await admin.query('UPDATE dispatch.outbox_jobs SET available_at=now() WHERE id=$1',[lease.job]);
 const stale=await restarted.claimReconcile(id);
 await admin.query("UPDATE dispatch.outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[stale.job]);
 const current=await restarted.claimReconcile(id);
 await assert.rejects(restarted.apply(stale,secondEvidence),/stale_settlement/);
 await restarted.apply(current,secondEvidence);await restarted.apply(current,firstEvidence);
 assert.equal((await admin.query('SELECT count(*) n FROM dispatch.settlements WHERE order_id=$1',[p.order])).rows[0].n,'2');
 assert.equal((await commerce.status(p.order,p.grant)).delivery.state,'blocked');
 console.log(JSON.stringify({probe:'genuine-reorg-negative-controls',credited:0,entitlement_jobs:0,entitlements:0,retained_settlements:2,unresolved_reorg:1,restarted_worker:true,stale_lease:'rejected',repeated_observations:'deduplicated'}));
});
