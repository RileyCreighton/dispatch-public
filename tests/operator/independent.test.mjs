import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createWalletClient,http} from 'viem';
import {setup,teardown,operator,refunds,refundRpc,rpc,worker,admin,newSigner,settle,origin,endpoint,request,support,setFixture,payee,policy} from './fixtures.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {operationsTick} from '../../dist/apps/worker/src/operations.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {reconcileRefund} from '../../dist/packages/db/src/refunds.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE,password=randomBytes(32).toString('base64url'),results=[];
let auth,product,browser;
async function login(){const c=await operator.auth.challenge(),s=await operator.auth.login(c.token,c.csrf_token,password);return {token:s.token,csrf:s.csrf_token};}
async function api(path,method='GET',body,authority=auth){const r=await fetch(origin+'/v1/operator'+path,{method,headers:{Origin:origin,Cookie:'__Host-dispatch_operator='+authority.token,'X-CSRF-Token':authority.csrf,'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:r.status===204?null:await r.json()};}
async function paid(){await request('evm_mine');await support();await operationsTick(worker.pool,refundRpc,new Map());const directory=base+'/agent-'+randomUUID(),j=await createPurchase(policy(),directory),p=await j.read();await authorizePurchase(directory,policy(),await newSigner());await settle(p.order);await deliveryTick(new DeliveryStore(worker.pool),new Map());assert.equal((await retrievePurchase(directory)).toString(),'Independent review private bytes');return p;}
async function bound(p,account){const d=await operator.orders(auth,p.order);const r=await api('/orders/'+p.order+'/refunds','POST',{settlement_id:d.order.settlement_id,confirmed_original_payer:d.order.original_payer,expected_signer:account.address.toLowerCase()});assert.equal(r.status,201);const nonce=await rpc.client.getTransactionCount({address:account.address,blockTag:'pending'});const b=await api('/refunds/'+r.body.id+'/wallet-start','POST',{expected_version:r.body.version,signer:account.address.toLowerCase(),observed_account_nonce:String(nonce)});assert.equal(b.status,200);return b.body;}
async function directSend(b,account){await request('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);return createWalletClient({account,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Disposable review',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.binding.transaction_to,data:b.binding.transaction_calldata,value:0n,nonce:Number(b.binding.wallet_account_nonce)});}
async function record(name,result){results.push({name,...result});await writeFile(out+'/independent-results.json',JSON.stringify(results,null,2)+'\n');console.log('INDEPENDENT_RESULT',JSON.stringify({name,...result}));}
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
test('IR-01 clean CLI/API setup and readiness use zero preseeded operator/product/config rows',async()=>{const r=await api('/readiness');assert.equal(r.status,200);assert.equal(r.body.payments_ready,true);assert.equal(r.body.checks.find(x=>x.code==='live_release').status,'unknown');await record('IR-01',{passed:true,purchase_path:'/buy/'+product});});
test('IR-02 a matching transfer before final invocation authority must remain reviewable',async()=>{
 const p=await paid(),account=await newSigner(),b=await bound(p,account);
 assert.equal((await admin.query('SELECT count(*) n FROM refund_invocations WHERE refund_id=$1',[b.id])).rows[0].n,'0');
 // Independent same-sender transfer, not the application's final approved invocation.
 const hash=await directSend(b,account);await request('anvil_mine',['0x40','0x0']);
 const state=await reconcileRefund(worker.pool,b.id,refundRpc);const n=(await admin.query('SELECT count(*) n FROM refund_invocations WHERE refund_id=$1',[b.id])).rows[0].n;
 await record('IR-02',{refund_id:b.id,transaction:hash,invocations:Number(n),state,expected:'review_required',passed:state==='review_required'});assert.equal(state,'review_required');
});
test('IR-03 revocation during post-claim wallet await must prevent a new wallet invocation',async()=>{
 const p=await paid(),account=await newSigner();await request('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:768,height:1000}}),tab=await ctx.newPage();tab.setDefaultTimeout(10000);
 let calls=0,claimSeen=false,atBoundary,release;const reached=new Promise(r=>atBoundary=r),gate=new Promise(r=>release=r);
 tab.on('response',r=>{if(r.url().endsWith('/invocation')&&r.status()===200)claimSeen=true;});
 await tab.exposeFunction('__reviewWallet',async(method,params)=>{
  if(method==='eth_accounts'&&claimSeen){atBoundary();await gate;return [account.address];}
  if(method==='eth_accounts'||method==='eth_requestAccounts')return [account.address];
  if(method==='eth_chainId')return '0x2105';
  if(method==='eth_sendTransaction'){calls++;return directSend({binding:{transaction_to:params[0].to,transaction_calldata:params[0].data,wallet_account_nonce:BigInt(params[0].nonce).toString()}},account);}
  return request(method,params);
 });
 await tab.addInitScript(()=>{const provider={request:({method,params})=>window.__reviewWallet(method,params)};window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'77777777-7777-4777-8777-777777777777',name:'Independent synthetic wallet'},provider}})));});
 await tab.goto(origin+'/operator');await tab.getByLabel('Operator password',{exact:true}).fill(password);await tab.getByRole('button',{name:'Sign in',exact:true}).click();await tab.getByRole('button',{name:'Orders',exact:true}).click();await tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)}).click();
 await tab.getByRole('button',{name:'Connect refund wallet: Independent synthetic wallet'}).click();await tab.getByRole('checkbox').check();await tab.getByRole('button',{name:'Prepare full refund'}).click();await tab.getByText('Refund: prepared',{exact:true}).waitFor();await tab.getByRole('checkbox').check();await tab.getByRole('button',{name:'Approve one wallet invocation'}).click();await tab.getByRole('button',{name:'Send exact bound refund'}).waitFor();await tab.getByRole('checkbox').check();await tab.getByRole('button',{name:'Send exact bound refund'}).click();
 await Promise.race([reached,new Promise((_,reject)=>setTimeout(()=>reject(new Error('post-claim boundary not reached')),10000))]);
 const cookies=await ctx.cookies(),cookie=cookies.find(x=>x.name==='__Host-dispatch_operator').value;const session=await operator.auth.session({token:cookie});await operator.auth.logout({token:cookie,csrf:session.csrf_token});assert.equal(calls,0);release();
 for(let i=0;i<100&&calls===0;i++)await new Promise(r=>setTimeout(r,30));
 await tab.getByRole('status').filter({hasText:'Working…'}).waitFor({state:'hidden'});await tab.screenshot({path:out+'/revoked-during-wallet-await-768.png',fullPage:true});
 const row=(await admin.query('SELECT r.id,r.state FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE s.order_id=$1',[p.order])).rows[0];const saved=await tab.evaluate(id=>JSON.parse(localStorage.getItem('dispatch-refund-invocation:'+id)),row.id);
 await record('IR-03',{wallet_calls:calls,revocation_before_send:true,server_state:row.state,public_hint_saved_locally:typeof saved?.body?.transaction_hash==='string',expected_wallet_calls:0,passed:calls===0});await ctx.close();assert.equal(calls,0);
});
test('IR-04 paused delivery must be represented by the operator order view',async()=>{
 const p=await paid();let c=await operator.config(auth);await operator.pause(auth,'fulfillment',randomUUID(),{paused:true,expected_version:c.controls.version,reason:'Independent paused rendering'});
 const d=await operator.orders(auth,p.order);assert.equal(d.status.delivery.state,'blocked');
 const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:360,height:1000}}),tab=await ctx.newPage();tab.setDefaultTimeout(10000);
 try{await tab.goto(origin+'/operator');await tab.getByLabel('Operator password',{exact:true}).fill(password);await tab.getByRole('button',{name:'Sign in',exact:true}).click();await tab.getByRole('button',{name:'Orders',exact:true}).click();await tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)}).click();await tab.getByRole('heading',{name:'Manual full refund'}).waitFor();
 const rendered=await tab.locator('dl').innerText();await tab.screenshot({path:out+'/paused-order-360.png',fullPage:true});await record('IR-04',{actual_delivery:d.status.delivery.state,raw_delivery:d.order.delivery_state,rendered,passed:/blocked|paused/i.test(rendered)});assert.match(rendered,/blocked|paused/i);
 }finally{await ctx.close();c=await operator.config(auth);await operator.pause(auth,'fulfillment',randomUUID(),{paused:false,expected_version:c.controls.version,reason:'Resume independent fixture'});}
});
