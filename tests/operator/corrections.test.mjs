import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {createWalletClient,http,encodeFunctionData,parseAbi} from 'viem';
import {setup,teardown,operator,refunds,refundRpc,rpc,worker,commerce,restartApi,token,admin,newSigner,settle,origin,endpoint,request,support,setFixture,payee,policy} from './correction-fixtures.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {operationsTick} from '../../dist/apps/worker/src/operations.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {reconcileRefund} from '../../dist/packages/db/src/refunds.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE,password=randomBytes(32).toString('base64url'),results=[];
let auth,product,browser;
async function login(){const c=await operator.auth.challenge(),s=await operator.auth.login(c.token,c.csrf_token,password);return {token:s.token,csrf:s.csrf_token};}
async function api(path,method='GET',body,authority=auth){const r=await fetch(origin+'/v1/operator'+path,{method,headers:{Origin:origin,Cookie:'__Host-dispatch_operator='+authority.token,'X-CSRF-Token':authority.csrf,'Content-Type':'application/json','Idempotency-Key':randomUUID()},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:r.status===204?null:await r.json()};}
async function paid(){await pace();auth=await sessionFixture();await request('evm_mine');await support();await worker.pool.query("UPDATE runtime_health SET checked_at=clock_timestamp() WHERE service='operations_worker'");const directory=base+'/agent-'+randomUUID(),j=await createPurchase(policy(),directory),p=await j.read();await authorizePurchase(directory,policy(),await newSigner());await settle(p.order);await deliveryTick(new DeliveryStore(worker.pool),new Map());assert.equal((await retrievePurchase(directory)).toString(),'Independent review private bytes');return {...p,directory};}
async function bound(p,account){const d=await operator.orders(auth,p.order);const r=await api('/orders/'+p.order+'/refunds','POST',{settlement_id:d.order.settlement_id,confirmed_original_payer:d.order.original_payer,expected_signer:account.address.toLowerCase()});assert.equal(r.status,201);const nonce=await rpc.client.getTransactionCount({address:account.address,blockTag:'pending'});const b=await api('/refunds/'+r.body.id+'/wallet-start','POST',{expected_version:r.body.version,signer:account.address.toLowerCase(),observed_account_nonce:String(nonce)});assert.equal(b.status,200);return b.body;}
async function directSend(b,account){await request('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);return createWalletClient({account,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Disposable review',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.binding.transaction_to,data:b.binding.transaction_calldata,value:0n,nonce:Number(b.binding.wallet_account_nonce)});}
async function record(name,result){results.push({name,...result});await writeFile(out+'/independent-results.json',JSON.stringify(results,null,2)+'\n');console.log('INDEPENDENT_RESULT',JSON.stringify({name,...result}));}

