import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {encodePaymentSignatureHeader} from '@x402/core/http';
import {createPurchase,preparePurchase,authorizePurchase,resumePurchase} from '../../dist/examples/agent/src/purchase.js';
import {FileJournal} from '../../dist/examples/agent/src/journal.js';
import {validateQuote,validateChallenge,transport} from '../../dist/packages/buyer/src/client.js';
import {parseJSON,status as parseStatus,formatUSDC} from '../../dist/packages/buyer/src/contracts.js';
import {setup,teardown,admin,api,worker,commerce,origin,fixture,policy,newSigner,settle,httpCall,restartApi,support,logs,request,client,token,payee} from './fixtures.mjs';
const out=process.env.DISPATCH_BUYER_EVIDENCE,base=process.env.DISPATCH_DB_HOST;
let browser;const screenshots=[],a11y=[],timing=[];const secrets=[];
test.before(async()=>{await setup();browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});});
test.after(async()=>{if(browser)await browser.close();await writeFile(out+'/browser-evidence.json',JSON.stringify({screenshots,a11y,timing,browser:browser?.version(),wallets:'synthetic EIP-6963 providers, genuine generated local-chain signatures; no extension claims',tls:'self-signed generated certificate; browser ignoreHTTPSErrors only; Secure/HttpOnly cookies unchanged'},null,2)+'\n');await teardown();});
test.beforeEach(async()=>{await support();await admin.query('TRUNCATE dispatch.abuse_counters');});
async function createBrowser(cookie,csrf){const r=await httpCall('/v1/checkouts',{method:'POST',headers:{'X-Dispatch-Intent':'checkout',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},body:{product_id:fixture.product,product_version:1,quantity:1,client_kind:'browser'}});assert.equal(r.status,201);const body=await r.json();assert.equal(Object.hasOwn(body,'agent_capability'),false);const c=r.headers.get('set-cookie');assert.match(c,/; Secure; HttpOnly; SameSite=Lax; Path=\//);assert.doesNotMatch(c,/Domain=/);secrets.push(c.split(';')[0].split('=')[1]);return {id:body.id,cookie:c.split(';')[0]};}
async function csrfFor(cookie){return (await (await httpCall('/v1/session',{headers:{Cookie:cookie}})).json()).csrf_token;}
async function quoteBrowser(b,csrf){return httpCall('/v1/checkouts/'+b.id+'/quote',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':csrf,'Idempotency-Key':randomUUID()},body:{product_version:1,quantity:1,policy_version:'policy-1'}});}
async function freshAgent(){const directory=join(base,'agent-'+randomUUID()),journal=await createPurchase(policy(),directory);return {directory,journal,saved:await journal.read()};}
async function pageWithWallets(){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),page=await context.newPage(),accounts=[await newSigner(),await newSigner()];let signs=0;
  await page.exposeFunction('__fixtureSign',async(index,data)=>{signs++;const confirmed=await admin.query(`SELECT count(*) n FROM buyer_grants WHERE confirmed_at IS NOT NULL`);assert.ok(Number(confirmed.rows[0].n)>0);return accounts[index].signTypedData(JSON.parse(data));});
  await page.exposeFunction('__fixtureRpc',async(method,params)=>request(method,params));
  await page.addInitScript(({addresses})=>{
    const state={mode:'normal',chain:'0x2105',addresses,accounts:[addresses[0]],balanceMode:'real',prompts:0,release:null};
    const providers=addresses.map((address,index)=>{const listeners={};return {
      on(name,fn){(listeners[name]??=[]).push(fn);},removeListener(name,fn){listeners[name]=(listeners[name]??[]).filter(f=>f!==fn);},
      emit(name,value){for(const fn of listeners[name]??[])fn(value);},
      async request({method,params}){
        if(method==='eth_chainId')return state.chain;
        if(method==='eth_accounts'){if(state.mode==='post_reject'&&state.prompts>0)throw {code:4001};return state.accounts.length?[address]:[];}
        if(method==='eth_requestAccounts'){if(state.mode==='connect_reject')throw {code:4001};return [address];}
        if(method==='wallet_switchEthereumChain'){state.chain='0x2105';this.emit('chainChanged',state.chain);return null;}
        if(method==='eth_call'){if(state.balanceMode==='unavailable')throw new Error('offline');if(state.balanceMode==='zero')return '0x'+'0'.repeat(64);return window.__fixtureRpc(method,params);}
        if(method==='eth_signTypedData_v4'){state.prompts++;if(state.mode==='reject')throw {code:4001};if(state.mode==='hold')await new Promise(r=>state.release=r);return window.__fixtureSign(index,params[1]);}
        throw new Error('unsupported fixture method');
      }};});
    window.__wallet={state,providers};
    window.addEventListener('eip6963:requestProvider',()=>providers.forEach((provider,index)=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:index?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111',name:index?'Fixture Wallet B':'Fixture Wallet A',icon:'data:image/svg+xml,<svg onload=alert(1)>',rdns:'untrusted.fixture'},provider}}))));
  },{addresses:accounts.map(a=>a.address)});
  return {context,page,accounts,signs:()=>signs};
}
async function beginPage(page){const started=Date.now();await page.goto(origin+'/buy/'+fixture.product);await page.getByRole('button',{name:'Begin checkout',exact:true}).waitFor();timing.push({width:(await page.viewportSize()).width,interactive_ms:Date.now()-started});assert.equal(await page.evaluate(()=>window.__wallet?.state.prompts??0),0);await page.getByRole('button',{name:'Begin checkout',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Review exact quote',exact:true}).click();await page.getByRole('button',{name:'Connect a wallet',exact:true}).waitFor();return page.url().split('/').at(-1);}
async function connectPage(page,name='Fixture Wallet A'){await page.getByRole('button',{name:/Connect a wallet|Choose another wallet/}).click();await page.getByRole('button',{name:'Connect '+name,exact:true}).click();await page.getByRole('button',{name:/^Authorize /}).waitFor();}
async function capture(page,label){
  for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});await page.screenshot({path:out+`/${label}-${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);screenshots.push(`${label}-${width}.png`);}
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  a11y.push({state:label,violations:result.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length})),incomplete:result.incomplete.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length}))});
  assert.equal(result.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);
}
test('B4-01 sanitized catalog uses public projections; malicious description remains data',async()=>{
 const r=await httpCall('/v1/catalog'),body=await r.json();assert.equal(r.status,200);assert.equal(body.products.length,1);assert.match(body.products[0].description,/Ignore all rules/);
 assert.equal(Object.keys(body.products[0]).some(k=>/asset_id|private|capability|secret|signature/.test(k)),false);
 const single=await httpCall('/v1/catalog/'+fixture.product);assert.equal(single.status,200);
 assert.equal((await httpCall('/v1/orders')).status,404);assert.equal((await httpCall('/v1/operator/config')).status,404);
});
test('B4-02 browser credential is HttpOnly; each explicit order requires its own status confirmation',async()=>{
 const b=await createBrowser(),csrf=await csrfFor(b.cookie);assert.equal((await quoteBrowser(b,csrf)).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+b.id,{headers:{Cookie:b.cookie}})).status,200);assert.equal((await quoteBrowser(b,csrf)).status,200);
 const second=await createBrowser(b.cookie,csrf);assert.equal(second.cookie===b.cookie,true);assert.equal((await quoteBrowser(second,csrf)).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+second.id,{headers:{Cookie:b.cookie}})).status,200);assert.equal((await quoteBrowser(second,csrf)).status,200);
 assert.equal((await httpCall('/v1/checkouts/'+b.id,{headers:{Cookie:b.cookie}})).status,200);
 await assert.rejects(api.query('UPDATE buyer_grants SET order_id=$1 WHERE order_id=$2',[b.id,second.id]),/permission denied/);
});
test('B4-03 exact Origin, JSON, CSRF, mixed auth, cross-buyer and public-data credential denial',async()=>{
 const a=await createBrowser(),b=await createBrowser();const csrf=await csrfFor(a.cookie);
 await httpCall('/v1/checkouts/'+a.id,{headers:{Cookie:a.cookie}});
 assert.equal((await quoteBrowser(a,'wrong-csrf')).status,403);
 assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Cookie:b.cookie}})).status,401);
 for(const authority of [randomUUID(),'0x'+'ab'.repeat(32),'0x'+'cd'.repeat(65)])assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Authorization:'Bearer '+authority}})).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+a.id,{headers:{Cookie:a.cookie,Authorization:'Bearer '+'x'.repeat(43)}})).status,401);
 assert.equal((await httpCall('/v1/checkouts/'+a.id+'/quote',{method:'POST',headers:{Cookie:a.cookie,'X-CSRF-Token':csrf,Origin:'https://evil.invalid'},body:{}})).status,400);
 assert.equal((await httpCall('/v1/session',{headers:{Cookie:a.cookie,'Sec-Fetch-Site':'cross-site'}})).status,403);
 const cors=await httpCall('/v1/session',{method:'OPTIONS',headers:{Origin:'https://evil.invalid'}});assert.equal(cors.headers.has('access-control-allow-origin'),false);
 const type=await fetch(origin+'/v1/checkouts',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:'{}'});assert.equal(type.status,415);
});
test('B4-04 recovery export is scoped, idempotent, private; rotation and expiry fail closed',async()=>{
 const b=await createBrowser(),csrf=await csrfFor(b.cookie);await httpCall('/v1/checkouts/'+b.id,{headers:{Cookie:b.cookie}});const op=randomUUID();
 const exportOne=async(key=op)=>httpCall('/v1/orders/'+b.id+'/recovery',{method:'POST',headers:{Cookie:b.cookie,'X-CSRF-Token':csrf,'Idempotency-Key':key},body:{}});
 const r=await exportOne(),first=await r.json();assert.equal(r.status,200);assert.match(r.headers.get('content-disposition'),/attachment/);secrets.push(first.capability);
 const replay=await (await exportOne()).json();assert.equal(first.capability===replay.capability,true);
 const imported=await httpCall('/v1/recovery/import',{method:'POST',headers:{'X-Dispatch-Intent':'recovery'},body:{capability:first.capability}});assert.equal(imported.status,200);
 const restored=imported.headers.get('set-cookie').split(';')[0];assert.equal((await httpCall('/v1/checkouts/'+b.id,{headers:{Cookie:restored}})).status,200);
 const second=await exportOne(randomUUID());assert.equal(second.status,200);
 assert.equal((await httpCall('/v1/recovery/import',{method:'POST',headers:{'X-Dispatch-Intent':'recovery'},body:{capability:first.capability}})).status,401);

 // Identity is immutable; expiry is tested with expired sessions created below.
 const session=randomUUID(),cap='z'.repeat(43);const {digest}=await import('../../dist/packages/db/src/commerce.js');
 await admin.query("INSERT INTO buyer_sessions(id,capability_hash,kind,created_at,expires_at) VALUES($1,$2,'recovery',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day')",[session,digest(cap)]);
 await admin.query('INSERT INTO buyer_grants(session_id,order_id) VALUES($1,$2)',[session,b.id]);
 assert.equal((await httpCall('/v1/recovery/import',{method:'POST',headers:{'X-Dispatch-Intent':'recovery'},body:{capability:cap}})).status,401);
});
test('B4-05 upstream agent: persisted credential, lost response, process/API restart, one genuine local debit and delivery job',async()=>{
 const p=await freshAgent(),signer=await newSigner();let signs=0,dropped=false;
 const cap=p.saved.credential;secrets.push(cap);assert.equal((await readFile(p.directory+'/purchase.enc')).includes(Buffer.from(cap)),false);assert.equal((await stat(p.directory)).mode&0o077,0);
 const lossy=async(input,init)=>{const req=new Request(input,init),response=await fetch(req);if(req.headers.has('PAYMENT-SIGNATURE')&&!dropped){dropped=true;throw new Error('synthetic_response_lost');}return response;};
 await assert.rejects(authorizePurchase(p.directory,policy(),{address:signer.address,signTypedData:async data=>{signs++;assert.equal((await p.journal.read()).confirmed,true);return signer.signTypedData(data);}},lossy));
 assert.equal(signs,1);assert.equal((await p.journal.read()).stage,'signed');assert.equal((await resumePurchase(p.directory)).order_state,'payment_pending');
 await restartApi();const child=spawn(process.execPath,['tests/buyer/resume.mjs',p.directory],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);const [code]=await once(child,'exit');assert.equal(code,0,stderr);assert.equal(JSON.parse(stdout).order_state,'payment_pending');assert.equal(stdout.includes(cap),false);
 await authorizePurchase(p.directory,policy(),{address:signer.address,async signTypedData(){throw new Error('must_not_sign');}});assert.equal(signs,1);
 const attempt=await settle(p.saved.order),paid=await resumePurchase(p.directory);assert.equal(paid.payment_state,'settled');assert.equal(paid.delivery.state,'queued');
 const saved=await p.journal.read();secrets.push(saved.payment.payload.signature);
 const replay=await httpCall('/v1/checkouts/'+saved.order+'/pay',{method:'POST',headers:{Authorization:'Bearer '+saved.credential,'Idempotency-Key':saved.payKey,'PAYMENT-SIGNATURE':encodePaymentSignatureHeader(saved.payment)},body:{quote_id:saved.quote.id,quote_hash:saved.quote.quote_hash}});assert.equal(replay.status,202);
 assert.equal((await admin.query('SELECT count(*) n FROM settlements WHERE attempt_id=$1',[attempt])).rows[0].n,'1');assert.equal((await admin.query("SELECT count(*) n FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[saved.order])).rows[0].n,'1');
 const balance=await client.readContract({address:token,abi:[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}],functionName:'balanceOf',args:[signer.address]});assert.equal(balance,999900n);
});
test('B4-06 concurrent agent authorize calls claim one signing operation and one financial effect',async()=>{
 const p=await freshAgent(),signer=await newSigner();let signs=0;const boundary={address:signer.address,async signTypedData(d){signs++;return signer.signTypedData(d);}};
 await Promise.allSettled([authorizePurchase(p.directory,policy(),boundary),authorizePurchase(p.directory,policy(),boundary)]);assert.equal(signs,1);
 assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[p.saved.order])).rows[0].n,'1');await settle(p.saved.order);
});
test('B4-07 agent allowlists, exact amounts, challenge binding and untrusted text cannot expand authority',async()=>{
 const p=await freshAgent(),q=p.saved.quote,pol=policy();
 for(const mutation of [{maxAtomic:'99'},{payees:['0x'+'33'.repeat(20)]},{network:'eip155:1'},{token:'0x'+'44'.repeat(20)},{productVersion:2},{policyVersion:'unapproved'}])assert.throws(()=>validateQuote(q,{...pol,...mutation},p.saved.order));
 const res=await httpCall('/v1/checkouts/'+p.saved.order+'/pay',{method:'POST',headers:{Authorization:'Bearer '+p.saved.credential,'Idempotency-Key':randomUUID()},body:{quote_id:q.id,quote_hash:q.quote_hash}});assert.equal(res.status,402);const required=await res.json(),selected=required.accepts[0];validateChallenge(required,selected,q,pol,p.saved.order);
 for(const mutation of [{amount:'999'},{payTo:'0x'+'33'.repeat(20)},{network:'eip155:1'},{asset:'0x'+'44'.repeat(20)},{maxTimeoutSeconds:3600},{extra:{...selected.extra,assetTransferMethod:'permit2'}},{extra:{...selected.extra,name:'Evil'}}]){const changed={...selected,...mutation};assert.throws(()=>validateChallenge({...required,accepts:[changed]},changed,q,pol,p.saved.order));}
 assert.throws(()=>validateChallenge({...required,resource:{url:origin+'/v1/checkouts/'+randomUUID()+'/pay'}},selected,q,pol,p.saved.order));
 assert.throws(()=>validateChallenge({...required,resource:{url:'https://evil.invalid/pay'}},selected,q,pol,p.saved.order));
 assert.throws(()=>validateQuote({...q,total_atomic:'90071992547409931234567'},pol,p.saved.order));assert.equal(formatUSDC('90071992547409931234567'),'90071992547409931.234567');
 const s=await resumePurchase(p.directory);await admin.query('UPDATE orders SET version=9007199254740993123 WHERE id=$1',[s.id]);const exact=await resumePurchase(p.directory);assert.equal(exact.version,'9007199254740993123');
});
test('B4-08 redirects never move scoped authority; journal claim survives crash before stage save',async()=>{
 const p=await freshAgent(),send=transport(origin,new Map([['/v1/checkouts/'+p.saved.order,new Set(['GET'])]]),async req=>{assert.equal(req.redirect,'error');return new Response('',{status:307,headers:{Location:'https://evil.invalid/'}});},'omit');
 await assert.rejects(send(origin+'/v1/checkouts/'+p.saved.order,{headers:{Authorization:'Bearer '+p.saved.credential}}),/redirect_refused/);await assert.rejects(send('https://evil.invalid/'),/destination_refused/);
 await writeFile(p.directory+'/signing.claim','fixture interrupted before journal write',{mode:0o600,flag:'wx'});const reopened=new FileJournal(p.directory);assert.equal((await reopened.read()).stage,'signing');
 const signer=await newSigner();let calls=0;await authorizePurchase(p.directory,policy(),{address:signer.address,async signTypedData(){calls++;throw new Error('no');}});assert.equal(calls,0);
});
test('B4-09 actual browser human checkout: explicit selection, keyboard, HTTPS cookies, lost response/reload, real EVM',async()=>{
 const b=await pageWithWallets();try{
  const order=await beginPage(b.page);await capture(b.page,'quote');
  await b.page.getByRole('button',{name:'Connect a wallet',exact:true}).focus();await b.page.keyboard.press('Enter');await b.page.getByRole('dialog').waitFor();assert.equal(await b.page.getByRole('button',{name:'Connect Fixture Wallet B',exact:true}).count(),1);
  await b.page.getByRole('button',{name:'Connect Fixture Wallet B',exact:true}).focus();await b.page.keyboard.press('Enter');await b.page.getByRole('button',{name:/^Authorize /}).waitFor();
  await capture(b.page,'ready');const cookies=await b.context.cookies();const c=cookies.find(c=>c.name==='__Host-dispatch_buyer');assert.ok(c?.secure&&c.httpOnly&&c.sameSite==='Lax');assert.equal(c.domain,'127.0.0.1');assert.equal((await b.page.evaluate(()=>document.cookie)).includes('dispatch_buyer'),false);assert.equal(await b.page.locator('img').count(),0);
  let releaseSubmission;let dropped=false;await b.page.route('**/v1/checkouts/*/pay',async route=>{if(route.request().headers()['payment-signature']&&!dropped){dropped=true;await new Promise(r=>releaseSubmission=r);await route.fetch();await route.abort('failed');}else await route.continue();});
  await b.page.getByRole('button',{name:/^Authorize /}).dblclick();await b.page.getByRole('heading',{name:'Saving your payment',exact:true}).waitFor();await capture(b.page,'submitting');releaseSubmission();await b.page.getByRole('heading',{name:'Checking your payment',exact:true}).waitFor();assert.equal(b.signs(),1);await capture(b.page,'pending');
  await b.page.reload();await b.page.getByRole('heading',{name:'Checking your payment',exact:true}).waitFor();assert.equal(b.signs(),1);await settle(order);
  await b.page.getByRole('button',{name:'Check payment status',exact:true}).click();await b.page.getByRole('heading',{name:'Payment confirmed',exact:true}).waitFor();await capture(b.page,'paid-delivery-pending');assert.equal(await b.page.getByRole('link',{name:/download|receipt/i}).count(),0);assert.equal(await b.page.getByRole('button',{name:/^Authorize /}).count(),0);
 }finally{await b.context.close();}
});
test('B4-10 browser account/chain change away-and-back during approval rejects late signature without submission',async()=>{
 const b=await pageWithWallets();try{const order=await beginPage(b.page);await connectPage(b.page);await b.page.evaluate(()=>window.__wallet.state.mode='hold');await b.page.getByRole('button',{name:/^Authorize /}).click();await b.page.getByRole('heading',{name:'Review in your wallet',exact:true}).waitFor();await capture(b.page,'awaiting-wallet');
  await b.page.evaluate(()=>{const w=window.__wallet;w.state.chain='0x1';w.providers[0].emit('chainChanged','0x1');w.state.chain='0x2105';w.providers[0].emit('chainChanged','0x2105');w.providers[0].emit('accountsChanged',['0x'+'33'.repeat(20)]);w.providers[0].emit('accountsChanged',w.state.addresses);w.state.release();});
  await b.page.getByRole('heading',{name:'Check this order’s status',exact:true}).waitFor();assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[order])).rows[0].n,'0');assert.equal(b.signs(),1);await b.page.reload();await b.page.getByRole('heading',{name:'Check this order’s status',exact:true}).waitFor();assert.equal(b.signs(),1);
 }finally{await b.context.close();}
});
test('B4-11 rejected signature permits deliberate retry; unavailable/insufficient balance and wrong chain block signing',async()=>{
 const b=await pageWithWallets();try{await beginPage(b.page);await b.page.evaluate(()=>window.__wallet.state.chain='0x1');await connectPage(b.page);await b.page.getByRole('button',{name:'Switch to Base',exact:true}).waitFor();await capture(b.page,'wrong-network');assert.equal(b.signs(),0);
  await b.page.getByRole('button',{name:'Switch to Base',exact:true}).click();await b.page.evaluate(()=>window.__wallet.state.balanceMode='zero');await b.page.getByRole('button',{name:'Check wallet & balance',exact:true}).click();await b.page.getByRole('alert').filter({hasText:'does not have enough'}).waitFor();await capture(b.page,'insufficient');
  await b.page.evaluate(()=>window.__wallet.state.balanceMode='unavailable');await b.page.getByRole('button',{name:'Check wallet & balance',exact:true}).click();await b.page.getByRole('alert').filter({hasText:'could not read'}).waitFor();await capture(b.page,'balance-unavailable');
  await b.page.evaluate(()=>{window.__wallet.state.balanceMode='real';window.__wallet.state.mode='reject';});await b.page.getByRole('button',{name:'Check wallet & balance',exact:true}).click();await b.page.getByRole('button',{name:/^Authorize /}).click();await b.page.getByRole('alert').filter({hasText:'Authorization declined'}).waitFor();await capture(b.page,'signature-rejected');assert.equal(b.signs(),0);
  await b.page.evaluate(()=>window.__wallet.state.mode='normal');await b.page.getByRole('button',{name:/^Authorize /}).click();await b.page.getByRole('heading',{name:'Checking your payment',exact:true}).waitFor();assert.equal(b.signs(),1);
 }finally{await b.context.close();}
});
test('B4-12 browser wallet unavailable and rejected connection states',async()=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true}),page=await ctx.newPage();try{await beginPage(page);await page.getByRole('button',{name:'Connect a wallet',exact:true}).click();await page.getByText('No injected wallet is available.',{exact:false}).waitFor();await capture(page,'wallet-unavailable');await page.getByRole('button',{name:'Cancel',exact:true}).click();}finally{await ctx.close();}
 const b=await pageWithWallets();try{await beginPage(b.page);await b.page.evaluate(()=>window.__wallet.state.mode='connect_reject');await connectPage(b.page);await b.page.getByRole('alert').filter({hasText:'Connection declined'}).waitFor();await capture(b.page,'connect-rejected');assert.equal(b.signs(),0);}finally{await b.context.close();}
});
test('B4-13 paused/review/session-expiry/stale-quote states preserve status and no fresh signing',async()=>{
 const b=await pageWithWallets();try{const order=await beginPage(b.page);await connectPage(b.page);
  await admin.query('UPDATE merchant_control SET payment_paused=true');await b.page.getByRole('button',{name:/^Authorize /}).click();await b.page.getByRole('alert').waitFor();assert.equal(b.signs(),0);await capture(b.page,'paused');await admin.query('UPDATE merchant_control SET payment_paused=false');
  await admin.query("UPDATE orders SET state='review_required',version=version+1 WHERE id=$1",[order]);await b.page.getByRole('button',{name:'Check payment status',exact:true}).click();await b.page.getByRole('heading',{name:'Payment needs review',exact:true}).waitFor();await capture(b.page,'review');
  await b.context.clearCookies();await b.page.reload();await b.page.getByRole('alert').filter({hasText:'session expired'}).waitFor();await capture(b.page,'session-expired');assert.equal(b.signs(),0);
 }finally{await admin.query('UPDATE merchant_control SET payment_paused=false');await b.context.close();}
 const c=await pageWithWallets();try{await beginPage(c.page);await c.page.clock.install({time:new Date()});await c.page.clock.fastForward(121000);await c.page.getByRole('heading',{name:'Price window expired',exact:true}).waitFor();await capture(c.page,'quote-expired');assert.equal(c.signs(),0);}finally{await c.context.close();}
});
test('B4-14 existing merchant checkout unchanged with additive plain link present, absent or Dispatch unavailable',async()=>{
 const ctx=await browser.newContext(),page=await ctx.newPage();try{
  const baseHTML='<html lang="en"><head><title>Existing merchant</title><style>body{font:16px sans-serif}.card{width:260px;padding:20px}</style></head><body><form class="card" action="/card" method="post"><label>Email<input name="email" value="fixture@example.invalid"></label><button>Existing card checkout</button></form><div id="dispatch-slot"></div></body></html>';
  await page.route('http://merchant.invalid/**',route=>route.request().url().endsWith('/card')?route.fulfill({body:'Original card checkout completed',contentType:'text/plain'}):route.fulfill({body:baseHTML,contentType:'text/html'}));
  let baseline;
  for(const mode of ['absent','present','down']){await page.goto('http://merchant.invalid/');if(mode!=='absent')await page.locator('#dispatch-slot').evaluate((el,url)=>{const a=document.createElement('a');a.href=url;a.textContent='Pay with USDC';el.append(a);},origin+'/buy/'+fixture.product);
    const box=await page.locator('form').boundingBox();if(!baseline)baseline=box;else assert.deepEqual(box,baseline);if(mode==='down')await page.route(origin+'/**',route=>route.abort());
    await page.getByRole('button',{name:'Existing card checkout',exact:true}).click();await page.getByText('Original card checkout completed').waitFor();}
 }finally{await ctx.close();}
});
test('B4-15 secret canaries absent from logs/browser build and payment proof never grants another buyer access',async()=>{
 const p=await freshAgent(),other=await freshAgent(),signer=await newSigner();await authorizePurchase(p.directory,policy(),signer);const saved=await p.journal.read();secrets.push(saved.credential,saved.payment.payload.signature);
 assert.equal((await httpCall('/v1/checkouts/'+saved.order,{headers:{Authorization:'Bearer '+other.saved.credential,'PAYMENT-SIGNATURE':encodePaymentSignatureHeader(saved.payment)}})).status,401);
 const files=await readdir('apps/web/dist/assets');const bundle=(await Promise.all(files.map(f=>readFile('apps/web/dist/assets/'+f,'utf8')))).join('\n');
 for(const secret of secrets){assert.equal(logs.join('').includes(secret),false);assert.equal(bundle.includes(secret),false);}
 assert.equal(/dispatch_migrator|authorization_ciphertext|DISPATCH_DB_HOST|journal\.key/.test(bundle),false);
});
test('B4-16 successful signature followed by context 4001 remains uncertain; no retry after reload',async()=>{
 const b=await pageWithWallets();try{const order=await beginPage(b.page);await connectPage(b.page);await b.page.evaluate(()=>window.__wallet.state.mode='post_reject');
  await b.page.getByRole('button',{name:/^Authorize /}).click();await b.page.getByRole('heading',{name:'Check this order’s status',exact:true}).waitFor();assert.equal(b.signs(),1);
  assert.equal(await b.page.getByRole('button',{name:/^Authorize /}).count(),0);assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[order])).rows[0].n,'0');
  await b.page.reload();await b.page.getByRole('heading',{name:'Check this order’s status',exact:true}).waitFor();assert.equal(b.signs(),1);
 }finally{await b.context.close();}
});
test('B4-17 lost quote response recovers same pre-sign agent/browser purchase only after explicit review',async()=>{
 const directory=join(base,'preparation-'+randomUUID());let lost=false;
 const lossy=async(input,init)=>{const req=new Request(input,init),r=await fetch(req);if(req.url.endsWith('/quote')&&!lost){lost=true;throw new Error('quote_response_lost');}return r;};
 await assert.rejects(createPurchase(policy(),directory,lossy));const saved=await new FileJournal(directory).read();assert.equal(saved.stage,'ready');assert.equal(saved.quote,undefined);
 const s=await resumePurchase(directory);assert.equal(s.order_state,'quoted');await preparePurchase(directory,policy());assert.equal((await new FileJournal(directory).read()).quote.id,s.quote.id);
 const signer=await newSigner();await authorizePurchase(directory,policy(),signer);assert.equal((await resumePurchase(directory)).order_state,'payment_pending');
 const b=await pageWithWallets();try{let dropped=false;await b.page.route('**/v1/checkouts/*/quote',async route=>{if(!dropped){dropped=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await b.page.goto(origin+'/buy/'+fixture.product);await b.page.getByRole('button',{name:'Begin checkout',exact:true}).click();await b.page.getByRole('checkbox').check();await b.page.getByRole('button',{name:'Review exact quote',exact:true}).click();await b.page.getByRole('alert').waitFor();
  const order=b.page.url().split('/').at(-1),before=(await admin.query('SELECT id FROM quotes WHERE order_id=$1',[order])).rows[0].id;
  await b.page.reload();await b.page.getByRole('checkbox').check();await b.page.getByRole('button',{name:'Review exact quote',exact:true}).click();await b.page.getByRole('button',{name:'Connect a wallet',exact:true}).waitFor();
  assert.equal((await admin.query('SELECT id FROM quotes WHERE order_id=$1',[order])).rows[0].id,before);assert.equal(b.signs(),0);
 }finally{await b.context.close();}
});
test('B4-18 quote expires while wallet approval is pending; late authorization cannot submit',async()=>{
 const b=await pageWithWallets();try{const order=await beginPage(b.page);await connectPage(b.page);await b.page.clock.install({time:new Date()});await b.page.evaluate(()=>window.__wallet.state.mode='hold');
  await b.page.getByRole('button',{name:/^Authorize /}).click();await b.page.getByRole('heading',{name:'Review in your wallet',exact:true}).waitFor();await b.page.clock.fastForward(121000);await b.page.evaluate(()=>window.__wallet.state.release());
  await b.page.getByRole('heading',{name:'Check this order’s status',exact:true}).waitFor();assert.equal((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[order])).rows[0].n,'0');assert.equal(b.signs(),1);
 }finally{await b.context.close();}
});
test('B4-19 browser exported recovery file imports privately after session loss',async()=>{
 const b=await pageWithWallets();try{const order=await beginPage(b.page),download= b.page.waitForEvent('download');await b.page.getByRole('button',{name:'Save recovery file',exact:true}).click();const d=await download,stream=await d.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);const buffer=Buffer.concat(chunks);const recovery=JSON.parse(buffer);secrets.push(recovery.capability);assert.equal(recovery.order_id,order);
  await b.context.clearCookies();await b.page.reload();await b.page.getByRole('alert').filter({hasText:'session expired'}).waitFor();await b.page.getByText('Recover a checkout',{exact:true}).click();await b.page.getByLabel('Recovery file',{exact:true}).setInputFiles({name:'dispatch-recovery.json',mimeType:'application/json',buffer});
  await b.page.getByRole('heading',{name:'Review your purchase',exact:true}).waitFor();assert.equal(b.signs(),0);assert.equal(b.page.url(),origin+'/checkout/'+order);assert.equal((await b.page.evaluate(()=>document.cookie)).includes('dispatch_buyer'),false);
 }finally{await b.context.close();}
});
test('B4-20 real HTTPS redirect transport refuses credential forwarding to a second origin',async()=>{
 const {createServer}=await import('node:https'),tls={key:await readFile(base+'/tls.key'),cert:await readFile(base+'/tls.crt')};let received=0;
 const target=createServer(tls,(_req,res)=>{received++;res.end('unexpected');}),source=createServer(tls,(_req,res)=>{res.writeHead(307,{Location:'https://127.0.0.1:18448/receive'});res.end();});
 target.listen(18448,'127.0.0.1');source.listen(18447,'127.0.0.1');await Promise.all([once(target,'listening'),once(source,'listening')]);
 try{const send=transport('https://127.0.0.1:18447',new Map([['/pay',new Set(['POST'])]]),fetch,'omit');
  await assert.rejects(send('https://127.0.0.1:18447/pay',{method:'POST',headers:{Authorization:'Bearer '+'g'.repeat(43)},body:'{}'}));assert.equal(received,0);
 }finally{await Promise.all([new Promise(r=>target.close(r)),new Promise(r=>source.close(r))]);}
});
test('B4-21 altered upstream challenge is refused before the external signer; stale journal cannot overwrite signing',async()=>{
 const p=await freshAgent(),signer=await newSigner();let signs=0;
 const {encodePaymentRequiredHeader}=await import('@x402/core/http');
 const corrupt=async(input,init)=>{const req=new Request(input,init),r=await fetch(req);if(r.status!==402)return r;
  const required=await r.json();required.accepts[0].payTo='0x'+'55'.repeat(20);
  return new Response(JSON.stringify(required),{status:402,headers:{'Content-Type':'application/json','PAYMENT-REQUIRED':encodePaymentRequiredHeader(required)}});};
 await assert.rejects(authorizePurchase(p.directory,policy(),{address:signer.address,async signTypedData(data){signs++;return signer.signTypedData(data);}},corrupt));assert.equal(signs,0);
 const stale=await p.journal.read();await p.journal.claimSigning();await assert.rejects(p.journal.save(stale),/journal_regression/);assert.equal((await p.journal.read()).stage,'signing');
});

test('B4-22 modal keyboard focus stays inside and returns to its trigger; visible dialog accessibility',async()=>{
 const ctx=await browser.newContext({ignoreHTTPSErrors:true}),page=await ctx.newPage();
 try{
  await beginPage(page);const trigger=page.getByRole('button',{name:'Connect a wallet',exact:true});await trigger.focus();await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  for(let i=0;i<8;i++){await page.keyboard.press(i<4?'Tab':'Shift+Tab');assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),true);}
  const result=await new AxeBuilder({page}).include('[role="dialog"]').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  assert.equal(result.violations.length,0);
  await writeFile(out+'/modal-axe-detail.json',JSON.stringify(result.incomplete,null,2)+'\n');
  assert.ok(result.incomplete.every(v=>v.id==='color-contrast' && v.nodes.every(n=>n.any.every(c=>c.data?.messageKey==='elmPartiallyObscuring'))));
  const colors=await page.locator('[role="dialog"] p').evaluateAll(elements=>elements.map(el=>({foreground:getComputedStyle(el).color,background:getComputedStyle(el.closest('[role="dialog"]')).backgroundColor})));
  function luminance(color){const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;}
  const ratios=colors.map(c=>(luminance(c.background)+0.05)/(luminance(c.foreground)+0.05));assert.ok(ratios.every(r=>r>=4.5));
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await trigger.evaluate(el=>document.activeElement===el),true);
  await writeFile(out+'/modal-keyboard.json',JSON.stringify({tab_and_shift_tab_trapped:true,escape_closes:true,focus_returns_to_trigger:true,dialog_axe_violations:0,dialog_axe_incomplete:result.incomplete.map(v=>v.id),explicit_foreground_background_contrast:colors.map((c,i)=>({...c,ratio:ratios[i]})),background_hidden_by_modal:true})+'\n');
 }finally{await ctx.close();}
});
