import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {createWalletClient,http,encodeFunctionData,parseAbi} from 'viem';
import {setup,teardown,operator,refunds,refundRpc,rpc,worker,commerce,restartApi,token,admin,newSigner,settle,origin,endpoint,request,support,setFixture,payee,policy} from './race-fixtures.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {operationsTick} from '../../dist/apps/worker/src/operations.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {reconcileRefund} from '../../dist/packages/db/src/refunds.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE,password=randomBytes(32).toString('base64url'),results=[];
let auth,product,browser;
async function login(){const c=await operator.auth.challenge(),s=await operator.auth.login(c.token,c.csrf_token,password);return {token:s.token,csrf:s.csrf_token};}
async function api(path,method='GET',body,authority=auth){const r=await fetch(origin+'/v1/operator'+path,{method,headers:{Origin:origin,Cookie:'__Host-dispatch_operator='+authority.token,'X-CSRF-Token':authority.csrf,'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:r.status===204?null:await r.json()};}
async function paid(deliver=true){console.log('PAID_STAGE pace');await pace();console.log('PAID_STAGE setup');auth=await sessionFixture();await request('evm_mine');await support();await worker.pool.query("UPDATE runtime_health SET checked_at=clock_timestamp() WHERE service='operations_worker'");const directory=base+'/agent-'+randomUUID(),j=await createPurchase(policy(),directory,async(input,init)=>{const response=await fetch(input,init);if(!response.ok)console.log('RACE_HTTP_REFUSED',response.status,new URL(String(input)).pathname,(await response.clone().json()).code);return response;}),p=await j.read();console.log('PAID_STAGE authorize');await authorizePurchase(directory,policy(),await newSigner());console.log('PAID_STAGE settle');await settle(p.order);console.log('PAID_STAGE delivery');if(deliver){await deliveryTick(new DeliveryStore(worker.pool),new Map());assert.equal((await retrievePurchase(directory)).toString(),'Independent review private bytes');}console.log('PAID_STAGE done');return {...p,directory};}
async function bound(p,account){const d=await operator.orders(auth,p.order);const r=await api('/orders/'+p.order+'/refunds','POST',{settlement_id:d.order.settlement_id,confirmed_original_payer:d.order.original_payer,expected_signer:account.address.toLowerCase()});assert.equal(r.status,201);const nonce=await rpc.client.getTransactionCount({address:account.address,blockTag:'pending'});const b=await api('/refunds/'+r.body.id+'/wallet-start','POST',{expected_version:r.body.version,signer:account.address.toLowerCase(),observed_account_nonce:String(nonce)});assert.equal(b.status,200);return b.body;}
async function directSend(b,account){await request('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);return createWalletClient({account,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Disposable review',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.binding.transaction_to,data:b.binding.transaction_calldata,value:0n,nonce:Number(b.binding.wallet_account_nonce)});}
async function record(name,result){results.push({name,...result});await writeFile(out+'/independent-results.json',JSON.stringify(results,null,2)+'\n');console.log('INDEPENDENT_RESULT',JSON.stringify({name,...result}));}

async function pace(){const pressure=(await admin.query("SELECT max(count) n FROM abuse_counters WHERE window_start=date_trunc('minute',clock_timestamp())")).rows[0];if(Number(pressure.n)>40)await new Promise(r=>setTimeout(r,60050-Date.now()%60000));}
async function sessionFixture(){const {digest}=await import('../../dist/packages/db/src/commerce.js'),{csrfFor}=await import('../../dist/packages/db/src/operator-auth.js');const token=randomBytes(32).toString('base64url'),csrf=csrfFor(token),id=randomUUID();await admin.query("INSERT INTO operator_sessions(id,token_hash,csrf_hash,expires_at,last_seen_at,fresh_auth_at) VALUES($1,$2,$3,clock_timestamp()+interval '8 hours',clock_timestamp(),clock_timestamp())",[id,digest(token),digest(csrf)]);return {token,csrf,id};}
async function authorize(b,authority=auth){await refunds.invoke(authority,b.id,{expected_version:b.version});const r=await refunds.authorize(authority,b.id,{expected_version:b.version});assert.ok(r.authorization_window_ms>0);return r;}
async function report(b,hash){return refunds.observation(auth,b.id,randomUUID(),{expected_version:b.version,invocation_version:b.version,outcome:hash?'transaction_hash':'unknown',...(hash?{transaction_hash:hash}:{})});}

test.before(async()=>{
 await setup();assert.equal((await admin.query('SELECT count(*) n FROM merchant_config_versions')).rows[0].n,'0');
 execFileSync(process.execPath,['scripts/operator-local.mjs','begin',origin,base+'/bootstrap'],{env:process.env,stdio:'pipe'});
 execFileSync(process.execPath,['scripts/operator-local.mjs','complete',base+'/bootstrap'],{env:process.env,input:password+'\n',stdio:['pipe','pipe','pipe']});auth=await login();
 const c=await api('/config');assert.equal(c.body.config_version,0);
 assert.equal((await api('/config','PUT',{expected_config_version:0,merchant_name:'Independent Review',pay_origin:origin,payee,confirmation_payee:payee,policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']})).status,200);
 await writeFile(base+'/assets/review.txt','Independent review private bytes',{mode:0o600});const asset=JSON.parse(execFileSync(process.execPath,['scripts/operator-local.mjs','import',base+'/assets','review.txt','review.txt','text/plain'],{env:process.env,encoding:'utf8'})).asset_manifest_id;
 const p=await api('/products','POST',{title:'Independent review file',description:'Disposable fixture',kind:'digital',asset_manifest_id:asset,unit_atomic:'100',tax_status:'merchant_attested_zero',tax_source:'fixture',tax_version:'1',policy_version:'policy-1',enabled:true});assert.equal(p.status,201);product=p.body.id;setFixture({product,asset});
 await operationsTick(worker.pool,refundRpc,new Map());const cfg=await api('/config');assert.equal((await api('/pause/payments','POST',{paused:false,expected_version:cfg.body.controls.version,reason:'Explicit disposable review'})).status,200);
 browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});
});
test.after(async()=>{await browser?.close();await teardown();});
import {submitInitial} from '../../dist/apps/worker/src/payments.js';
import {PrivateFiles} from '../../dist/packages/fulfillment/src/files.js';
import {apiServer} from '../../dist/apps/api/src/app.js';
import {api as apiPool,server} from './race-fixtures.mjs';
async function pause(kind,paused){const c=await operator.config(auth);return operator.pause(auth,kind,randomUUID(),{paused,expected_version:c.controls.version,reason:'Explicit operator race schedule'});}
async function configChange(){const c=await operator.config(auth);return operator.updateConfig(auth,randomUUID(),{expected_config_version:c.config_version,merchant_name:'Race fixture',pay_origin:origin,payee:'0x'+'77'.repeat(20),confirmation_payee:'0x'+'77'.repeat(20),policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']});}
async function restoreConfig(){const c=await operator.config(auth);await operator.updateConfig(auth,randomUUID(),{expected_config_version:c.config_version,merchant_name:'Race fixture',pay_origin:origin,payee,confirmation_payee:payee,policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']});}
for(const action of ['pause','payee'])for(const boundary of ['quote','challenge','signed','verify','settle','settle_result'])test(`C6-R1 operator ${action} at ${boundary} retains immutable purchase and uncertainty`,async()=>{
 await pace();auth=await sessionFixture();await request('evm_mine');await support();await operationsTick(worker.pool,refundRpc,new Map());let reached=false,signs=0,sends=0,observedQuote;const directory=base+'/race-'+randomUUID();
 const mutate=async()=>{reached=true;if(action==='pause')await pause('payments',true);else await configChange();};
 const transport=async(input,init)=>{const req=new Request(input,init),path=new URL(req.url).pathname;
  if(boundary==='quote'&&path.endsWith('/quote'))await mutate();
  if(boundary==='challenge'&&path.endsWith('/pay')&&!req.headers.has('PAYMENT-SIGNATURE'))await mutate();
  if(req.headers.has('PAYMENT-SIGNATURE'))sends++;
  const response=await fetch(req);if(path.endsWith('/quote')&&response.ok)observedQuote=await response.clone().json();return response;
 };
 let saved,attempt;
 try{
  let journal;try{journal=await createPurchase(policy(),directory,transport);}catch(e){assert.equal(action==='pause'&&boundary==='quote',true);assert.equal(reached,true);assert.equal(signs,0);return;}
  saved=await journal.read();const signer=await newSigner();
  try{await authorizePurchase(directory,policy(),{address:signer.address,async signTypedData(d){signs++;if(boundary==='signed')await mutate();return signer.signTypedData(d);}},transport);}catch(e){assert.equal(action==='pause'&&['challenge','signed'].includes(boundary),true);}
  attempt=(await admin.query('SELECT * FROM payment_attempts WHERE order_id=$1',[saved.order])).rows[0];
  if(['verify','settle','settle_result'].includes(boundary)){
   if(boundary==='verify')await mutate();let calls=[];
   const transport={async observe(operation){calls.push(operation);if((boundary==='settle'&&operation==='verify')||(boundary==='settle_result'&&operation==='settle'))await mutate();return {observation:{operation,status:operation==='verify'?200:null,kind:operation==='verify'?'verified':'unknown',code:operation==='verify'?'verified':'transport_unknown',transaction:null}};}};
   try{await submitInitial(worker,attempt.id,transport);}catch(e){assert.equal(action,'pause');}
   if(boundary==='settle_result'){assert.equal((await admin.query('SELECT state FROM payment_attempts WHERE id=$1',[attempt.id])).rows[0].state,'pending');await assert.rejects(worker.claim(attempt.id,'settle'));}
   assert.deepEqual(calls,action==='pause'&&boundary!=='settle_result'?(boundary==='verify'?[]:['verify']):['verify','settle']);
  }
  assert.equal(reached,true);if(observedQuote)assert.equal(observedQuote.payee.toLowerCase(),payee.toLowerCase());
  const order=(await operator.orders(auth,saved.order)).order;assert.equal(order.original_payee,payee.toLowerCase());
  if(action==='pause'&&['challenge','signed'].includes(boundary))assert.equal(attempt,undefined);
  else {assert.ok(attempt);assert.equal(attempt.payee,payee.toLowerCase());}
  await record(`C6-R1-${action}-${boundary}`,{signs,sends,attempts:attempt?1:0,original_payee_retained:true});
 }finally{await pause('payments',false);await restoreConfig();}
});
for(const boundary of ['selection','claim','effect'])test('C6-R2 operator fulfillment pause at '+boundary+' blocks unstarted effect and preserves lease identity',async()=>{
 const p=await paid(false),store=new DeliveryStore(worker.pool),job=(await admin.query("SELECT * FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0];let lease;
 if(boundary==='selection')await pause('fulfillment',true);
 assert.equal((await store.pending()).some(j=>j.id===job.id),boundary!=='selection');
 if(boundary==='claim')await pause('fulfillment',true);
 if(boundary!=='effect')await assert.rejects(store.claim(job.id),/delivery_blocked/);
 else {lease=await store.claim(job.id);await pause('fulfillment',true);await assert.rejects(store.entitlement(lease),/delivery_blocked/);}
 assert.equal((await admin.query('SELECT count(*) n FROM entitlements WHERE order_id=$1',[p.order])).rows[0].n,'0');await pause('fulfillment',false);
 if(lease){await admin.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);const fresh=await store.claim(job.id);assert.notEqual(fresh.fence,lease.fence);await assert.rejects(store.entitlement(lease),/stale_delivery/);await store.entitlement(fresh);}else await store.entitlement(await store.claim(job.id));
 assert.equal((await admin.query('SELECT count(*) n FROM entitlements WHERE order_id=$1',[p.order])).rows[0].n,'1');await record('C6-R2-'+boundary,{entitlements:1,same_job:job.id});
});
test('C6-R3 operator pause after actual file read blocks final download; payment pause preserves bytes',{timeout:90000},async()=>{
 const p=await paid(),tls={key:await readFile(base+'/tls.key'),cert:await readFile(base+'/tls.crt')};let reached,release;const read=new Promise(r=>reached=r),gate=new Promise(r=>release=r);
 class Gated extends PrivateFiles{async read(a){const bytes=await super.read(a);reached();await gate;return bytes;}}
 console.log('R3_STAGE closing fixture server');await new Promise(r=>{server.close(r);server.closeAllConnections();});console.log('R3_STAGE opening gated server');const gated=apiServer(apiPool,origin,()=>{},commerce,{tls,files:new Gated(base+'/assets'),operator,refunds});await new Promise(r=>gated.listen(19743,'127.0.0.1',r));
 try{const request=fetch(origin+'/v1/orders/'+p.order+'/download',{headers:{Authorization:'Bearer '+p.credential}});await Promise.race([read,request.then(async r=>{throw Error('download returned before read: '+r.status+'');}),new Promise((_,reject)=>setTimeout(()=>reject(Error('file read schedule timeout')),10000))]);await pause('fulfillment',true);release();const response=await request;assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/Independent review private bytes/);}finally{release();await new Promise(r=>{gated.close(r);gated.closeAllConnections();});await restartApi();await pause('fulfillment',false);}
 await pause('payments',true);assert.equal((await retrievePurchase(p.directory)).toString(),'Independent review private bytes');await pause('payments',false);await record('C6-R3',{post_read_pause_status:409,payment_pause_bytes:'preserved'});
});
import {pool} from '../payment/helpers.mjs';
import {digest} from '../../dist/packages/db/src/commerce.js';
import {WebhookTransport} from '../../dist/packages/fulfillment/src/transport.js';
import {merchantServer,MerchantReceiver} from '../../dist/examples/merchant-adapter/src/server.js';
test('C6-R4 operator pause and lease expiry at webhook authority/result retain receiver evidence and current handoff renders',async()=>{
 await admin.query(await readFile('examples/merchant-adapter/schema.sql','utf8'));const receiverPool=pool('fixture_admin'),receiver=new MerchantReceiver(receiverPool),key=randomBytes(32),bearer=randomBytes(32).toString('base64url'),endpoint='https://127.0.0.1:19744',url=endpoint+'/dispatch/v1/events';
 const tls={cert:await readFile(base+'/tls.crt'),key:await readFile(base+'/tls.key')};const rs=merchantServer(receiver,{origin:endpoint,keys:new Map([['fixture',key]]),bearer,tls});await new Promise(r=>rs.listen(19744,'127.0.0.1',r));
 const target=new WebhookTransport({id:'correction',url,keyId:'fixture',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:tls.cert.toString()}}),store=new DeliveryStore(worker.pool,new Map([['correction',target.binding]]));
 // Owner-local connector fixture: immutable product at creation, never public request-controlled URL.
 const id=randomUUID();await admin.query(`INSERT INTO products(product_id,version,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version,connector_key)
 SELECT $1,1,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version,'correction' FROM products WHERE product_id=$2 AND version=1`,[id,product]);await admin.query('INSERT INTO product_publication VALUES($1,1,true)',[id]);product=id;setFixture({product:id,asset:(await operator.products(auth)).products.find(p=>p.id===id).asset_manifest_id});
 const authority=await sessionFixture(),ctx=await browser.newContext({ignoreHTTPSErrors:true});await ctx.addCookies([{name:'__Host-dispatch_operator',value:authority.token,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);const tab=await ctx.newPage();
 async function render(p,state){const d=await operator.orders(auth,p.order);assert.equal(d.status.merchant_handoff.state,state);for(const width of [360,768,1440]){await tab.setViewportSize({width,height:1000});await tab.goto(origin+'/operator');await tab.getByRole('button',{name:'Orders',exact:true}).click();const entry=tab.locator('article').filter({has:tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)})});assert.match(await entry.innerText(),new RegExp('Merchant handoff: '+state));await tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)}).click();await tab.getByRole('heading',{name:'Manual full refund'}).waitFor();assert.match(await tab.locator('dl').innerText(),new RegExp(state.replaceAll('_',' ')));await tab.screenshot({path:out+`/handoff-${state}-${width}.png`,fullPage:true});}}
 try{const p=await paid(false),ent=(await admin.query("SELECT id FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0];await store.entitlement(await store.claim(ent.id));const job=(await admin.query("SELECT * FROM outbox_jobs WHERE order_id=$1 AND effect_type='merchant_paid'",[p.order])).rows[0];await render(p,'queued');
 let lease=await store.claim(job.id);await pause('fulfillment',true);await assert.rejects(store.beginWebhook(lease,target.keyId,target.binding),/delivery_blocked/);assert.equal((await admin.query('SELECT count(*) n FROM webhook_attempts WHERE job_id=$1',[job.id])).rows[0].n,'0');await pause('fulfillment',false);
 let attempt=await store.beginWebhook(lease,target.keyId,target.binding);await store.finishWebhook(lease,attempt.id,undefined,503);await render(p,'retry_pending');
 for(let n=2;n<=8;n++){await admin.query("UPDATE outbox_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);const failedLease=await store.claim(job.id),failedAttempt=await store.beginWebhook(failedLease,target.keyId,target.binding);await store.finishWebhook(failedLease,failedAttempt.id,undefined,503);}
 await render(p,'blocked');const failedJob=(await admin.query('SELECT fence FROM outbox_jobs WHERE id=$1',[job.id])).rows[0];await operator.retryDelivery(auth,p.order,randomUUID(),{job_id:job.id,expected_fence:failedJob.fence});
 await admin.query("UPDATE outbox_jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);lease=await store.claim(job.id);await admin.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);await assert.rejects(store.beginWebhook(lease,target.keyId,target.binding),/stale_delivery/);lease=await store.claim(job.id);attempt=await store.beginWebhook(lease,target.keyId,target.binding);
 await pause('fulfillment',true);const result=await target.send(attempt.body,attempt.timestamp);assert.equal(result.status,200);await store.finishWebhook(lease,attempt.id,result.receipt,200);await render(p,'recorded');assert.equal((await operator.orders(auth,p.order)).status.delivery.state,'blocked');await pause('fulfillment',false);
 const q=await paid(false),ent2=(await admin.query("SELECT id FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[q.order])).rows[0];await store.entitlement(await store.claim(ent2.id));const j=(await admin.query("SELECT id FROM outbox_jobs WHERE order_id=$1 AND effect_type='merchant_paid'",[q.order])).rows[0];lease=await store.claim(j.id);attempt=await store.beginWebhook(lease,target.keyId,target.binding);const late=await target.send(attempt.body,attempt.timestamp);await admin.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);await assert.rejects(store.finishWebhook(lease,attempt.id,late.receipt,200),/stale_delivery/);const next=await store.claim(j.id),again=await store.beginWebhook(next,target.keyId,target.binding),status=await target.status(again.event);await store.finishWebhook(next,again.id,status.receipt,status.status);assert.equal((await admin.query('SELECT count(*) n FROM merchant_adapter.orders WHERE dispatch_order_id=$1',[q.order])).rows[0].n,'1');
 await record('C6-R4',{before_authority_pause:'denied',after_authority_pause:'result_retained',expired_before_authority:'denied',expired_after_effect:'same_receipt_recovered',merchant_effects_per_order:1});
 }finally{await ctx.close();rs.closeAllConnections();await new Promise(r=>rs.close(r));await pause('fulfillment',false);}
});
