// Explicit local fixture driver. Generated signers and capabilities never print.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {captureDiagnostics,safeScreenshot} from './safe-browser-diagnostics.mjs';
import {createPublicClient,custom,encodeFunctionData,parseAbi} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {chromium} from 'playwright';
import {localFixtureSigner} from './local-fixture-signer.mjs';
import {createPurchase,authorizePurchase,resumePurchase,retrievePurchase} from '../dist/examples/agent/src/purchase.js';
const state=process.env.DISPATCH_DEMO_STATE,mode=process.argv[2],origin='https://127.0.0.1:18443';
assert.match(state??'',/^\/tmp\/dispatch-demo-[0-9]+-[a-f0-9]{12}$/);
const password=(await readFile(state+'/operator.password','utf8')).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// One private Docker-exec channel avoids creating a container/process per UI request.
// It accepts only this fixture's loopback operator routes and synthetic chain RPC.
const remote=`import https from'node:https';import{readFileSync}from'node:fs';import{createInterface}from'node:readline';
const ca=readFileSync('/run/dispatch/tls.crt');
async function handle(x){
 if(x.kind==='rpc'){const r=await fetch('http://127.0.0.1:18546',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:x.method,params:x.params})});const b=await r.json();if(b.error)throw Error('fixture_rpc_failed');return b.result;}
 if(x.kind!=='operator'||!/^\\/(?:operator(?:\\/|$)|v1\\/operator(?:\\/|$))/.test(x.path)||x.path.includes('..'))throw Error('path_refused');
 return new Promise((resolve,reject)=>{const q=https.request('https://127.0.0.1:18443'+x.path,{method:x.method,ca,headers:x.headers},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks).toString('base64')}));});q.on('error',reject);q.end(x.body?Buffer.from(x.body,'base64'):undefined);});
}
createInterface({input:process.stdin}).on('line',async line=>{let x;try{x=JSON.parse(line);const result=await handle(x);console.log(JSON.stringify({id:x.id,result}));}catch{console.log(JSON.stringify({id:x?.id,error:'local_fixture_request_failed'}));}});`;
const channel=spawn('docker',['compose','-f',state+'/compose.json','exec','-T','api','node','--input-type=module','-e',remote],{stdio:['pipe','pipe','pipe']});
const pending=new Map();let sequence=0;
function closePending(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('local fixture channel closed'));}pending.clear();}
let bridgeErrors='';channel.stderr.on('data',x=>{if(bridgeErrors.length<16384)bridgeErrors+=x;});
channel.on('error',closePending);channel.on('close',(code,signal)=>{void writeFile(state+'/bridge-exit.json',JSON.stringify({code,signal,stderr:bridgeErrors})+'\n',{mode:0o600});closePending();});
createInterface({input:channel.stdout}).on('line',line=>{let x;try{x=JSON.parse(line);}catch{closePending();channel.kill();return;}const p=pending.get(x.id);if(!p)return;clearTimeout(p.timer);pending.delete(x.id);if(x.error)p.reject(Error(x.error));else p.resolve(x.result);});
function bridge(value){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('local fixture request timed out'));channel.kill();},60000);pending.set(id,{resolve,reject,timer});channel.stdin.write(JSON.stringify({id,...value})+'\n');});}
async function operatorRequest(path,method='GET',headers={},body){
 assert.match(path,/^\/(?:operator(?:\/|$)|v1\/operator(?:\/|$))/);assert.ok(!path.includes('..'));
 return bridge({kind:'operator',path,method,headers,body:body?Buffer.from(body).toString('base64'):undefined});
}
let cookie,csrf;
async function api(path,method='GET',body){
 const r=await operatorRequest('/v1/operator'+path,method,{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),'Idempotency-Key':randomUUID()},body?JSON.stringify(body):undefined);
 const b=JSON.parse(Buffer.from(r.body,'base64').toString());assert.ok(r.status>=200&&r.status<300,'operator request failed: '+r.status+' '+path);if(r.headers['set-cookie'])cookie=r.headers['set-cookie'][0].split(';')[0];if(b.csrf_token)csrf=b.csrf_token;return b;
}
try {
await api('/session/challenge');await api('/session','POST',{password});
console.log('Local operator session ready; generated credentials remain private.');
const transport=custom({request:({method,params})=>bridge({kind:'rpc',method,params})},{retryCount:0});
const chain=createPublicClient({transport}),request=(method,params=[])=>chain.request({method,params});
const token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
async function signer(){const a=privateKeyToAccount(generatePrivateKey());const hash=await request('eth_sendTransaction',[{from:'0x'+'44'.repeat(20),to:token,gas:'0x7a120',data:encodeFunctionData({abi:parseAbi(['function fixtureMint(address,uint256)']),functionName:'fixtureMint',args:[a.address,1000000n]})}]);assert.equal((await chain.waitForTransactionReceipt({hash})).status,'success');await request('anvil_mine',['0x40','0x0']);return localFixtureSigner(a,request);}
async function selection(){const c=await api('/config'),p=(await api('/products')).products.find(x=>x.enabled);assert.ok(p,'Create a product in the operator UI first');const readiness=await api('/readiness');await writeFile(state+'/latest-readiness.json',JSON.stringify(readiness,null,2)+'\n',{mode:0o600});assert.equal(readiness.payments_ready,true,'Review readiness and resume local payments first');return {p,c,policy:{origin,productId:p.id,productVersion:p.version,maxAtomic:p.unit_atomic,payees:[c.config.payee],network:'eip155:8453',token,policyVersion:c.config.policy_version,policyURLs:c.config.policy_urls}};}
async function agent(){
 const {policy}=await selection(),dir=state+'/agent-'+randomUUID(),journal=await createPurchase(policy,dir),saved=await journal.read(),account=await signer();let signs=0,dropped=false;
 const lostResponse=async(input,init)=>{const r=await fetch(input,init);if(new Headers(init?.headers??(input instanceof Request?input.headers:undefined)).has('PAYMENT-SIGNATURE')&&!dropped){dropped=true;throw Error('local_response_loss');}return r;};
 await assert.rejects(authorizePurchase(dir,policy,{address:account.address,signTypedData:async x=>{signs++;return account.signTypedData(x);}},lostResponse));assert.equal(dropped,true);assert.equal(signs,1);
 let status;for(let i=0;i<35;i++){status=await resumePurchase(dir);if(status.delivery.state==='available')break;await sleep(1000);}
 assert.equal(status.payment_state,'settled');assert.equal(status.delivery.state,'available');const bytes=await retrievePurchase(dir);assert.deepEqual(bytes,await readFile('examples/assets/guide.txt'));assert.equal(signs,1);
 const result={scope:'generated local wallet, synthetic token, non-forked chain',payment:'settled',delivery:'exact private bytes verified',authorizations:signs,lost_response:true,recovery:'same purchase; no resubmission',asset_sha256:createHash('sha256').update(bytes).digest('hex')};
 await writeFile(state+'/agent-result.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});await writeFile(state+'/last-agent.json',JSON.stringify({dir,order:saved.order}),{mode:0o600});console.log(JSON.stringify(result,null,2));
}
async function launch(){
 const home=state+'/browser-home',nss=home+'/.pki/nssdb';await mkdir(nss,{recursive:true});
 try{await readFile(nss+'/cert9.db');}catch{execFileSync('certutil',['-N','--empty-password','-d','sql:'+nss]);execFileSync('certutil',['-A','-d','sql:'+nss,'-n','Dispatch disposable CA','-t','C,,','-i',state+'/tls.crt']);}
 const browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:mode==='verify',args:['--no-sandbox'],env:{...process.env,HOME:home}});
 const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 await context.route(url=>url.origin===origin&&(url.pathname==='/operator'||url.pathname.startsWith('/operator/')||url.pathname.startsWith('/v1/operator/')),async route=>{
  const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();delete headers['content-length'];delete headers['connection'];delete headers['accept-encoding'];
  const response=await operatorRequest(url.pathname+url.search,request.method(),headers,request.postDataBuffer());
  const resultHeaders={};for(const[k,v]of Object.entries(response.headers)){if(['transfer-encoding','connection','content-length','keep-alive'].includes(k))continue;resultHeaders[k]=Array.isArray(v)?v.join('\n'):String(v);}
  await route.fulfill({status:response.status,headers:resultHeaders,body:Buffer.from(response.body,'base64')});
 });
 await context.addInitScript(()=>{window.addEventListener('DOMContentLoaded',()=>{const bar=document.createElement('div');bar.textContent='LOCAL FIXTURE · Synthetic funds · Generated wallet · Mainnet disabled';bar.style.cssText='position:sticky;top:0;z-index:9999;background:#132b35;color:#fff;padding:8px;text-align:center;font:14px system-ui';document.body.prepend(bar);});});
 return {browser,context};
}
async function merchant(page){
 await page.goto(origin+'/operator');await page.getByLabel('Operator password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Products',exact:true}).waitFor();
 if((await api('/config')).config_version===0){
  await page.getByLabel('Merchant name',{exact:true}).fill('Local Demo Studio');await page.getByLabel('Receiving wallet on Base',{exact:true}).fill('0x'+'22'.repeat(20));await page.getByLabel('Type the exact receiving wallet to confirm').fill('0x'+'22'.repeat(20));await page.getByLabel('Policy version',{exact:true}).fill('policy-1');await page.getByLabel('Public versioned policy URL').fill('https://fixture.invalid/policy/1');await page.getByRole('button',{name:'Confirm and save settings'}).click();await page.getByRole('heading',{name:'Merchant settings',exact:true}).waitFor();
 }
 if(!(await api('/products')).products.length){
  await page.getByRole('button',{name:'Products',exact:true}).click();await page.getByLabel('Product title').fill('The Local Commerce Guide');await page.getByLabel('Description',{exact:true}).fill('An original sample file delivered after verified local settlement.');await page.getByLabel('Imported private asset').selectOption(JSON.parse(await readFile(state+'/asset.json','utf8')).asset_manifest_id);await page.getByLabel('Price in integer USDC units').fill('100');await page.getByLabel('Explicit tax treatment').selectOption('merchant_attested_zero');await page.getByLabel('Tax policy source').fill('synthetic-demo');await page.getByLabel('Tax policy version').fill('1');await page.getByRole('button',{name:'Publish first version'}).click();await page.getByRole('button',{name:'Copy purchase link'}).waitFor();
 }
 await page.getByRole('button',{name:'Settings & pauses',exact:true}).click();if((await api('/config')).controls.payment_paused){await page.getByRole('button',{name:'Resume payments',exact:true}).click();await page.getByRole('button',{name:'Pause payments',exact:true}).waitFor();}
}
async function human(context,automated){
 const {p}=await selection(),account=await signer(),page=await context.newPage(),capture=captureDiagnostics(page);let signs=0;
 page.on('response',r=>{if(r.status()>=400)console.log('Buyer HTTP failure: '+r.status()+' '+r.request().method());});
 await page.exposeFunction('__dispatchFixtureSign',async data=>{signs++;assert.equal(signs,1,'fixture refuses a second authorization');return account.signTypedData(JSON.parse(data));});await page.exposeFunction('__dispatchFixtureRpc',(m,p)=>request(m,p));
 await page.addInitScript(address=>{const provider={on(){},removeListener(){},async request({method,params}){if(['eth_accounts','eth_requestAccounts'].includes(method))return[address];if(method==='eth_chainId')return'0x2105';if(method==='eth_signTypedData_v4')return window.__dispatchFixtureSign(params[1]);if(method==='eth_call')return window.__dispatchFixtureRpc(method,params);throw Error('unsupported local fixture method');}};window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'11111111-1111-4111-8111-111111111111',name:'Generated local wallet',icon:'data:image/svg+xml,<svg/>',rdns:'fixture.invalid'},provider}})));},account.address);
 await page.goto(origin+'/buy/'+p.id);
 if(automated){
  try {
  await page.getByRole('button',{name:'Begin checkout',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Review exact quote',exact:true}).click();await page.getByRole('button',{name:'Connect a wallet',exact:true}).click();await page.getByRole('button',{name:'Connect Generated local wallet',exact:true}).click();await page.getByRole('button',{name:/^Authorize /}).click();await page.getByRole('link',{name:'Download file',exact:true}).waitFor({timeout:45000});assert.equal(signs,1);
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download file',exact:true}).click()]);assert.deepEqual(await readFile(await download.path()),await readFile('examples/assets/guide.txt'));
  await page.screenshot({path:state+'/human-settled.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:state+'/human-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile horizontal overflow');
  await page.reload();await page.getByRole('link',{name:'Download file',exact:true}).waitFor({timeout:15000});assert.equal(signs,1);
  return {human_authorizations:signs,download:'exact match',reload_recovery:true,responsive_width:390};
  } finally { await capture.save(state);await safeScreenshot(page,state+'/buyer-last-state.png'); }
 }
 return page;
}
if(mode==='agent'){await agent();}
else if(mode==='recover'){
 const {dir}=JSON.parse(await readFile(state+'/last-agent.json','utf8'));assert.ok(dir.startsWith(state+'/agent-')&&!dir.includes('..'));
 const result=await resumePurchase(dir);assert.equal(result.payment_state,'settled');assert.deepEqual(await retrievePurchase(dir),await readFile('examples/assets/guide.txt'));
 console.log('PASS: existing agent purchase retrieved after restart; no signer or payment submission invoked.');
 await writeFile(state+'/restart-recovery.json',JSON.stringify({status:'passed',same_purchase:true,new_authorizations:0,exact_bytes:true})+'\n',{mode:0o600});
}
else{
 const {browser,context}=await launch();
 try{
  if(mode==='verify'){
   assert.equal((await fetch(origin+'/v1/operator/session/challenge')).status,403,'edge must not acquire operator authority');
   const page=await context.newPage();await merchant(page);console.log('PASS: merchant setup and product publication through the actual UI.');await page.screenshot({path:state+'/merchant-ready.png',fullPage:true});await page.close();await context.clearCookies();const result=await human(context,true);console.log('PASS: human checkout, exact download, mobile layout and reload.');await agent();await writeFile(state+'/verification.json',JSON.stringify({status:'passed',...result,agent:'separate lost-response purchase; one signature',container_services:'API, worker, PostgreSQL, edge, local fixture, merchant receiver'},null,2)+'\n',{mode:0o600});console.log('PASS: merchant UI, human checkout, exact file, mobile layout, reload and agent recovery.');
  }else if(mode==='operator'){
   const page=await context.newPage();await page.goto(origin+'/operator');await page.getByLabel('Operator password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Products',exact:true}).waitFor();console.log('Operator opened. Keep this fixture browser private; close it when finished.');await new Promise(r=>browser.once('disconnected',r));
  }else{await human(context,false);console.log('Generated local wallet browser opened. Close it when finished.');await new Promise(r=>browser.once('disconnected',r));}
 }finally{await browser.close();}
}

} finally { channel.stdin.end(); }