async function pace(){const pressure=(await admin.query("SELECT max(count) n FROM abuse_counters WHERE window_start=date_trunc('minute',clock_timestamp())")).rows[0];if(Number(pressure.n)>40)await new Promise(r=>setTimeout(r,60050-Date.now()%60000));}
async function sessionFixture(){const {digest}=await import('../../dist/packages/db/src/commerce.js'),{csrfFor}=await import('../../dist/packages/db/src/operator-auth.js');const token=randomBytes(32).toString('base64url'),csrf=csrfFor(token),id=randomUUID();await admin.query("INSERT INTO operator_sessions(id,token_hash,csrf_hash,expires_at,last_seen_at,fresh_auth_at) VALUES($1,$2,$3,clock_timestamp()+interval '8 hours',clock_timestamp(),clock_timestamp())",[id,digest(token),digest(csrf)]);return {token,csrf,id};}
async function invalidateSession(authority,change){
 const sql={revoked:'revoked_at=clock_timestamp()',absolute:"created_at=clock_timestamp()-interval '8 hours',expires_at=clock_timestamp()-interval '1 second'",idle:"last_seen_at=clock_timestamp()-interval '31 minutes'",fresh:"fresh_auth_at=clock_timestamp()-interval '6 minutes'"}[change];
 await admin.query('UPDATE operator_sessions SET '+sql+' WHERE id=$1',[authority.id]);
 const predicate={revoked:'revoked_at IS NOT NULL',absolute:'expires_at<clock_timestamp() AND expires_at>created_at',idle:"last_seen_at<clock_timestamp()-interval '30 minutes'",fresh:"fresh_auth_at<clock_timestamp()-interval '5 minutes'"}[change];
 assert.equal((await admin.query('SELECT ('+predicate+') invalidated FROM operator_sessions WHERE id=$1',[authority.id])).rows[0].invalidated,true,'fixture authority mutation must actually commit');
}
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
test('C6-01 final authorization and actual call evidence remain distinct, durable, canonical and one-use',async()=>{
 const p=await paid(),account=await newSigner(),b=await bound(p,account);await authorize(b);
 await assert.rejects(refunds.invoke(auth,b.id,{expected_version:b.version}));await assert.rejects(refunds.authorize(auth,b.id,{expected_version:b.version}));
 const hash=await directSend(b,account);await request('anvil_mine',['0x40','0x0']);
 assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'review_required','permission alone is not actual invocation evidence');
 await report(b);await restartApi();assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'confirmed');
 const r=(await admin.query('SELECT * FROM refunds WHERE id=$1',[b.id])).rows[0];assert.equal(r.tx_hash,hash);assert.equal(r.verification_evidence.invocation_version,String(b.version));
 assert.ok(BigInt(r.block_number)>BigInt(r.verification_evidence.invocation_block));await assert.rejects(refunds.authorize(auth,b.id,{expected_version:b.version}));
 await record('C6-01',{wallet_calls:1,invocations:1,authorization:1,missing_report:'review_required',lost_hash_after_report:'confirmed'});
});
test('C6-02 a child crashes after final authorization commit and before wallet call; no timeout or restart reopens it',async()=>{
 const p=await paid(),b=await bound(p,await newSigner());
 const child=spawn(process.execPath,['--input-type=module','-e',`const input=JSON.parse(await new Promise(r=>{let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>r(s));}));for(const action of ['invocation','authorization']){const r=await fetch(input.origin+'/v1/operator/refunds/'+input.id+'/'+action,{method:'POST',headers:{Origin:input.origin,Cookie:'__Host-dispatch_operator='+input.token,'X-CSRF-Token':input.csrf,'Content-Type':'application/json'},body:JSON.stringify({expected_version:input.version})});if(r.status!==200){console.error('authorization_status',r.status,await r.text());process.exit(2);}}console.log('final_authorization_committed');setInterval(()=>{},1000);`],{env:process.env,stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);const exited=new Promise(r=>child.on('exit',(code,signal)=>r({code,signal})));child.stdin.end(JSON.stringify({...auth,origin,id:b.id,version:b.version}));
 const committed=await new Promise((resolve,reject)=>{child.stdout.once('data',d=>resolve(String(d).trim()));child.once('exit',()=>reject(Error('child exited before commit '+stderr)));});assert.equal(committed,'final_authorization_committed');child.kill('SIGKILL');assert.deepEqual(await exited,{code:null,signal:'SIGKILL'});
 await restartApi();assert.equal((await admin.query('SELECT count(*) n FROM refund_authorizations WHERE refund_id=$1',[b.id])).rows[0].n,'1');
 await assert.rejects(refunds.invoke(auth,b.id,{expected_version:b.version}));await assert.rejects(refunds.authorize(auth,b.id,{expected_version:b.version}));
 assert.equal((await admin.query("SELECT count(*) n FROM refund_observations WHERE refund_id=$1 AND kind='wallet_invoked'",[b.id])).rows[0].n,'0');
 assert.notEqual(await reconcileRefund(worker.pool,b.id,refundRpc),'confirmed');await record('C6-02',{crash:'SIGKILL after committed final authorization',wallet_calls:0,retry:'denied'});
});
async function browserRefund(p,account){
 const authority=await sessionFixture(),ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:768,height:1000}});await ctx.addCookies([{name:'__Host-dispatch_operator',value:authority.token,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
 const tab=await ctx.newPage();tab.setDefaultTimeout(12000);let calls=0,armed=false,read=0,hook=async()=>{},onSend=async()=>{};
 await tab.exposeFunction('__reviewWallet',async(method,params)=>{
  if(armed&&['eth_accounts','eth_chainId'].includes(method))await hook(++read,method);
  if(method==='eth_accounts'||method==='eth_requestAccounts')return [account.address];if(method==='eth_chainId')return '0x2105';
  if(method==='eth_sendTransaction'){calls++;const hash=await directSend({binding:{transaction_to:params[0].to,transaction_calldata:params[0].data,wallet_account_nonce:BigInt(params[0].nonce).toString()}},account);await onSend(hash);return hash;}return request(method,params);
 });
 await tab.addInitScript(()=>{const events=new Map();window.__walletEvent=(name)=>events.get(name)?.forEach(f=>f([]));const provider={request:({method,params})=>window.__reviewWallet(method,params),on:(name,fn)=>events.set(name,[...(events.get(name)??[]),fn]),removeListener:(name,fn)=>events.set(name,(events.get(name)??[]).filter(f=>f!==fn))};window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'77777777-7777-4777-8777-777777777777',name:'Boundary fixture'},provider}})));});
 await tab.goto(origin+'/operator');await tab.getByRole('button',{name:'Orders',exact:true}).click();await tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)}).click();await tab.getByRole('button',{name:'Connect refund wallet: Boundary fixture'}).click();await tab.getByRole('checkbox').check();await tab.getByRole('button',{name:'Prepare full refund'}).click();await tab.getByText('Refund: prepared',{exact:true}).waitFor();await tab.getByRole('checkbox').check();await tab.getByRole('button',{name:'Approve one wallet invocation'}).click();await tab.getByRole('button',{name:'Send exact bound refund'}).waitFor();await tab.getByRole('checkbox').check();
 return {ctx,tab,authority,get calls(){return calls;},setHook(f){hook=f;armed=true;},setSend(f){onSend=f;},async send(){await tab.getByRole('button',{name:'Send exact bound refund'}).click();await tab.getByRole('status').filter({hasText:'Working…'}).waitFor({state:'hidden'});},async row(){return (await admin.query('SELECT r.* FROM refunds r JOIN settlements s ON s.id=r.settlement_id WHERE s.order_id=$1',[p.order])).rows[0];}};
}
for(const boundary of [1,2,3,4])for(const change of ['revoked','absolute','idle','fresh','account','chain'])test(`C6-03 wallet await ${boundary}: ${change} invalidates unsent continuation`,async()=>{
 const p=await paid(),account=await newSigner(),ui=await browserRefund(p,account);let reached=false,invalidated=false;
 try{ui.setHook(async n=>{if(n!==boundary)return;reached=true;assert.equal(ui.calls,0);
  if(change==='account'||change==='chain')await ui.tab.evaluate(name=>window.__walletEvent(name),change==='account'?'accountsChanged':'chainChanged');
  else{await invalidateSession(ui.authority,change);}
  invalidated=true;
 });await ui.send();assert.equal(reached,true);assert.equal(invalidated,true,'fixture invalidation must finish before wallet resumes');assert.equal(ui.calls,0);const r=await ui.row();assert.equal((await admin.query('SELECT count(*) n FROM refund_authorizations WHERE refund_id=$1',[r.id])).rows[0].n,'0');
 await ui.tab.reload();assert.equal(ui.calls,0);await assert.rejects(refunds.start(auth,r.id,randomUUID(),{expected_version:Number(r.version),signer:r.expected_signer,observed_account_nonce:r.wallet_account_nonce}));
 await record(`C6-03-${boundary}-${change}`,{wallet_calls:0,changed_before_send:true,permanent_exclusion:true});
 }finally{await ui.ctx.close();}
});
test('C6-04 a revoked session after the wallet starts retains its hash and recovers with new auth without another call',async()=>{
 const p=await paid(),ui=await browserRefund(p,await newSigner());try{let hash;ui.setSend(async h=>{hash=h;await operator.auth.logout(ui.authority);});await ui.send();assert.equal(ui.calls,1);const row=await ui.row();const saved=await ui.tab.evaluate(id=>JSON.parse(localStorage.getItem('dispatch-refund-invocation:'+id)),row.id);assert.equal(saved.body.transaction_hash,hash);assert.equal(saved.body.invocation_version,Number(row.wallet_start_version));
 const fresh=await sessionFixture();await refunds.observation(fresh,row.id,saved.key,saved.body);await request('anvil_mine',['0x40','0x0']);assert.equal(await reconcileRefund(worker.pool,row.id,refundRpc),'confirmed');await ui.tab.reload();assert.equal(ui.calls,1);await record('C6-04',{wallet_calls:1,late_hash_recovered:true});}finally{await ui.ctx.close();}
});
test('C6-05 wallet change during final authority response prevents invocation; committed authorization remains consumed',async()=>{
 const p=await paid(),ui=await browserRefund(p,await newSigner());try{
 await ui.tab.route('**/authorization',async route=>{const response=await route.fetch();assert.equal(response.status(),200);await ui.tab.evaluate(()=>window.__walletEvent('chainChanged'));await route.fulfill({response});});
 await ui.send();assert.equal(ui.calls,0);const r=await ui.row();assert.equal((await admin.query('SELECT count(*) n FROM refund_authorizations WHERE refund_id=$1',[r.id])).rows[0].n,'1');await assert.rejects(refunds.authorize(ui.authority,r.id,{expected_version:Number(r.version)}));await record('C6-05',{wallet_calls:0,consumed:true});}finally{await ui.ctx.close();}
});
test('C6-06 delayed final response beyond freshness deadline is status only',async()=>{
 const p=await paid(),ui=await browserRefund(p,await newSigner());try{
 await ui.tab.route('**/authorization',async route=>{await admin.query("UPDATE operator_sessions SET fresh_auth_at=clock_timestamp()-interval '299.8 seconds' WHERE id=$1",[ui.authority.id]);const response=await route.fetch();assert.equal(response.status(),200);await new Promise(r=>setTimeout(r,300));await route.fulfill({response});});await ui.send();assert.equal(ui.calls,0);await record('C6-06',{wallet_calls:0,expired_in_transit:true});}finally{await ui.ctx.close();}
});
for(const variant of ['wrong_sender','wrong_destination','wrong_amount','failed','approval_only','wrong_log_emitter','ambiguous_logs','wrong_log_sender','wrong_log_destination','wrong_log_amount','wrong_chain','unmined','insufficient_safe','replacement'])test('C6-07 genuine local EVM '+variant+' cannot confirm',async()=>{
 const p=await paid(),account=await newSigner(),b=await bound(p,account);await authorize(b);let hash;
 try{
 const modes={failed:1,ambiguous_logs:2,wrong_log_sender:3,wrong_log_destination:4,wrong_log_amount:5,wrong_log_emitter:6};
 if(modes[variant])await request('eth_sendTransaction',[{from:'0x'+'44'.repeat(20),to:token,data:encodeFunctionData({abi:parseAbi(['function fixtureSetMode(uint256)']),functionName:'fixtureSetMode',args:[BigInt(modes[variant])]}),gas:'0x7a120'}]);
 if(variant==='unmined'||variant==='replacement')await request('evm_setAutomine',[false]);
 if(variant==='wrong_chain')await request('anvil_setChainId',[1]);
 const actual=variant==='wrong_sender'?await newSigner():account;await request('anvil_setBalance',[actual.address,'0x56bc75e2d63100000']);
 let data=b.binding.transaction_calldata;
 if(variant==='wrong_destination')data=encodeFunctionData({abi:parseAbi(['function transfer(address,uint256) returns(bool)']),functionName:'transfer',args:['0x'+'99'.repeat(20),100n]});
 if(variant==='wrong_amount')data=encodeFunctionData({abi:parseAbi(['function transfer(address,uint256) returns(bool)']),functionName:'transfer',args:[b.destination,99n]});
 if(variant==='approval_only'||variant==='replacement')data=encodeFunctionData({abi:parseAbi(['function approve(address,uint256)']),functionName:'approve',args:[b.destination,100n]});
 if(variant==='replacement'){
  const original=await createWalletClient({account:actual,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Replacement fixture',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.binding.transaction_to,data:b.binding.transaction_calldata,value:0n,gas:900000n,gasPrice:1000000000n,nonce:Number(b.binding.wallet_account_nonce)});
  await report(b,original);
 }
 hash=await createWalletClient({account:actual,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:variant==='wrong_chain'?1:8453,name:'Disposable negative',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.binding.transaction_to,data,value:0n,gas:900000n,...(variant==='replacement'?{gasPrice:2000000000n}:{}),nonce:Number(b.binding.wallet_account_nonce)});
 await report(b,hash);if(!['unmined','insufficient_safe'].includes(variant))await request('anvil_mine',['0x40','0x0']);
 const state=await reconcileRefund(worker.pool,b.id,refundRpc);assert.notEqual(state,'confirmed');if(!['unmined','insufficient_safe'].includes(variant))assert.equal(state,'review_required');
 assert.equal((await admin.query('SELECT count(*) n FROM refund_transaction_hints WHERE refund_id=$1 AND transaction_hash=$2',[b.id,hash])).rows[0].n,'1');await record('C6-07-'+variant,{transaction:hash,state,wallet_calls:variant==='replacement'?2:1,application_resubmissions:0});
 }finally{await request('evm_setAutomine',[true]);if(variant==='wrong_chain')await request('anvil_setChainId',[8453]);await request('eth_sendTransaction',[{from:'0x'+'44'.repeat(20),to:token,data:encodeFunctionData({abi:parseAbi(['function fixtureSetMode(uint256)']),functionName:'fixtureSetMode',args:[0n]}),gas:'0x7a120'}]);await request('anvil_mine',['0x40','0x0']);}
});
test('C6-08 transfer before final authorization cannot be backfilled; original and invocation anchors are separate',async()=>{
 const p=await paid(),account=await newSigner(),b=await bound(p,account);await refunds.invoke(auth,b.id,{expected_version:b.version});const hash=await directSend(b,account);await request('anvil_mine',['0x40','0x0']);await assert.rejects(refunds.authorize(auth,b.id,{expected_version:b.version}));await assert.rejects(report(b,hash));
 await refunds.observation(auth,b.id,randomUUID(),{expected_version:b.version,outcome:'transaction_hash',transaction_hash:hash});assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'review_required');await restartApi();assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'review_required');
 await record('C6-08',{transaction:hash,claims:1,authorizations:0,state:'review_required'});
});
test('C6-09 current operator list/detail follows all pause combinations and review/revocation at 360/768/1440',async()=>{
 const p=await paid(),authority=await sessionFixture(),ctx=await browser.newContext({ignoreHTTPSErrors:true});await ctx.addCookies([{name:'__Host-dispatch_operator',value:authority.token,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);const tab=await ctx.newPage();
 try{for(const payment of [false,true])for(const fulfillment of [false,true]){
 for(const [kind,paused] of [['payments',payment],['fulfillment',fulfillment]]){const c=await operator.config(auth);await operator.pause(auth,kind,randomUUID(),{paused,expected_version:c.controls.version,reason:'Correction operator matrix'});}
 const d=await operator.orders(auth,p.order);assert.equal(d.status.delivery.state,fulfillment?'blocked':'available');if(fulfillment)await assert.rejects(retrievePurchase(p.directory));else assert.equal((await retrievePurchase(p.directory)).toString(),'Independent review private bytes');
 const granted=await commerce.status(p.order,p.credential);assert.equal(granted.delivery.state,d.status.delivery.state);
 for(const width of [360,768,1440]){await tab.setViewportSize({width,height:1000});await tab.goto(origin+'/operator');await tab.getByRole('button',{name:'Orders',exact:true}).click();const entry=tab.locator('article').filter({has:tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)})});assert.match(await entry.innerText(),new RegExp('Delivery: '+d.status.delivery.state));assert.match(await entry.innerText(),/Merchant handoff: not_configured/);await tab.screenshot({path:out+`/current-list-${payment}-${fulfillment}-${width}.png`,fullPage:true});await tab.getByRole('button',{name:'Review order '+p.order.slice(0,8)}).click();assert.match(await tab.locator('dl').innerText(),new RegExp(d.status.delivery.state));await tab.screenshot({path:out+`/current-detail-${payment}-${fulfillment}-${width}.png`,fullPage:true});await tab.keyboard.press('Tab');assert.notEqual(await tab.evaluate(()=>document.activeElement.tagName),'BODY');assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
 }
 for(const state of ['blocked','revoked']){await admin.query('UPDATE orders SET fulfillment_state=$2 WHERE id=$1',[p.order,state]);for(const width of [360,768,1440]){await tab.setViewportSize({width,height:1000});await tab.getByRole('button',{name:'Refresh order'}).click();await tab.getByRole('status').filter({hasText:'Working…'}).waitFor({state:'hidden'});assert.match(await tab.locator('dl').innerText(),new RegExp(state));await tab.screenshot({path:out+`/current-${state}-${width}.png`,fullPage:true});}}
 await record('C6-09',{pause_combinations:4,widths:[360,768,1440],review_and_revocation:true});
 }finally{for(const kind of ['payments','fulfillment']){const c=await operator.config(auth);await operator.pause(auth,kind,randomUUID(),{paused:false,expected_version:c.controls.version,reason:'Resume correction fixture'});}await ctx.close();}
});
for(const boundary of ['invocation','authorization'])for(const change of ['revoked','absolute','idle','fresh'])test(`C6-11 ${change} before ${boundary} server boundary prevents wallet call`,async()=>{
 const p=await paid(),ui=await browserRefund(p,await newSigner()),trace=[],startedAt=Date.now(),method=boundary==='invocation'?'invoke':'authorize',original=refunds[method];
 const event=(stage,details={})=>trace.push({ms:Date.now()-startedAt,stage,...details});
 refunds[method]=async function(...args){event('server_enter');try{const value=await original.apply(this,args);event('server_return');return value;}catch(e){event('server_error',{error:e.message});throw e;}};
 ui.tab.on('response',r=>{if(r.url().endsWith('/'+boundary))event('browser_response',{status:r.status()});});
 ui.tab.on('requestfailed',r=>{if(r.url().endsWith('/'+boundary))event('browser_request_failed',{error:r.failure()?.errorText});});
 try{let reached=false;await ui.tab.route('**/'+boundary,async route=>{reached=true;event('route_enter');await invalidateSession(ui.authority,change);event('authority_changed');await route.continue();event('route_continued');});
 await ui.send();event('browser_action_completed');assert.equal(reached,true);assert.ok(trace.some(e=>e.stage==='server_error'&&e.error==='unauthorized'));assert.ok(trace.some(e=>e.stage==='browser_response'&&e.status===401));assert.equal(ui.calls,0);await record(`C6-11-${boundary}-${change}`,{wallet_calls:0,trace});
 }catch(e){event('failure',{error:e.message,wallet_calls:ui.calls});throw e;}
 finally{refunds[method]=original;await writeFile(out+`/authority-trace-${boundary}-${change}.json`,JSON.stringify(trace,null,2)+'\n');await ui.ctx.close();}
});
test('C6-12 revocation after final server authorization is not atomic with the browser; retain already-authorized outcome',async()=>{
 const p=await paid(),ui=await browserRefund(p,await newSigner());try{await ui.tab.route('**/authorization',async route=>{const response=await route.fetch();assert.equal(response.status(),200);assert.equal(ui.calls,0);await operator.auth.logout(ui.authority);await route.fulfill({response});});await ui.send();assert.equal(ui.calls,1);const row=await ui.row(),saved=await ui.tab.evaluate(id=>JSON.parse(localStorage.getItem('dispatch-refund-invocation:'+id)),row.id);assert.ok(saved.body.transaction_hash);await refunds.observation(await sessionFixture(),row.id,saved.key,saved.body);await request('anvil_mine',['0x40','0x0']);assert.equal(await reconcileRefund(worker.pool,row.id,refundRpc),'confirmed');await record('C6-12',{wallet_calls:1,revocation:'after final server authority commit',atomicity_claim:false,late_result:'retained'});}finally{await ui.ctx.close();}
});

