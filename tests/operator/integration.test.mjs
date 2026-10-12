import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {createWalletClient,http,encodeFunctionData,parseAbi} from 'viem';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {completeLocalBootstrap,localBootstrap,csrfFor} from '../../dist/packages/db/src/operator-auth.js';
import {OperatorStore} from '../../dist/packages/db/src/operator.js';
import {RefundStore,reconcileRefund} from '../../dist/packages/db/src/refunds.js';
import {privateOperatorPeer} from '../../dist/apps/api/src/operator.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {operationsTick} from '../../dist/apps/worker/src/operations.js';
import {refundTick} from '../../dist/apps/worker/src/refunds.js';
import {pool} from '../payment/helpers.mjs';
import {setup,teardown,operator,operatorPool,refunds,refundRpc,rpc,worker,commerce,api,admin,newSigner,settle,origin,endpoint,request,support,fixture,setFixture,policy,restartApi,payee,token} from './fixtures.mjs';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE,password=randomBytes(24).toString('base64url');
const migrator=pool('local_migrator'),screenshots=[],captures=[],accessibility=[];const auditedScreens=new Set();let browser,context,page,auth,other,product,asset,purchase,seller,walletCalls=0,confirmedRefund;
const store=new DeliveryStore(worker.pool),bytes=Buffer.from('Private operator fixture bytes\n');
async function call(path,method='GET',body,headers={}){const r=await fetch(origin+'/v1/operator'+path,{method,headers:{Origin:origin,...(method==='GET'?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return r;}
async function loginDirect(){const c=await operator.auth.challenge(),s=await operator.auth.login(c.token,c.csrf_token,password);return {token:s.token,csrf:s.csrf_token};}
async function paceBuyer(){const pressure=(await admin.query("SELECT max(count) n FROM abuse_counters WHERE window_start=date_trunc('minute',clock_timestamp()) AND count>=45 AND bucket_hash=$1",['0x'+(await import('node:crypto')).createHash('sha256').update('127.0.0.1').digest('hex')])).rows[0];if(pressure.n)await new Promise(r=>setTimeout(r,60050-Date.now()%60000));}
async function paid(){await paceBuyer();await request('evm_mine');await operationsTick(worker.pool,refundRpc,new Map());await support();const directory=base+'/agent-'+randomUUID(),j=await createPurchase(policy(),directory),saved=await j.read();await authorizePurchase(directory,policy(),await newSigner());await settle(saved.order);await deliveryTick(store,new Map());return {directory,...saved};}
async function prepare(p=purchase,signer){if(!signer){seller=await newSigner();await request('anvil_setBalance',[seller.address,'0x56bc75e2d63100000']);signer=seller.address.toLowerCase();}const s=(await admin.query('SELECT * FROM settlements WHERE order_id=$1',[p.order])).rows[0],a=(await admin.query('SELECT authorizer FROM payment_attempts WHERE id=$1',[s.attempt_id])).rows[0];return (await refunds.prepare(auth,p.order,randomUUID(),{settlement_id:s.id,confirmed_original_payer:a.authorizer,expected_signer:signer})).body;}
async function start(r,k=randomUUID(),authority=auth){const n=await rpc.client.getTransactionCount({address:r.expected_signer,blockTag:'pending'});return refunds.start(authority,r.id,k,{expected_version:r.version,signer:r.expected_signer,observed_account_nonce:String(n)});}
async function send(r,overrides={}){await refunds.invoke(auth,r.id,{expected_version:r.version});await refunds.authorize(auth,r.id,{expected_version:r.version});walletCalls++;const b=r.binding;const hash=await createWalletClient({account:seller,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Local fixture',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.transaction_to,data:b.transaction_calldata,value:0n,nonce:Number(b.wallet_account_nonce),...overrides});await refunds.observation(auth,r.id,randomUUID(),{expected_version:r.version,invocation_version:r.version,outcome:'unknown'});return hash;}
async function mine(){await request('anvil_mine',['0x40','0x0']);}
async function shot(name,source=page){if(!name.includes('wallet-pending'))await source.getByRole('status').filter({hasText:'Working…'}).waitFor({state:'hidden'});await source.screenshot({path:out+'/'+name+'.png',fullPage:true});screenshots.push(name+'.png');const screen=name.replace(/-\d+$/,'');if(!auditedScreens.has(screen)){auditedScreens.add(screen);const report=await new AxeBuilder({page:source}).analyze();accessibility.push({screen,violations:report.violations});assert.equal(report.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);await source.keyboard.press('Tab');assert.notEqual(await source.evaluate(()=>document.activeElement.tagName),'BODY');}assert.equal(await source.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
test.before(async()=>{await setup();browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>console.log('BROWSER_ERROR',e.message));});
test.after(async()=>{await writeFile(out+'/screenshots.json',JSON.stringify(screenshots,null,2)+'\n');await writeFile(out+'/a11y-screens.json',JSON.stringify(accessibility,null,2)+'\n');await writeFile(out+'/captures.json',JSON.stringify(captures,null,2)+'\n');await browser?.close();await teardown();});
test('B6-01 private ingress rejects remote takeover and spoofed forwarding claims; no registration',async()=>{
 assert.equal(privateOperatorPeer({socket:{remoteAddress:'198.51.100.4'},headers:{'x-forwarded-for':'127.0.0.1'}}),false);
 for(const path of ['/bootstrap','/register','/signup'])assert.equal((await call(path,'POST',{})).status,404);
 for(const path of ['/config','/products','/orders','/readiness'])assert.equal((await call(path)).status,401);
 assert.equal((await admin.query('SELECT count(*) n FROM merchant_config_versions')).rows[0].n,'0');
 assert.equal((await admin.query('SELECT count(*) n FROM orders')).rows[0].n,'0');
});
test('B6-02 owner-local CLI issues one expiring bootstrap; simultaneous initialization and replay cannot reopen it',async()=>{
 const expired=await localBootstrap(migrator,origin,1);await new Promise(r=>setTimeout(r,1100));await assert.rejects(completeLocalBootstrap(migrator,expired,password));
 execFileSync(process.execPath,['scripts/operator-local.mjs','begin',origin,base+'/bootstrap'],{env:process.env,stdio:'pipe'});
 const secret=(await readFile(base+'/bootstrap','utf8')).trim();
 await assert.rejects(completeLocalBootstrap(migrator,'wrong-secret-long-enough',password));
 const result=await Promise.allSettled([completeLocalBootstrap(migrator,secret,password),completeLocalBootstrap(migrator,secret,password)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);await assert.rejects(localBootstrap(migrator,origin));
 await restartApi();await assert.rejects(completeLocalBootstrap(migrator,secret,password));
 const r=(await admin.query('SELECT octet_length(password_verifier) n FROM operator_identity')).rows[0];assert.equal(r.n,32);
});
test('B6-03 clean browser login, zero config sentinel and first save without an order',async()=>{
 await page.goto(origin+'/operator');await page.getByLabel('Operator password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'Set up merchant details'}).waitFor();for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});await shot('setup-empty-'+width);}
 await page.getByLabel('Merchant name',{exact:true}).fill('Fieldnotes Studio');await page.getByLabel('Receiving wallet on Base',{exact:true}).fill(payee);
 await page.getByLabel('Type the exact receiving wallet to confirm').fill(payee);await page.getByLabel('Policy version',{exact:true}).fill('policy-1');await page.getByLabel('Public versioned policy URL').fill('https://fixture.invalid/policy/1');
 await page.getByRole('button',{name:'Confirm and save settings'}).click();await page.getByRole('heading',{name:'Merchant settings',exact:true}).waitFor();
 assert.equal((await admin.query('SELECT count(*) n FROM orders')).rows[0].n,'0');
 auth=await loginDirect();other=await loginDirect();const c=await operator.config(auth);assert.equal(c.config_version,1);assert.equal(c.controls.payment_paused,true);captures.push({schema:'OperatorConfig',body:c});
});
test('B6-04 local private import and protected product publication with explicit tax; copyable link and real readiness',async()=>{
 await writeFile(base+'/assets/guide.txt',bytes,{mode:0o600});
 const imported=execFileSync(process.execPath,['scripts/operator-local.mjs','import',base+'/assets','guide.txt','guide.txt','text/plain'],{env:process.env,encoding:'utf8'});asset=JSON.parse(imported).asset_manifest_id;
 await page.getByRole('button',{name:'Products',exact:true}).click();await page.getByLabel('Product title').fill('The independent maker’s field guide');await page.getByLabel('Description',{exact:true}).fill('A private local file. <img src=x onerror=alert(1)>');await page.getByLabel('Imported private asset').selectOption(asset);
 await page.getByLabel('Price in integer USDC units').fill('100');await page.getByLabel('Explicit tax treatment').selectOption('merchant_attested_zero');await page.getByLabel('Tax policy source').fill('owner-fixture');await page.getByLabel('Tax policy version').fill('1');
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/v1/operator/products')&&r.request().method()==='POST');await page.getByRole('button',{name:'Publish first version'}).click();const productResponse=await responsePromise;if(productResponse.status()!==201){await shot('failed-product');const input=productResponse.request().postDataJSON();await operator.product(auth,randomUUID(),input);assert.fail('API product failed: '+await productResponse.text());}await page.getByRole('button',{name:'Copy purchase link'}).waitFor();await shot('products-1440');
 product=(await operator.products(auth)).products[0].id;setFixture({product,asset});
 await operationsTick(worker.pool,refundRpc,new Map());await page.getByRole('button',{name:'Settings & pauses',exact:true}).click();await page.getByRole('button',{name:'Resume payments',exact:true}).click();await page.getByRole('button',{name:'Pause payments',exact:true}).waitFor();
 const ready=await operator.readiness(auth);assert.equal(ready.payments_ready,true);assert.equal(ready.checks.find(c=>c.code==='live_release').status,'unknown');assert.equal(ready.physical_ready,false);captures.push({schema:'Readiness',body:ready});
 seller=await newSigner();await request('anvil_setBalance',[seller.address,'0x56bc75e2d63100000']);
});
test('B6-05 current auth/CSRF/freshness and login challenge replay are enforced at API and DB boundaries',async()=>{
 const c=await operator.auth.challenge();await operator.auth.login(c.token,c.csrf_token,password);await assert.rejects(operator.auth.login(c.token,c.csrf_token,password));
 const config=await operator.config(auth),input={paused:true,expected_version:config.controls.version,reason:'test'};
 const cookie='__Host-dispatch_operator='+auth.token;
 assert.equal((await call('/pause/payments','POST',input,{Cookie:cookie,'Idempotency-Key':randomUUID()})).status,403);
 const hostile=await fetch(origin+'/v1/operator/config',{headers:{Origin:'https://evil.invalid',Cookie:cookie,'X-Forwarded-For':'127.0.0.1'}});assert.equal(hostile.status,400);
 await admin.query("UPDATE operator_sessions SET fresh_auth_at=clock_timestamp()-interval '6 minutes' WHERE token_hash=$1",['0x'+(await import('node:crypto')).createHash('sha256').update(auth.token).digest('hex')]);
 await assert.rejects(operator.pause(auth,'payments',randomUUID(),input),/unauthorized/);await operator.auth.reauth(auth,password);
 await operator.auth.logout(other);await assert.rejects(operator.config(other));other=await loginDirect();
});
test('B6-06 command replay precedes stale config checks, conflicting races preserve immutable original payee',async()=>{
 const c=await operator.config(auth),draft=await commerce.create({product_id:product,product_version:1,quantity:1,client_kind:'agent'});await commerce.status(draft.id,draft.agent_capability);
 const q=await commerce.quote(draft.id,draft.agent_capability,randomUUID(),{product_version:1,quantity:1,policy_version:'policy-1'});
 const input={expected_config_version:c.config_version,merchant_name:'Fieldnotes Studio',pay_origin:origin,payee:'0x'+'33'.repeat(20),confirmation_payee:'0x'+'33'.repeat(20),policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']},key=randomUUID();
 const result=await Promise.allSettled([operator.updateConfig(auth,key,input),operator.updateConfig(other,randomUUID(),input)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 const won=result[0].status==='fulfilled';if(won){assert.equal((await operator.updateConfig(auth,key,input)).replayed,true);await assert.rejects(operator.updateConfig(auth,key,{...input,merchant_name:'Changed'}),/idempotency_conflict/);}
 assert.equal((await commerce.status(draft.id,draft.agent_capability)).quote.payee,payee);assert.equal((await admin.query('SELECT payee FROM quotes WHERE id=$1',[q.id])).rows[0].payee,payee);
 const current=await operator.config(auth);await operator.updateConfig(auth,randomUUID(),{...input,expected_config_version:current.config_version,payee,confirmation_payee:payee});
});
test('B6-07 actual buyer API/SDK purchase, independent local EVM settlement, worker entitlement and private bytes',async()=>{
 await support();purchase=await paid();assert.deepEqual(await retrievePurchase(purchase.directory),bytes);
 assert.equal((await commerce.status(purchase.order,purchase.credential)).payment_state,'settled');assert.equal((await operator.orders(auth,purchase.order)).order.refund_state,'none');
});
test('B6-08 all four independent pause combinations preserve original access/job/settlement identities',async()=>{
 const settlement=(await admin.query('SELECT id FROM settlements WHERE order_id=$1',[purchase.order])).rows[0].id;
 for(const payment of [false,true])for(const fulfillment of [false,true]){
  let c=await operator.config(auth);await operator.pause(auth,'payments',randomUUID(),{paused:payment,expected_version:c.controls.version,reason:'four combinations'});
  c=await operator.config(auth);await operator.pause(auth,'fulfillment',randomUUID(),{paused:fulfillment,expected_version:c.controls.version,reason:'four combinations'});
  const status=await commerce.status(purchase.order,purchase.credential);assert.equal(status.payment_state,'settled');assert.equal(status.delivery.state,fulfillment?'blocked':'available');
  if(fulfillment)await assert.rejects(retrievePurchase(purchase.directory));else assert.deepEqual(await retrievePurchase(purchase.directory),bytes);
  const create=()=>commerce.create({product_id:product,product_version:1,quantity:1,client_kind:'agent'});if(payment)await assert.rejects(create());else await create();
 }
 let c=await operator.config(auth);await operator.pause(auth,'payments',randomUUID(),{paused:false,expected_version:c.controls.version,reason:'resume'});c=await operator.config(auth);await operator.pause(auth,'fulfillment',randomUUID(),{paused:false,expected_version:c.controls.version,reason:'resume'});
 assert.equal((await admin.query('SELECT id FROM settlements WHERE order_id=$1',[purchase.order])).rows[0].id,settlement);
});
test('B6-09 two independent operators claim one durable wallet invocation; replay and reload are status only',async()=>{
 const r=await prepare(),k=randomUUID();const result=await Promise.allSettled([start(r,k,auth),start(r,randomUUID(),other)]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);const bound=result.find(x=>x.status==='fulfilled').value.body;assert.equal(bound.next_action,'poll_status');
 const count=walletCalls;const hash=await send(bound);await mine();assert.equal(walletCalls-count,1);
 if(result[0].status==='fulfilled')assert.equal((await refunds.start(auth,r.id,k,{expected_version:r.version,signer:r.expected_signer,observed_account_nonce:bound.binding.wallet_account_nonce})).replayed,true);
 await assert.rejects(start(r));await restartApi();await assert.rejects(start(r));
 const saved=await refunds.observation(auth,r.id,randomUUID(),{expected_version:bound.version,outcome:'transaction_hash',transaction_hash:hash});assert.equal(saved.body.state,'submitted');
 const concurrent=await Promise.all([reconcileRefund(worker.pool,r.id,refundRpc),retrievePurchase(purchase.directory)]);assert.equal(concurrent[0],'confirmed');assert.deepEqual(concurrent[1],bytes);confirmedRefund=await refunds.get(auth,r.id);assert.equal(confirmedRefund.state,'confirmed');const unchanged=await refunds.observation(auth,r.id,randomUUID(),{expected_version:confirmedRefund.version,outcome:'unknown'});assert.equal(unchanged.body.state,'confirmed');captures.push({schema:'Refund',body:confirmedRefund});captures.push({schema:'OperatorOrder',body:await operator.orders(auth,purchase.order)});captures.push({schema:'OrderList',body:await operator.orders(auth)});
 assert.equal((await commerce.status(purchase.order,purchase.credential)).refund_state,'confirmed');assert.deepEqual(await retrievePurchase(purchase.directory),bytes);
 await assert.rejects(prepare());assert.equal(walletCalls-count,1);
});
test('B6-10 crash before wallet call leaves permanent ownership; no lease/timeout/new-key escape',async()=>{
 const p=await paid(),r=await prepare(p),bound=(await start(r)).body;await restartApi();await assert.rejects(start(r));await assert.rejects(prepare(p));
 await reconcileRefund(worker.pool,r.id,refundRpc);assert.equal((await refunds.get(auth,r.id)).state,'wallet_pending');await assert.rejects(start({...bound,version:bound.version+1}));
});
test('B6-11 lost hash persistence recovers by exact sender/nonce complete block scan without another wallet call',async()=>{
 const p=await paid(),r=await prepare(p),bound=(await start(r)).body,prior=walletCalls;await send(bound);await mine();
 await restartApi();await refundTick(worker.pool,refundRpc);const current=await refunds.get(auth,r.id);assert.equal(current.state,'confirmed');assert.equal(walletCalls-prior,1);
 assert.ok((await admin.query("SELECT evidence FROM refund_observations WHERE refund_id=$1 AND kind='confirmed'",[r.id])).rows.length);
});
test('B6-12 generic rejection is review, supported local pre-sign rejection retains same binding and requires explicit fresh retry',async()=>{
 // Respect the unchanged buyer HTTP rate window; never reset DB counters.
 await new Promise(r=>setTimeout(r,60050-Date.now()%60000));await request('evm_mine');
 const p=await paid(),r=await prepare(p),bound=(await start(r)).body;
 const generic=await refunds.observation(auth,r.id,randomUUID(),{expected_version:bound.version,outcome:'user_rejected_before_send',no_send_evidence:{wallet_start_version:bound.version,adapter_id:'unverified-extension',stage:'before_signing',wallet_error_code:4001}});
 assert.equal(generic.body.state,'review_required');await assert.rejects(start(generic.body));await assert.rejects(prepare(p));
 const signer=await newSigner(),p2=await paid(),r2=await prepare(p2,signer.address.toLowerCase()),bound2=(await start(r2)).body;
 const supported=new RefundStore(operator,refundRpc,new Set(['local-pre-sign-fixture-v1']));let calls=0;
 const adapter=async()=>{calls++;throw Object.assign(new Error('rejected before any send primitive'),{code:4001});};await assert.rejects(adapter());assert.equal(calls,1);
 const rejected=(await supported.observation(auth,r2.id,randomUUID(),{expected_version:bound2.version,outcome:'user_rejected_before_send',no_send_evidence:{wallet_start_version:bound2.version,adapter_id:'local-pre-sign-fixture-v1',stage:'before_signing',wallet_error_code:4001}})).body;assert.equal(rejected.state,'rejected');
 const retry=(await supported.start(auth,r2.id,randomUUID(),{expected_version:rejected.version,signer:rejected.expected_signer,observed_account_nonce:rejected.binding.wallet_account_nonce})).body;
 assert.deepEqual(retry.binding,bound2.binding);await assert.rejects(supported.observation(auth,r2.id,randomUUID(),{expected_version:bound2.version,outcome:'unknown'}));await assert.rejects(prepare(p2,signer.address.toLowerCase()));
});
test('B6-13 historical transfer and cross-intent hash reuse cannot confirm another order',async()=>{
 const signer=await newSigner(),p=await paid(),r=await prepare(p,signer.address.toLowerCase()),bound=(await start(r)).body;
 await refunds.observation(auth,r.id,randomUUID(),{expected_version:bound.version,outcome:'transaction_hash',transaction_hash:confirmedRefund.transaction_hint});
 assert.equal(await reconcileRefund(worker.pool,r.id,refundRpc),'review_required');await assert.rejects(prepare(p,signer.address.toLowerCase()));
 const original=(await admin.query(`SELECT r.*,s.block_number original_block,s.block_hash original_hash FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE r.id=$1`,[confirmedRefund.id])).rows[0];
 const evidence=await refundRpc.observe({...original,prepare_block:original.block_number,prepare_block_hash:original.block_hash});assert.equal(evidence.state,'review_required');
});
test('B6-14 full exact transaction rejects wrong recipient/amount/token, approval-only and reverted evidence',async()=>{
 const original=(await admin.query(`SELECT r.*,s.block_number original_block,s.block_hash original_hash FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE r.id=$1`,[confirmedRefund.id])).rows[0];
 for(const altered of [{destination:'0x'+'99'.repeat(20)},{amount:'101'},{token:'0x'+'88'.repeat(20)},{wallet_account_nonce:'999'}])assert.equal((await refundRpc.observe({...original,...altered})).state,'review_required');
 const p=await paid(),r=await prepare(p),bound=(await start(r)).body;const hash=await send(bound,{data:encodeFunctionData({abi:parseAbi(['function approve(address,uint256)']),functionName:'approve',args:[bound.destination,100n]}),gas:100000n});await mine();
 await refunds.observation(auth,r.id,randomUUID(),{expected_version:bound.version,outcome:'transaction_hash',transaction_hash:hash});assert.equal(await reconcileRefund(worker.pool,r.id,refundRpc),'review_required');
});
test('B6-15 current authority rechecked after real lock wait; expired session rolls back settings and command',async()=>{
 const session=await loginDirect(),c=await operator.config(session),lock=await admin.connect();await lock.query('BEGIN');await lock.query("SELECT * FROM merchant_control WHERE merchant_id='single' FOR UPDATE");
 const pending=operator.pause(session,'payments',randomUUID(),{paused:true,expected_version:c.controls.version,reason:'wait expiry'});
 await admin.query("UPDATE operator_sessions SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE token_hash=$1",['0x'+(await import('node:crypto')).createHash('sha256').update(session.token).digest('hex')]);
 await new Promise(r=>setTimeout(r,150));await lock.query('COMMIT');lock.release();await assert.rejects(pending,/unauthorized/);assert.equal((await operator.config(auth)).controls.payment_paused,false);
});
test('B6-16 browser refund path renders bound nonce and confirmation, pending/status and responsive accessible pages',async()=>{
 await page.reload();await page.getByRole('button',{name:'Orders',exact:true}).click();await page.getByRole('button',{name:'Review order '+purchase.order.slice(0,8)}).click();await page.getByText('Refund: confirmed',{exact:true}).waitFor();
 for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});await shot('refund-confirmed-'+width);}
 await page.getByRole('button',{name:'Settings & pauses',exact:true}).click();
 for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});await shot('settings-'+width);}
 const axe=await new AxeBuilder({page}).analyze();assert.equal(axe.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);await writeFile(out+'/axe.json',JSON.stringify(axe.violations,null,2)+'\n');
 await page.keyboard.press('Tab');assert.notEqual(await page.evaluate(()=>document.activeElement.tagName),'BODY');
 await page.getByRole('button',{name:'Setup & readiness',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('heading',{name:'Setup & readiness',exact:true}).waitFor();
});
test('B6-17 two actual browser tabs compete; one durable invocation and one wallet call through pending to confirmation',async()=>{
 await operationsTick(worker.pool,refundRpc,new Map());const p=await paid(),account=await newSigner();await request('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);
 let calls=0,release;const gate=new Promise(r=>release=r);const pages=[await context.newPage(),await context.newPage()];
 for(const tab of pages){tab.setDefaultTimeout(10000);await tab.exposeFunction('__refundRpc',async(method,params)=>{
   if(method==='eth_sendTransaction'){
    calls++;const r=(await admin.query('SELECT r.id FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE s.order_id=$1',[p.order])).rows[0];
    assert.equal((await admin.query('SELECT count(*) n FROM refund_invocations WHERE refund_id=$1',[r.id])).rows[0].n,'1');
    await gate;const tx=params[0];return createWalletClient({account,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Local',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:tx.to,data:tx.data,value:BigInt(tx.value),nonce:Number(BigInt(tx.nonce))});
   }
   return request(method,params);
  });await tab.addInitScript(({address})=>{
   const provider={async request({method,params}){if(method==='eth_accounts'||method==='eth_requestAccounts')return [address];if(method==='eth_chainId')return '0x2105';return window.__refundRpc(method,params);}};
   window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'33333333-3333-4333-8333-333333333333',name:'Synthetic local refund wallet'},provider}})));
  },{address:account.address});await tab.goto(origin+'/operator');await tab.getByRole('button',{name:'Orders',exact:true}).click();await tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)}).click();}
 const first=pages[0],second=pages[1];await first.getByRole('button',{name:'Connect refund wallet: Synthetic local refund wallet'}).click();await first.getByRole('checkbox').check();await first.getByRole('button',{name:'Prepare full refund'}).click();await first.getByText('Refund: prepared',{exact:true}).waitFor();
 await second.getByRole('button',{name:'Refresh order'}).click();await second.getByText('Refund: prepared',{exact:true}).waitFor();
 for(const tab of pages){await tab.getByRole('button',{name:'Select sending wallet: Synthetic local refund wallet'}).click();await tab.getByRole('checkbox').check();}
 await Promise.all(pages.map(tab=>tab.getByRole('button',{name:'Approve one wallet invocation'}).click()));
 let winner;for(let i=0;i<50&&!winner;i++){for(const tab of pages)if(await tab.getByRole('button',{name:'Send exact bound refund'}).count())winner=tab;if(!winner)await new Promise(r=>setTimeout(r,50));}assert.ok(winner);assert.equal(calls,0);
 await winner.getByRole('checkbox').focus();await winner.keyboard.press('Space');for(const width of [360,768,1440]){await winner.setViewportSize({width,height:1000});await shot('refund-bound-review-'+width,winner);}
 await winner.getByRole('button',{name:'Send exact bound refund'}).focus();await winner.keyboard.press('Enter');for(let i=0;i<50&&calls===0;i++)await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);
 const r=(await admin.query('SELECT r.id FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE s.order_id=$1',[p.order])).rows[0];await refundTick(worker.pool,refundRpc);for(const width of [360,768,1440]){await winner.setViewportSize({width,height:1000});await shot('refund-wallet-pending-'+width,winner);}
 release();await winner.getByText('Refund: submitted',{exact:true}).waitFor();await mine();assert.equal(await reconcileRefund(worker.pool,r.id,refundRpc),'confirmed',JSON.stringify((await admin.query('SELECT verification_evidence FROM refunds WHERE id=$1',[r.id])).rows));await winner.getByRole('button',{name:'Check refund status'}).click();await winner.getByText('Refund: confirmed',{exact:true}).waitFor();assert.equal(calls,1);
 await second.getByRole('button',{name:'Refresh order'}).click();assert.equal(await second.getByRole('button',{name:'Send exact bound refund'}).count(),0);await winner.reload();assert.equal(await winner.getByRole('button',{name:'Send exact bound refund'}).count(),0);assert.equal(calls,1);
 await writeFile(out+'/browser-wallet.json',JSON.stringify({classification:'synthetic EIP-1193 provider; generated signer; genuine local non-forked EVM transfer',competing_tabs:2,wallet_calls:calls,durable_invocations:1,reconciliation_during_wallet:true})+'\n');for(const tab of pages)await tab.close();
});
test('B6-18 real local refund reorg retains confirmed evidence and permanent refund exclusion',async()=>{
 const p=await paid(),r=await prepare(p),snapshot=await request('evm_snapshot'),bound=(await start(r)).body,hash=await send(bound);await mine();
 await refunds.observation(auth,r.id,randomUUID(),{expected_version:bound.version,outcome:'transaction_hash',transaction_hash:hash});assert.equal(await reconcileRefund(worker.pool,r.id,refundRpc),'confirmed');
 const evidenceCount=(await admin.query('SELECT count(*) n FROM refund_observations WHERE refund_id=$1',[r.id])).rows[0].n;
 assert.equal(await request('evm_revert',[snapshot]),true);await request('evm_mine');assert.equal(await reconcileRefund(worker.pool,r.id,refundRpc),'review_required');
 const row=(await admin.query('SELECT * FROM refunds WHERE id=$1',[r.id])).rows[0];assert.equal(row.tx_hash,hash);assert.ok(row.block_hash);assert.ok(Number((await admin.query('SELECT count(*) n FROM refund_observations WHERE refund_id=$1',[r.id])).rows[0].n)>Number(evidenceCount));await assert.rejects(prepare(p));
});
test('B6-19 schema and stale-worker gates block runtime creation and resume; no UI flag bypass',async()=>{
 await admin.query("UPDATE runtime_health SET checked_at=clock_timestamp()-interval '1 minute'");
 await assert.rejects(commerce.create({product_id:product,product_version:1,quantity:1,client_kind:'agent'}),/not_ready/);
 const c=await operator.config(auth);await assert.rejects(operator.pause(auth,'payments',randomUUID(),{paused:false,expected_version:c.controls.version,reason:'stale worker'}),/not_ready/);
 await operationsTick(worker.pool,refundRpc,new Map());
 await admin.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE name='008_operator_operations.sql'");
 await assert.rejects(commerce.readiness(),/not_ready/);
 const hash=(await import('node:crypto')).createHash('sha256').update(await readFile('db/migrations/008_operator_operations.sql')).digest('hex');
 await admin.query("UPDATE schema_migrations SET sha256=$1 WHERE name='008_operator_operations.sql'",[hash]);await commerce.readiness();
});
test('B6-20 config mutation, audit and saved response roll back together; identical retry recovers once',async()=>{
 const before=await operator.config(auth),input={expected_config_version:before.config_version,merchant_name:'Atomic settings',pay_origin:origin,payee,confirmation_payee:payee,policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']},key=randomUUID();
 await admin.query("CREATE FUNCTION dispatch.fixture_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_before_audit'; END $$; CREATE TRIGGER fixture_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION dispatch.fixture_fail_audit()");
 try{await assert.rejects(operator.updateConfig(auth,key,input),/fixture_before_audit/);assert.equal((await operator.config(auth)).config_version,before.config_version);}finally{await admin.query('DROP TRIGGER fixture_fail ON audit_events; DROP FUNCTION dispatch.fixture_fail_audit()');}
 const saved=await operator.updateConfig(auth,key,input),again=await operator.updateConfig(auth,key,input);assert.equal(saved.replayed,false);assert.equal(again.replayed,true);assert.deepEqual(saved.body,again.body);
});
test('B6-21 changed policy blocks readiness until a deliberately matching immutable product version exists',async()=>{
 const before=await operator.config(auth),input={expected_config_version:before.config_version,merchant_name:'Fieldnotes Studio',pay_origin:origin,payee,confirmation_payee:payee,policy_version:'policy-2',policy_urls:['https://fixture.invalid/policy/2']};
 await operator.updateConfig(auth,randomUUID(),input);const ready=await operator.readiness(auth);assert.equal(ready.payments_ready,false);assert.equal(ready.checks.find(c=>c.code==='product').status,'blocked');
 const current=await operator.config(auth);await operator.updateConfig(auth,randomUUID(),{...input,expected_config_version:current.config_version,policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']});
});
test('B6-22 final invocation rechecks revoked operator authority and atomically rejects duplicate claims',async()=>{
 const row=(await admin.query("SELECT r.id,r.version FROM refunds r WHERE state='wallet_pending' AND NOT EXISTS(SELECT 1 FROM refund_invocations i WHERE i.refund_id=r.id) ORDER BY created_at LIMIT 1")).rows[0];assert.ok(row);
 await operator.auth.logout(other);await assert.rejects(refunds.invoke(other,row.id,{expected_version:Number(row.version)}),/unauthorized/);
 const outcomes=await Promise.allSettled([refunds.invoke(auth,row.id,{expected_version:Number(row.version)}),refunds.invoke(auth,row.id,{expected_version:Number(row.version)})]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);await assert.rejects(refunds.invoke(auth,row.id,{expected_version:Number(row.version)}));
});
test('B6-23 unresolved refund UI remains status-only across responsive reload; no access or payment rewrite',async()=>{
 const row=(await admin.query("SELECT r.id,r.version,s.order_id FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE r.state='wallet_pending' ORDER BY r.created_at LIMIT 1")).rows[0];
 await refunds.observation(auth,row.id,randomUUID(),{expected_version:Number(row.version),outcome:'unknown'});
 await page.reload();await page.getByRole('button',{name:'Orders',exact:true}).click();await page.getByRole('button',{name:'Review order '+row.order_id.slice(0,8)}).click();await page.getByText('Refund: broadcast unknown',{exact:true}).waitFor();
 for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});await shot('refund-unknown-'+width);assert.equal(await page.getByRole('button',{name:'Send exact bound refund'}).count(),0);}
 assert.equal((await operator.orders(auth,row.order_id)).order.payment_state,'settled');
});
test('B6-24 browser publishes immutable next product version; old purchase and stale writer remain bound',async()=>{
 const prior=(await operator.products(auth)).products.find(p=>p.id===product);await page.getByRole('button',{name:'Products',exact:true}).click();await page.getByRole('button',{name:'Edit next version of '+prior.title,exact:true}).click();
 await page.getByLabel('Product title',{exact:true}).fill('Updated field guide');await page.getByRole('button',{name:'Publish next version',exact:true}).click();await page.getByRole('heading',{name:'Updated field guide',exact:true}).waitFor();
 assert.equal((await operator.products(auth)).products.find(p=>p.id===product).version,2);assert.equal((await operator.orders(auth,purchase.order)).product.version,1);
 const {id,version,purchase_path,...input}=prior;await assert.rejects(operator.product(auth,randomUUID(),{...input,expected_version:version},id),/stale_config/);await shot('products-versioned-1440');
});
test('B6-25 nonce consumed during human review cannot authorize a replacement wallet invocation',async()=>{
 const r=(await admin.query("SELECT * FROM refunds r WHERE state='wallet_pending' AND NOT EXISTS(SELECT 1 FROM refund_invocations i WHERE i.refund_id=r.id) ORDER BY created_at LIMIT 1")).rows[0];assert.ok(r);
 await request('anvil_impersonateAccount',[r.expected_signer]);await request('anvil_setBalance',[r.expected_signer,'0x56bc75e2d63100000']);
 await request('eth_sendTransaction',[{from:r.expected_signer,to:r.expected_signer,value:'0x0',gas:'0x5208',nonce:'0x'+BigInt(r.wallet_account_nonce).toString(16)}]);
 await assert.rejects(refunds.invoke(auth,r.id,{expected_version:Number(r.version)}),/refund_review_required/);
 assert.equal((await admin.query('SELECT count(*) n FROM refund_invocations WHERE refund_id=$1',[r.id])).rows[0].n,'0');await assert.rejects(prepare({order:(await refunds.get(auth,r.id)).order_id},r.expected_signer));
});
test('B6-26 protected receipt and fenced retry reuse the original delivery job and effect',async()=>{
 const receipt=await operator.receipt(auth,purchase.order);captures.push({schema:'Receipt',body:receipt});assert.equal(receipt.refund_status,'confirmed');assert.equal(receipt.payment_status,'settled');
 const exported=await call('/orders/'+purchase.order+'/receipt','GET',undefined,{Cookie:'__Host-dispatch_operator='+auth.token});assert.equal(exported.status,200);assert.match(exported.headers.get('content-disposition'),/attachment/);assert.match(exported.headers.get('cache-control'),/no-store/);
 await operationsTick(worker.pool,refundRpc,new Map());await support();await request('evm_mine');
 await paceBuyer();const currentPolicy={...policy(),productVersion:2},directory=base+'/agent-'+randomUUID(),journal=await createPurchase(currentPolicy,directory),p=await journal.read();await authorizePurchase(directory,currentPolicy,await newSigner());await settle(p.order);
 const j=(await admin.query("SELECT * FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0],lease=await store.claim(j.id);assert.ok(lease);await store.defer(lease);
 const row=(await admin.query('SELECT * FROM outbox_jobs WHERE id=$1',[j.id])).rows[0],body={job_id:j.id,expected_fence:row.fence};
 const c=await operator.config(auth);await operator.pause(auth,'fulfillment',randomUUID(),{paused:true,expected_version:c.controls.version,reason:'retry guard'});await assert.rejects(operator.retryDelivery(auth,p.order,randomUUID(),body));
 const paused=await operator.config(auth);await operator.pause(auth,'fulfillment',randomUUID(),{paused:false,expected_version:paused.controls.version,reason:'resume existing effect'});
 await assert.rejects(operator.retryDelivery(auth,p.order,randomUUID(),{...body,expected_fence:String(BigInt(row.fence)+1n)}));
 const key=randomUUID(),result=await operator.retryDelivery(auth,p.order,key,body);captures.push({schema:'CheckoutStatus',body:result.body});assert.equal((await operator.retryDelivery(auth,p.order,key,body)).replayed,true);
 await deliveryTick(store,new Map());assert.deepEqual(await retrievePurchase(directory),bytes);assert.equal((await admin.query("SELECT count(*) n FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[p.order])).rows[0].n,'1');assert.equal((await admin.query('SELECT effect_key FROM outbox_jobs WHERE id=$1',[j.id])).rows[0].effect_key,j.effect_key);await assert.rejects(operator.retryDelivery(auth,p.order,randomUUID(),body));
});
