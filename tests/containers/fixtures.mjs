// Disposable, non-forked test provider/chain. Never part of the application image target.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:https';
import {createPublicClient,http,encodeFunctionData,parseSignature} from 'viem';
import {tokenAbi} from './dist/packages/payments/src/settlement.js';
const token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',relayer='0x'+'44'.repeat(20);
assert.equal(process.env.DISPATCH_RUNTIME,'digital-fixture');
const chain=spawn('/app/fixture-bin/anvil',['--host','0.0.0.0','--port','18546','--chain-id','8453','--accounts','0','--state','/journal/anvil.json','--state-interval','1','--preserve-historical-states','--block-time','1','--silent'],{stdio:'ignore'});
const client=createPublicClient({transport:http('http://127.0.0.1:18546',{retryCount:0,timeout:5000})});
const request=(method,params=[])=>client.request({method,params});
for(let i=0;i<100;i++){try{assert.equal(await client.getChainId(),8453);break;}catch{await new Promise(r=>setTimeout(r,100));}}
assert.equal(await client.getChainId(),8453);
const initial=JSON.parse(await readFile('/journal/chain.json','utf8'));
await request('anvil_setCode',[token,initial.bytecode]);
await request('anvil_impersonateAccount',[relayer]);await request('anvil_setBalance',[relayer,'0x56bc75e2d63100000']);await request('evm_mine');
let effects=[];try{effects=JSON.parse(await readFile('/journal/effects.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const server=createServer({key:await readFile('/run/dispatch/tls.key'),cert:await readFile('/run/dispatch/tls.crt'),maxHeaderSize:8192},async(req,res)=>{
 res.setHeader('Content-Type','application/json');
 try{
  if(req.method==='GET'&&req.url==='/supported'){res.end(JSON.stringify({kinds:[{x402Version:2,scheme:'exact',network:'eip155:8453'}],extensions:[],signers:{}}));return;}
  let input='';for await(const b of req){input+=b.toString();if(input.length>65536)throw new Error('limit');}
  const p=JSON.parse(input).paymentPayload;
  if(req.method==='POST'&&req.url==='/verify'){res.end(JSON.stringify({isValid:true,payer:p.payload.authorization.from}));return;}
  if(req.method==='POST'&&req.url==='/settle'){
   const a=p.payload.authorization,s=parseSignature(p.payload.signature),hash=await request('eth_sendTransaction',[{from:relayer,to:token,gas:'0x7a120',data:encodeFunctionData({abi:tokenAbi,functionName:'transferWithAuthorization',args:[a.from,a.to,BigInt(a.value),BigInt(a.validAfter),BigInt(a.validBefore),a.nonce,Number(s.v),s.r,s.s]})}]);
   assert.equal((await client.waitForTransactionReceipt({hash})).status,'success');await request('anvil_mine',['0x40','0x0']);
   effects.push({transaction:hash,source:'generated non-forked Anvil, no real funds'});await writeFile('/journal/effects.json',JSON.stringify(effects),{mode:0o600});
   res.end(JSON.stringify({success:true,transaction:hash,network:'eip155:8453',payer:a.from}));return;
  }
  res.writeHead(404).end('{}');
 }catch{res.writeHead(500).end('{"code":"fixture_failure"}');}
});
server.listen(18447,'127.0.0.1');
const stop=()=>{server.close();chain.kill('SIGTERM');};process.once('SIGTERM',stop);process.once('SIGINT',stop);
