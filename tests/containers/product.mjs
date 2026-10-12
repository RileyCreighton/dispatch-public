import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createPublicClient,createWalletClient,custom,encodeFunctionData,parseAbi} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {chromium} from 'playwright';
import {captureDiagnostics,safeScreenshot} from '../../scripts/safe-browser-diagnostics.mjs';
import {createPurchase,authorizePurchase,resumePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
const config=process.env.DISPATCH_DIGITAL_CONFIG,state=process.env.DISPATCH_DIGITAL_STATE,out=process.env.DISPATCH_DIGITAL_OUTPUT;
const compose=['compose','-f',config],origin='https://127.0.0.1:18443',token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',payee='0x'+'22'.repeat(20),bytes=Buffer.from('Exact container private bytes\n');
const run=(args,input)=>execFileSync('docker',[...compose,...args],{input,stdio:['pipe','pipe','pipe'],timeout:60000});
const remote=`import https from'node:https';import{readFileSync}from'node:fs';let s='';for await(const b of process.stdin)s+=b;const x=JSON.parse(s);const q=https.request('https://127.0.0.1:18443'+x.path,{method:x.method,ca:readFileSync('/run/dispatch/tls.crt'),headers:{Origin:'https://127.0.0.1:18443','Content-Type':'application/json',...x.headers}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,cookie:r.headers['set-cookie']?.[0]?.split(';')[0],body:b?JSON.parse(b):null})));});q.on('error',()=>process.exit(2));q.end(x.body===undefined?undefined:JSON.stringify(x.body));`;
let cookie,csrf;const password=randomBytes(32).toString('base64url');
const api=async(path,method='GET',body,headers={})=>JSON.parse(run(['exec','-T','api','node','--input-type=module','-e',remote],JSON.stringify({path:'/v1/operator'+path,method,body,headers:{...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),'Idempotency-Key':randomUUID(),...headers}})));
const ok=async(...a)=>{const r=await api(...a);assert.ok(r.status>=200&&r.status<300,JSON.stringify({path:a[0],status:r.status,body:r.body}));return r.body;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rpcBridge=custom({request:async({method,params})=>{const source="let s='';for await(const b of process.stdin)s+=b;const x=JSON.parse(s),r=await fetch('http://127.0.0.1:18546',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,...x})});const j=await r.json();if(j.error)process.exit(2);console.log(JSON.stringify(j.result));";return JSON.parse(run(['exec','-T','fixtures','node','--input-type=module','-e',source],JSON.stringify({method,params})));}},{retryCount:0});
const chain=createPublicClient({transport:rpcBridge}),request=(method,params=[])=>chain.request({method,params});
async function signer(){const a=privateKeyToAccount(generatePrivateKey());const hash=await request('eth_sendTransaction',[{from:'0x'+'44'.repeat(20),to:token,gas:'0x7a120',data:encodeFunctionData({abi:parseAbi(['function fixtureMint(address,uint256)']),functionName:'fixtureMint',args:[a.address,1000000n]})}]);assert.equal((await chain.waitForTransactionReceipt({hash})).status,'success');await request('anvil_mine',['0x40','0x0']);return a;}
const passed=[];async function step(name,fn){console.log('START',name);await fn();passed.push(name);await writeFile(out+'/product-results.json',JSON.stringify({passed,status:'partial'},null,2)+'\n');console.log('PASS',name);}
let product,version,purchase,policy,agentDirectory,pendingDirectory,pendingPurchase,bound,refundHash,pendingAuthorityHash,pendingAllocationHash;
const sql=(q,vars={})=>run(['exec','-T','postgres','psql','-At','-v','ON_ERROR_STOP=1','-U','local_cluster_admin','-d','dispatch',...Object.entries(vars).flatMap(([k,v])=>{assert.match(k,/^[a-z_]+$/);assert.match(v,/^[0-9a-f-]{36}$/);return ['-v',k+'='+v];})],q).toString();
const pendingHash=kind=>createHash('sha256').update(sql(kind==='attempt'?"SELECT row_to_json(t)::text FROM dispatch.payment_attempts t WHERE order_id=:'order_id';":"SELECT row_to_json(t)::text FROM dispatch.budget_allocations t JOIN dispatch.payment_attempts a ON a.id=t.attempt_id WHERE a.order_id=:'order_id' ORDER BY utc_day;",{order_id:pendingPurchase.order})).digest('hex');
async function observePending(stage){
 // Metadata only: no authorization, key, buyer grant, address or raw transaction.
 const observations=[];
 try{const row=sql("SELECT json_build_object('state',state,'valid_before',valid_before::text,'wall_seconds',floor(extract(epoch FROM clock_timestamp()))::text) FROM dispatch.payment_attempts WHERE order_id=:'order_id';",{order_id:pendingPurchase.order}).trim();observations.push({database:JSON.parse(row)});}catch{observations.push({database:'unavailable'});}
 try{const b=await chain.getBlock();observations.push({chain_time:String(b.timestamp),block:String(b.number)});}catch{observations.push({chain:'unavailable'});}
 await writeFile(out+'/pending-'+stage+'.json',JSON.stringify({stage,observed_at:new Date().toISOString(),observations},null,2)+'\n',{mode:0o600});
}
async function backup(name){
 run(['stop','api']);
 const hashes={};for(const table of sql("SELECT tablename FROM pg_tables WHERE schemaname='dispatch' ORDER BY tablename;").trim().split('\n')){assert.match(table,/^[a-z_]+$/);hashes[table]=createHash('sha256').update(sql('SELECT row_to_json(t)::text FROM dispatch.'+table+' t ORDER BY row_to_json(t)::text;')).digest('hex');}
 await writeFile(state+'/'+name+'-hashes.json',JSON.stringify(hashes),{mode:0o600});
 await writeFile(state+'/'+name+'.dump',run(['exec','-T','postgres','pg_dump','-Fc','-U','local_cluster_admin','-d','dispatch']),{mode:0o600});
 run(['start','api']);for(let i=0;i<30;i++){try{if((await fetch(origin+'/health/live')).ok)break;}catch{}await sleep(1000);}
}
async function loginAgain(){cookie=undefined;csrf=undefined;const c=await api('/session/challenge'),r=await api('/session','POST',{password},{Cookie:c.cookie,'X-CSRF-Token':c.body.csrf_token});assert.equal(r.status,200);cookie=r.cookie;csrf=r.body.csrf_token;}

await step('D8-01 built-container bootstrap, zero-state configuration, asset import and product publication',async()=>{
 const health=await fetch(origin+'/health/live');assert.equal(health.status,200);assert.equal(health.headers.get('content-security-policy'),"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");assert.equal(health.headers.get('x-content-type-options'),'nosniff');
 const shell=await fetch(origin+'/buy/fixture');assert.equal(shell.status,200);assert.equal(shell.headers.get('x-content-type-options'),'nosniff');assert.ok(shell.headers.get('content-security-policy').startsWith("default-src 'self';"));
 assert.equal((await fetch(origin+'/v1/operator/config')).status,404);
 run(['run','--rm','-T','migration','node','scripts/operator-local.mjs','begin',origin,'/bootstrap/operator']);
 run(['run','--rm','-T','migration','node','scripts/operator-local.mjs','complete','/bootstrap/operator'],password+'\n');
 const challenge=await api('/session/challenge');const login=await api('/session','POST',{password},{Cookie:challenge.cookie,'X-CSRF-Token':challenge.body.csrf_token});assert.equal(login.status,200);cookie=login.cookie;csrf=login.body.csrf_token;
 assert.equal((await ok('/config')).config_version,0);
 await ok('/config','PUT',{expected_config_version:0,merchant_name:'Container local fixture',pay_origin:origin,payee,confirmation_payee:payee,policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']});
 const asset=JSON.parse(run(['run','--rm','-T','migration','node','scripts/operator-local.mjs','import','/private-assets','guide.txt','guide.txt','text/plain'])).asset_manifest_id;
 const p=await ok('/products','POST',{title:'Container guide',description:'Generated private local fixture',kind:'digital',asset_manifest_id:asset,unit_atomic:'100',tax_status:'merchant_attested_zero',tax_source:'local fixture',tax_version:'1',policy_version:'policy-1',enabled:true,expected_version:0});product=p.id;assert.equal(p.purchase_path,'/buy/'+product);
 const connector=JSON.parse(run(['run','--rm','-T','migration','node','scripts/connector-local.mjs',product,'1']));version=connector.version;
 const readiness=await ok('/readiness');await writeFile(out+'/setup-readiness.json',JSON.stringify(readiness,null,2));
 const block=await chain.getBlock();await writeFile(out+'/setup-chain-time.json',JSON.stringify({block:String(block.number),chain_time:String(block.timestamp),wall_time:Math.floor(Date.now()/1000)},null,2));
 const cfg=await ok('/config');await ok('/pause/payments','POST',{paused:false,expected_version:cfg.controls.version,reason:'Explicit disposable container qualification'});
 assert.equal((await ok('/readiness')).payments_ready,true);
 policy={origin,productId:product,productVersion:version,maxAtomic:'100',payees:[payee],network:'eip155:8453',token,policyVersion:'policy-1',policyURLs:['https://fixture.invalid/policy/1']};
});
await step('D8-02 maintained upstream agent, lost-response recovery, worker settlement and exact private bytes',async()=>{
 agentDirectory=state+'/agent';const journal=await createPurchase(policy,agentDirectory);purchase=await journal.read();let signs=0,dropped=false;const account=await signer();
 const transport=async(input,init)=>{const r=await fetch(input,init);if(new Headers(init?.headers??(input instanceof Request?input.headers:undefined)).has('PAYMENT-SIGNATURE')&&!dropped){dropped=true;throw Error('generated_lost_response');}return r;};
 await assert.rejects(authorizePurchase(agentDirectory,policy,{address:account.address,signTypedData:async x=>{signs++;return account.signTypedData(x);}},transport));assert.equal(dropped,true);assert.equal(signs,1);
 let s;for(let i=0;i<35;i++){s=await resumePurchase(agentDirectory);if(s.delivery.state==='available')break;await sleep(1000);}assert.equal(s.payment_state,'settled');assert.equal(s.delivery.state,'available');assert.deepEqual(await retrievePurchase(agentDirectory),bytes);assert.equal(signs,1);
});
await step('D8-03 durable merchant receiver receipt from the worker HTTPS handoff',async()=>{
 let s;for(let i=0;i<25;i++){s=await ok('/orders/'+purchase.order);if(s.status.merchant_handoff?.state==='recorded')break;await sleep(1000);}assert.equal(s.status.merchant_handoff.state,'recorded');
 const rows=run(['exec','-T','postgres','psql','-At','-U','local_receiver','-d','merchant','-c','SELECT count(*),count(DISTINCT receipt_id) FROM merchant_adapter.orders']).toString().trim();assert.equal(rows,'1|1');
});
await step('D8-04 explicit local wallet-approved refund, confirmed reconciliation and retained access',async()=>{
 const account=await signer();await request('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);const order=(await ok('/orders/'+purchase.order)).order;
 const refund=await ok('/orders/'+purchase.order+'/refunds','POST',{settlement_id:order.settlement_id,confirmed_original_payer:order.original_payer,expected_signer:account.address.toLowerCase()});
 const b=await ok('/refunds/'+refund.id+'/wallet-start','POST',{expected_version:refund.version,signer:account.address.toLowerCase(),observed_account_nonce:String(await chain.getTransactionCount({address:account.address,blockTag:'pending'}))});
 bound=b;run(['stop','worker','receiver']);pendingDirectory=state+'/pending-agent';const j=await createPurchase(policy,pendingDirectory);pendingPurchase=await j.read();await authorizePurchase(pendingDirectory,policy,await signer());
 pendingAuthorityHash=pendingHash('attempt');pendingAllocationHash=pendingHash('allocation');assert.equal(sql('SELECT count(*) FROM dispatch.refund_invocations;').trim(),'0');assert.equal(sql('SELECT state FROM dispatch.refunds;').trim(),'wallet_pending');
 await observePending('before-backup');await backup('old');await observePending('after-backup');run(['start','worker']);try{for(let i=0;i<40;i++){if((await resumePurchase(pendingDirectory)).payment_state==='settled')break;await sleep(1000);}assert.equal((await resumePurchase(pendingDirectory)).payment_state,'settled');}finally{await observePending('after-wait');}
 run(['stop','worker']);await ok('/refunds/'+refund.id+'/invocation','POST',{expected_version:b.version});await ok('/refunds/'+refund.id+'/authorization','POST',{expected_version:b.version});
 const hash=await createWalletClient({account,transport:rpcBridge}).sendTransaction({chain:{id:8453,name:'Non-forked local fixture',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['http://127.0.0.1:18546']}}},to:b.binding.transaction_to,data:b.binding.transaction_calldata,value:0n,nonce:Number(b.binding.wallet_account_nonce)});
 refundHash=hash;await ok('/refunds/'+refund.id+'/observation','POST',{expected_version:b.version,invocation_version:b.version,outcome:'unknown'});assert.equal(sql('SELECT state FROM dispatch.refunds;').trim(),'broadcast_unknown');assert.equal(sql('SELECT count(*) FROM dispatch.refund_invocations;').trim(),'1');assert.ok(Number(sql("SELECT count(*) FROM dispatch.outbox_jobs WHERE effect_type='merchant_paid' AND state IN ('queued','retry','leased');"))>0);await backup('ambiguous');run(['start','worker','receiver']);
 await ok('/refunds/'+refund.id+'/observation','POST',{expected_version:b.version,invocation_version:b.version,outcome:'transaction_hash',transaction_hash:hash});await request('anvil_mine',['0x40','0x0']);
 let current;for(let i=0;i<30;i++){current=await ok('/refunds/'+refund.id);if(current.state==='confirmed')break;await sleep(1000);}assert.equal(current.state,'confirmed');assert.deepEqual(await retrievePurchase(agentDirectory),bytes);
});
await step('D8-05 actual Chromium human purchase through the edge with a private trusted fixture CA',async()=>{
 const nss=state+'/home/.pki/nssdb';await mkdir(nss,{recursive:true});execFileSync('certutil',['-N','--empty-password','-d','sql:'+nss]);execFileSync('certutil',['-A','-d','sql:'+nss,'-n','Dispatch disposable CA','-t','C,,','-i',state+'/tls.crt']);
 const browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox'],env:{...process.env,HOME:state+'/home'}});
 try{const ctx=await browser.newContext(),page=await ctx.newPage(),account=await signer(),capture=captureDiagnostics(page);let signs=0;page.setDefaultTimeout(15000);
 await page.exposeFunction('__sign',async data=>{signs++;return account.signTypedData(JSON.parse(data));});await page.exposeFunction('__rpc',(m,p)=>request(m,p));
 await page.addInitScript(address=>{const provider={on(){},removeListener(){},async request({method,params}){if(['eth_accounts','eth_requestAccounts'].includes(method))return[address];if(method==='eth_chainId')return'0x2105';if(method==='eth_signTypedData_v4')return window.__sign(params[1]);if(method==='eth_call')return window.__rpc(method,params);throw Error('unsupported');}};window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'11111111-1111-4111-8111-111111111111',name:'Generated local wallet',icon:'data:image/svg+xml,<svg/>',rdns:'fixture.invalid'},provider}})));},account.address);
 await page.goto(origin+'/buy/'+product);await page.getByRole('button',{name:'Begin checkout',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Review exact quote',exact:true}).click();await page.getByRole('button',{name:'Connect a wallet',exact:true}).click();await page.getByRole('button',{name:'Connect Generated local wallet',exact:true}).click();await page.getByRole('button',{name:/^Authorize /}).click();await page.getByRole('link',{name:'Download file',exact:true}).waitFor({timeout:45000});assert.equal(signs,1);
 const download=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download file',exact:true}).click()]);assert.deepEqual(await readFile(await download[0].path()),bytes);
 await page.getByText('Merchant handoff: recorded. This is not shipment evidence.',{exact:true}).waitFor({timeout:30000});
 const canary='B8CONTAINERCANARY'+randomBytes(24).toString('hex');await page.evaluate(value=>{const input=document.createElement('input');input.type='text';input.autocomplete='off';input.dataset.containerCanary='true';input.style.cssText='position:fixed;top:90px;left:10px;width:250px;z-index:1000';input.value=value;document.body.append(input);},canary);
 const stableCapture=async path=>{await page.locator('input[data-container-canary]').blur();await page.mouse.move(0,0);await page.evaluate(async()=>{window.scrollTo(0,0);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await safeScreenshot(page,path);};
 await page.locator('input[data-container-canary]').fill(canary);await stableCapture(out+'/container-masked-a.png');await page.locator('input[data-container-canary]').fill('B8CONTAINERCANARY'+randomBytes(24).toString('hex'));await stableCapture(out+'/container-masked-b.png');assert.equal(createHash('sha256').update(await readFile(out+'/container-masked-a.png')).digest('hex'),createHash('sha256').update(await readFile(out+'/container-masked-b.png')).digest('hex'),'masked screenshots must be byte-identical');
 const metadata=await capture.save(out);assert.ok(metadata.requests>5);assert.ok(!(await readFile(out+'/sanitized.har','utf8')).includes(canary));

 }finally{await browser.close();}
});
await step('D8-06 missing API cannot fall through to native service; ordinary merchant checkout remains usable',async()=>{
 const canary='B8EDGECANARY'+randomBytes(24).toString('hex'),headers={Origin:origin,Authorization:'Bearer '+canary,Cookie:'fixture='+canary,'Content-Type':'application/json','X-Private-Canary':canary};
 const invalid=await fetch(origin+'/v1/missing/'+canary+'?capability='+canary,{method:'POST',headers,body:JSON.stringify({private_key:canary})});assert.equal(invalid.status,400);assert.ok(!(await invalid.text()).includes(canary));
 const noOrigin=new Headers(headers);noOrigin.delete('Origin');const forbidden=await fetch(origin+'/v1/missing/'+canary,{method:'POST',headers:noOrigin,body:JSON.stringify({private_key:canary})});assert.equal(forbidden.status,403);assert.ok(!(await forbidden.text()).includes(canary));
 const missing=await fetch(origin+'/v1/missing/'+canary,{method:'POST',headers,body:JSON.stringify({private_key:canary})});assert.equal(missing.status,404);assert.ok(!(await missing.text()).includes(canary));
 run(['stop','api']);assert.match(await (await fetch(origin+'/buy/'+product)).text(),/<div id="root"><\/div>/);let refused=false;try{const r=await fetch(origin+'/v1/catalog');refused=!r.ok;}catch{refused=true;}assert.equal(refused,true);
 const unavailable=await fetch(origin+'/v1/missing/'+canary+'?capability='+canary,{method:'POST',headers,body:JSON.stringify({private_key:canary})});assert.equal(unavailable.status,502);assert.ok(!(await unavailable.text()).includes(canary));
 const logs=run(['logs','--no-color','edge','api','worker']).toString();assert.ok(!logs.includes(canary));assert.match(logs,/"status":502/);assert.match(logs,/"status":404/);assert.match(logs,/"status":400/);assert.match(logs,/"status":403/);await writeFile(out+'/container-diagnostics.log',logs);await writeFile(out+'/container-diagnostics.json',JSON.stringify({canary_found:false,required_400_403_404_and_502_metadata:true,logs_bytes:Buffer.byteLength(logs)})+'\n');
 const ordinary=run(['exec','-T','receiver','node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:18085/ordinary-checkout',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'name=Local+fixture'});if(r.status!==200)process.exit(1);console.log(await r.text())"]).toString();assert.match(ordinary,/Ordinary checkout accepted/);
 run(['start','api']);for(let i=0;i<30;i++){try{if((await fetch(origin+'/health/live')).ok)break;}catch{}await sleep(1000);}assert.deepEqual(await retrievePurchase(agentDirectory),bytes);
});
await step('D8-07 fresh-volume old/ambiguous/repeated restores retain authority, uncertainty, keys, receipts and private recovery',async()=>{
 run(['stop','worker']);await backup('recent');await writeFile(state+'/receiver-final.dump',run(['exec','-T','postgres','pg_dump','-Fc','-U','local_cluster_admin','-d','merchant']),{mode:0o600});
 const effects=()=>run(['exec','-T','fixtures','node','-e',"process.stdout.write(require('fs').readFileSync('/journal/effects.json'))"]).toString();const beforeEffects=effects();
 for(const [i,snapshot]of ['old','ambiguous','recent','old'].entries()){
  execFileSync('python3',['scripts/restore-digital-container.py',snapshot,String(i)],{stdio:['ignore','pipe','pipe'],timeout:300000});
  await loginAgain();assert.equal((await ok('/config')).config.merchant_name,'Container local fixture');
  assert.throws(()=>run(['run','--rm','-T','migration','node','scripts/operator-local.mjs','begin',origin,'/bootstrap/repeated-'+i]));
  assert.equal((await api('/pause/payments','POST',{paused:false,expected_version:(await ok('/config')).controls.version,reason:'must remain fenced'})).status,503);
  for(const suffix of ['/invocation','/authorization','/wallet-start'])assert.equal((await api('/refunds/'+bound.id+suffix,'POST',{expected_version:bound.version})).status,503);
  await assert.rejects(createPurchase(policy,state+'/forbidden-'+i));
  assert.deepEqual(await retrievePurchase(agentDirectory),bytes);
  let restored;for(let n=0;n<30;n++){restored=await ok('/refunds/'+bound.id);if(restored.state===(snapshot==='old'?'review_required':'confirmed'))break;await sleep(1000);}assert.equal(restored.state,snapshot==='old'?'review_required':'confirmed');
  assert.equal(sql('SELECT count(*) FROM dispatch.refund_invocations;').trim(),snapshot==='old'?'0':'1');
  if(snapshot==='old')assert.equal(sql("SELECT verification_evidence->>'reason' FROM dispatch.refunds;").trim(),'missing_invocation_association');
  assert.equal((await chain.getTransactionReceipt({hash:refundHash})).status,'success');
  if(snapshot==='old'){assert.notEqual((await resumePurchase(pendingDirectory)).payment_state,'settled');assert.equal(pendingHash('attempt'),pendingAuthorityHash);assert.equal(pendingHash('allocation'),pendingAllocationHash);assert.equal(sql("SELECT count(*) FROM dispatch.budget_allocations t JOIN dispatch.payment_attempts a ON a.id=t.attempt_id WHERE a.order_id=:'order_id' AND t.released_at IS NULL;",{order_id:pendingPurchase.order}).trim(),'1');}
  else {for(let n=0;n<30;n++){if((await resumePurchase(pendingDirectory)).delivery.state==='available')break;await sleep(1000);}assert.deepEqual(await retrievePurchase(pendingDirectory),bytes);}
  assert.equal(effects(),beforeEffects,'restore submitted a new provider effect');
  const rows=run(['exec','-T','postgres','psql','-At','-U','local_receiver','-d','merchant','-c','SELECT count(*),count(DISTINCT receipt_id) FROM merchant_adapter.orders']).toString().trim();assert.equal(rows,'3|3');
 }
});
await step('D8-08 missing and mismatched recovery keys/assets prevent preflight and private delivery',async()=>{
 const c=JSON.parse(await readFile(config,'utf8')),image=c.services.api.image;
 const material=(kind,code)=>execFileSync('docker',['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','1000:1000','--mount','type=volume,source='+c.volumes[kind].name+',target=/material',image,'node','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe'],timeout:60000});
 const check=()=>run(['run','--rm','--no-deps','-T','api','node','scripts/verify-recovery-material.mjs']);
 run(['stop','worker','api']);
 material('api-material',"import{rename}from'node:fs/promises';await rename('/material/encryption.key','/material/encryption.saved');");assert.throws(check);
 material('api-material',"import{writeFile}from'node:fs/promises';await writeFile('/material/encryption.key',Buffer.alloc(32),{mode:0o600});");assert.throws(check);
 material('api-material',"import{rename,unlink}from'node:fs/promises';await unlink('/material/encryption.key');await rename('/material/encryption.saved','/material/encryption.key');");
 material('private-assets',"import{rename,writeFile}from'node:fs/promises';await rename('/material/guide.txt','/material/guide.saved');await writeFile('/material/guide.txt','mismatch',{mode:0o600});");assert.throws(check);
 run(['start','api']);for(let i=0;i<30;i++){try{if((await fetch(origin+'/health/live')).ok)break;}catch{}await sleep(1000);}await assert.rejects(retrievePurchase(agentDirectory));
 material('private-assets',"import{unlink}from'node:fs/promises';await unlink('/material/guide.txt');");assert.throws(check);await assert.rejects(retrievePurchase(agentDirectory));
 material('private-assets',"import{rename}from'node:fs/promises';await rename('/material/guide.saved','/material/guide.txt');");check();assert.deepEqual(await retrievePurchase(agentDirectory),bytes);
 // Model an older backup missing initialization history after all positive recovery checks.
 // The disposable cluster administrator removes only this test identity; runtime cannot do so.
 run(['stop','api','worker']);sql('ALTER TABLE dispatch.operator_identity DISABLE TRIGGER USER; DELETE FROM dispatch.operator_identity; ALTER TABLE dispatch.operator_identity ENABLE TRIGGER USER;');
 assert.equal(sql('SELECT count(*) FROM dispatch.operator_identity;').trim(),'0');
 assert.throws(()=>run(['run','--rm','-T','migration','node','scripts/operator-local.mjs','begin',origin,'/bootstrap/missing-history']));
 assert.equal(sql('SELECT count(*) FROM dispatch.operator_identity;').trim(),'0');
});
await writeFile(out+'/product-results.json',JSON.stringify({passed,status:'passed',application_processes:'built api/worker/edge/postgres/receiver containers; one-shot migration',fixtures:'generated Anvil/provider sidecar, host agent and Chromium, generated wallet adapters, no named extension claim',tls:'generated CA explicitly trusted in isolated NSS store; certificate verification enabled',asset_sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
