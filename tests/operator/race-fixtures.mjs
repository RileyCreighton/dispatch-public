import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

import {createPublicClient,http,encodeFunctionData,parseAbi,parseSignature} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import solc from '../payment/tooling/node_modules/solc/index.js';
import {migrate} from '../../dist/packages/db/src/migrate.js';
import {Commerce,digest} from '../../dist/packages/db/src/commerce.js';
import {LocalRpc} from '../../dist/packages/payments/src/rpc.js';
import {tokenAbi} from '../../dist/packages/payments/src/settlement.js';
import {PrivateFiles,manifestDigest} from '../../dist/packages/fulfillment/src/files.js';
import {operationsReady} from '../../dist/packages/db/src/index.js';
import {OperatorStore} from '../../dist/packages/db/src/operator.js';
import {RefundStore} from '../../dist/packages/db/src/refunds.js';
import {RefundRpc} from '../../dist/packages/payments/src/refund.js';
import {apiServer} from '../../dist/apps/api/src/app.js';
import {submitInitial,reconcileKnown} from '../../dist/apps/worker/src/payments.js';
import {admin,api,pool,pools,worker,encryptionKey,provider,support,token,payee} from '../payment/helpers.mjs';
export {admin,api,worker,pools,token,payee,support};
export const origin='https://127.0.0.1:19743',endpoint='http://127.0.0.1:19746';
export const client=createPublicClient({transport:http(endpoint,{retryCount:0,timeout:2000})}),rpc=new LocalRpc(endpoint);
export const commerce=new Commerce(api,encryptionKey,rpc,origin,provider,()=>operationsReady(api)),logs=[];
export let server,anvil,fixture;
export const operatorPool=pool('local_operator'),operator=new OperatorStore(operatorPool,commerce,new PrivateFiles(process.env.DISPATCH_DB_HOST+'/assets')),refundRpc=new RefundRpc(rpc),refunds=new RefundStore(operator,refundRpc);
export function setFixture(f){fixture=f;}
export const relayer='0x'+'44'.repeat(20),publicEvidence=[];
export const request=(method,params=[])=>client.request({method,params});
export async function localSend(data){const hash=await request('eth_sendTransaction',[{from:relayer,to:token,data,gas:'0x7a120'}]);await client.waitForTransactionReceipt({hash});await request('anvil_mine',['0x40','0x0']);return hash;}
export async function newSigner(){const account=privateKeyToAccount(generatePrivateKey());await localSend(encodeFunctionData({abi:parseAbi(['function fixtureMint(address,uint256)']),functionName:'fixtureMint',args:[account.address,1000000n]}));return account;}
export async function bootApi(){const base=process.env.DISPATCH_DB_HOST;server=apiServer(api,origin,line=>logs.push(line),commerce,{tls:{key:await readFile(base+'/tls.key'),cert:await readFile(base+'/tls.crt')},webDirectory:'apps/web/dist',files:new PrivateFiles(base+'/assets'),operator,refunds});server.listen(19743,'127.0.0.1');await once(server,'listening');}
export async function restartApi(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await bootApi();}
export async function setup(){
  const {createServer}=await import('node:net');const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(Number(new URL(endpoint).port),'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));
  anvil=spawn('tests/payment/tooling/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil',['--host','127.0.0.1','--port','19746','--chain-id','8453','--accounts','0','--silent'],{stdio:'ignore'});
  for(let i=0;i<50;i++){if(anvil.exitCode!==null||anvil.signalCode!==null)throw Error('fixture_evm_exited');try{await client.getChainId();break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.equal(await client.getChainId(),8453);
  const tokenSource=(await readFile('tests/payment/TokenFixture.sol','utf8')).replace('bytes32 s) public {','bytes32 s) public virtual {');
  const out=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'TokenFixture.sol':{content:tokenSource},'BuyerTokenFixture.sol':{content:await readFile('tests/buyer/BuyerTokenFixture.sol','utf8')},'OperatorTokenFixture.sol':{content:await readFile('tests/operator/OperatorTokenFixture.sol','utf8')}},settings:{evmVersion:'cancun',outputSelection:{'*':{'*':['evm.deployedBytecode.object']}}}})));
  assert.equal(out.errors?.some(e=>e.severity==='error')??false,false);
  await request('anvil_setCode',[token,'0x'+out.contracts['OperatorTokenFixture.sol'].OperatorTokenFixture.evm.deployedBytecode.object]);
  await request('anvil_impersonateAccount',[relayer]);await request('anvil_setBalance',[relayer,'0x56bc75e2d63100000']);await request('evm_mine');
  await migrate(pool('local_migrator'));
  await support();await bootApi();
}
export async function teardown(){
  if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});for(const p of pools)await p.end();if(anvil&&anvil.exitCode===null&&anvil.signalCode===null){const exited=once(anvil,'exit');anvil.kill('SIGTERM');await exited;}
  await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/evm.json',JSON.stringify(publicEvidence,null,2)+'\n');
}
export function policy(){return {origin,productId:fixture.product,productVersion:1,maxAtomic:'100',payees:[payee],network:'eip155:8453',token,policyVersion:'policy-1',policyURLs:['https://fixture.invalid/policy/1']};}
export async function settle(order){
  const rows=await admin.query('SELECT id FROM payment_attempts WHERE order_id=$1',[order]);assert.equal(rows.rowCount,1);const attempt=rows.rows[0].id;let settleCalls=0,tx;
  const facilitator={async observe(operation,payment){
    if(operation==='verify')return {observation:{operation,status:200,kind:'verified',code:'verified',transaction:null}};
    settleCalls++;const a=payment.payload.authorization,s=parseSignature(payment.payload.signature);
    tx=await localSend(encodeFunctionData({abi:tokenAbi,functionName:'transferWithAuthorization',args:[a.from,a.to,BigInt(a.value),BigInt(a.validAfter),BigInt(a.validBefore),a.nonce,Number(s.v),s.r,s.s]}));
    return {observation:{operation,status:200,kind:'settled',code:'settled',transaction:tx}};
  }};
  await submitInitial(worker,attempt,facilitator);await reconcileKnown(worker,attempt,rpc);
  assert.equal(settleCalls,1);assert.equal((await client.getTransactionReceipt({hash:tx})).status,'success');
  publicEvidence.push({order,attempt,transaction:tx,chain:'local Anvil 8453, no fork',token_fixture:'BuyerTokenFixture; generated balances, not Circle/native USDC',settleCalls});
  return attempt;
}
export async function httpCall(path,{method='GET',body,headers={}}={}){return fetch(origin+path,{method,redirect:'error',headers:{Origin:origin,...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