// The real original-payment reorg deliberately quarantines this fixture; run it last.
test('C6-10 canonical invocation anchor reorg, original-payment reorg and cross-intent races after restart retain review',async()=>{
 const beforeOriginal=await request('evm_snapshot'),p=await paid(),account=await newSigner(),b=await bound(p,account);
 const beforeAuthority=await request('evm_snapshot');await request('evm_mine');await authorize(b);const hash=await directSend(b,account);await report(b,hash);await request('anvil_mine',['0x40','0x0']);assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'confirmed');
 const other=await paid(),otherBound=await bound(other,await newSigner());await authorize(otherBound);await report(otherBound,hash);await restartApi();const results=await Promise.all([reconcileRefund(worker.pool,b.id,refundRpc),reconcileRefund(worker.pool,otherBound.id,refundRpc)]);assert.deepEqual(results,['confirmed','review_required']);
 assert.equal(await request('evm_revert',[beforeAuthority]),true);await request('evm_mine');assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'review_required');assert.equal((await refunds.get(auth,b.id)).transaction_hint,hash);
 assert.equal(await request('evm_revert',[beforeOriginal]),true);await request('evm_mine');assert.equal(await reconcileRefund(worker.pool,b.id,refundRpc),'review_required');await assert.rejects(refunds.authorize(auth,b.id,{expected_version:b.version}));
 await record('C6-10',{confirmed_then_reorg:'review_required',invocation_and_original_reorg:true,cross_intent_after_restart:results,hash_retained:hash});
});
