// Automated developer walkthrough: synthetic local funds and generated wallets only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {once} from 'node:events';
import {localFixtureSigner} from './local-fixture-signer.mjs';
import {merchantSite} from '../dist/examples/merchant-site/src/server.js';
import {setup,teardown,origin,payee,admin,worker,refundRpc,newSigner,settle,request,support,token} from '../tests/operator/fixtures.mjs';
import {operationsTick} from '../dist/apps/worker/src/operations.js';
import {deliveryTick} from '../dist/apps/worker/src/delivery.js';
import {DeliveryStore} from '../dist/packages/db/src/delivery.js';
import {createPurchase,authorizePurchase,resumePurchase,retrievePurchase} from '../dist/examples/agent/src/purchase.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE;
const contexts=[];
function keepContext(context){contexts.push(context);}

test('Local merchant setup, human purchase, agent recovery and ordinary checkout',async()=>{
 let browser,context,site;
 let humanSigns=0,agentSigns=0,signedPosts=0,humanSignedPosts=0;
 const expected=Buffer.from('Private local demonstration guide.\n');
 try{
  await setup();assert.equal((await admin.query('SELECT count(*) n FROM products')).rows[0].n,'0');
  const password=randomBytes(24).toString('base64url'),boot=base+'/local-bootstrap';
  execFileSync(process.execPath,['scripts/operator-local.mjs','begin',origin,boot],{env:process.env});
  execFileSync(process.execPath,['scripts/operator-local.mjs','complete',boot],{env:process.env,input:password+'\n'});
  await writeFile(base+'/assets/demo-guide.txt',Buffer.from('Private local demonstration guide.\n'),{mode:0o600});
  const imported=JSON.parse(execFileSync(process.execPath,['scripts/operator-local.mjs','import',base+'/assets','demo-guide.txt','demo-guide.txt','text/plain'],{env:process.env,encoding:'utf8'}));
  const browserHome=base+'/local-browser-home';await mkdir(browserHome+'/.pki/nssdb',{recursive:true});execFileSync('certutil',['-N','--empty-password','-d','sql:'+browserHome+'/.pki/nssdb']);execFileSync('certutil',['-A','-d','sql:'+browserHome+'/.pki/nssdb','-n','Dispatch disposable CA','-t','C,,','-i',base+'/tls.crt']);
  browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:!process.argv.includes('--headed'),args:['--no-sandbox'],env:{...process.env,HOME:browserHome}});
  const login=await browser.newContext({});const entry=await login.newPage();await entry.goto(origin+'/operator');await entry.getByLabel('Operator password',{exact:true}).fill(password);await entry.getByRole('button',{name:'Sign in',exact:true}).click();await entry.getByRole('heading',{name:'Set up merchant details'}).waitFor();
  // Generated login state remains in the disposable browser context.
  context=await browser.newContext({storageState:await login.storageState(),viewport:{width:1440,height:1000}});await login.close();
  console.log(`READY: local synthetic demo. Operator: ${origin}/operator; automated browser walkthrough.`);
  const page=await context.newPage();page.setDefaultTimeout(10000);await page.goto(origin+'/operator');await page.getByRole('heading',{name:'Set up merchant details'}).waitFor();
  await page.getByLabel('Merchant name',{exact:true}).fill('Local Demo Studio');await page.getByLabel('Receiving wallet on Base',{exact:true}).fill(payee);await page.getByLabel('Type the exact receiving wallet to confirm').fill(payee);await page.getByLabel('Policy version',{exact:true}).fill('policy-1');await page.getByLabel('Public versioned policy URL').fill('https://fixture.invalid/policy/1');await page.getByRole('button',{name:'Confirm and save settings'}).click();await page.getByRole('heading',{name:'Merchant settings',exact:true}).waitFor();
  await page.getByRole('button',{name:'Products',exact:true}).click();await page.getByLabel('Product title').fill('The local demonstration guide');await page.getByLabel('Description',{exact:true}).fill('One private digital file, delivered after independently checked local payment.');await page.getByLabel('Imported private asset').selectOption(imported.asset_manifest_id);await page.getByLabel('Price in integer USDC units').fill('100');await page.getByLabel('Explicit tax treatment').selectOption('merchant_attested_zero');await page.getByLabel('Tax policy source').fill('local-demo-fixture');await page.getByLabel('Tax policy version').fill('1');
  const response=page.waitForResponse(r=>r.url().endsWith('/v1/operator/products')&&r.request().method()==='POST');await page.getByRole('button',{name:'Publish first version'}).click();assert.equal((await response).status(),201);await page.getByRole('button',{name:'Copy purchase link'}).waitFor();
  assert.equal((await admin.query('SELECT count(*) n FROM products')).rows[0].n,'1');assert.equal((await admin.query('SELECT count(*) n FROM orders')).rows[0].n,'0');
  const controls=(await admin.query('SELECT payment_paused, mainnet_enabled FROM merchant_control')).rows[0];assert.equal(controls.payment_paused,true);assert.equal(controls.mainnet_enabled,false);
  await operationsTick(worker.pool,refundRpc,new Map());
  await page.getByRole('button',{name:'Settings & pauses',exact:true}).click();await page.getByRole('button',{name:'Resume payments',exact:true}).click();await page.getByRole('button',{name:'Pause payments',exact:true}).waitFor();
  
  const productForBuyer=(await admin.query('SELECT product_id FROM products')).rows[0].product_id;
  console.log('PURCHASE LINK: '+origin+'/buy/'+productForBuyer);
  await page.getByRole('button',{name:'Products',exact:true}).click();await page.getByRole('button',{name:'Copy purchase link'}).waitFor();
  keepContext(context);context=undefined;
  const account=await localFixtureSigner(await newSigner(),request);
  context=await browser.newContext({viewport:{width:1440,height:1100}});const buyer=await context.newPage();buyer.setDefaultTimeout(15000);
  buyer.on('request',r=>{if(r.headers()['payment-signature'])humanSignedPosts++;});
  await buyer.exposeFunction('__sign',async data=>{humanSigns++;return account.signTypedData(JSON.parse(data));});await buyer.exposeFunction('__rpc',(m,p)=>request(m,p));
  await buyer.addInitScript(address=>{const provider={on(){},removeListener(){},async request({method,params}){if(['eth_accounts','eth_requestAccounts'].includes(method))return[address];if(method==='eth_chainId')return'0x2105';if(method==='eth_signTypedData_v4')return window.__sign(params[1]);if(method==='eth_call')return window.__rpc(method,params);throw Error('unsupported');}};window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'11111111-1111-4111-8111-111111111111',name:'Generated local wallet',icon:'data:image/svg+xml,<svg/>',rdns:'fixture.invalid'},provider}})));},account.address);
  await buyer.goto(origin+'/buy/'+productForBuyer);await buyer.getByRole('button',{name:'Begin checkout',exact:true}).click();await buyer.getByRole('checkbox').check();await buyer.getByRole('button',{name:'Review exact quote',exact:true}).click();await buyer.getByRole('button',{name:'Connect a wallet',exact:true}).click();await buyer.getByRole('button',{name:'Connect Generated local wallet',exact:true}).click();
  const authorized=buyer.waitForResponse(r=>r.url().endsWith('/pay')&&r.request().method()==='POST'&&Boolean(r.request().headers()['payment-signature']));await buyer.getByRole('button',{name:/^Authorize /}).click();await authorized;
  assert.equal(humanSigns,1);assert.equal(humanSignedPosts,1);const humanOrder=(await admin.query('SELECT id FROM orders')).rows[0].id;await settle(humanOrder);await deliveryTick(new DeliveryStore(worker.pool),new Map());
  await buyer.getByRole('link',{name:'Download file',exact:true}).waitFor({timeout:45000});const downloaded=await Promise.all([buyer.waitForEvent('download'),buyer.getByRole('link',{name:'Download file',exact:true}).click()]);const actual=await readFile(await downloaded[0].path());await downloaded[0].saveAs(out+'/demo-guide.txt');assert.deepEqual(actual,expected);assert.equal((await fetch(origin+'/v1/orders/'+humanOrder+'/download')).status,401);await buyer.reload();await buyer.getByRole('link',{name:'Download file',exact:true}).waitFor();assert.equal(humanSigns,1);keepContext(context);context=undefined;
  console.log('HUMAN: independently verified local settlement; 35 matching private bytes downloaded; authorizations=1; reload recovered access.');
  const purchasePolicy={origin,productId:productForBuyer,productVersion:1,maxAtomic:'100',payees:[payee],network:'eip155:8453',token,policyVersion:'policy-1',policyURLs:['https://fixture.invalid/policy/1']};
  await operationsTick(worker.pool,refundRpc,new Map());await support();const directory=base+'/local-agent',journal=await createPurchase(purchasePolicy,directory),saved=await journal.read(),agentAccount=await localFixtureSigner(await newSigner(),request);let dropped=false;
  const transport=async(input,init)=>{const signed=new Headers(init?.headers??(input instanceof Request?input.headers:undefined)).has('PAYMENT-SIGNATURE');if(signed)signedPosts++;const r=await fetch(input,init);if(signed&&!dropped){dropped=true;throw Error('generated_lost_response');}return r;};
  await assert.rejects(authorizePurchase(directory,purchasePolicy,{address:agentAccount.address,signTypedData:async x=>{agentSigns++;return agentAccount.signTypedData(x);}},transport));assert.equal(dropped,true);assert.equal(agentSigns,1);await settle(saved.order);await deliveryTick(new DeliveryStore(worker.pool),new Map());const agentTransaction=(await import('../tests/operator/fixtures.mjs')).publicEvidence.at(-1).transaction;
  console.log('AGENT: maintained @x402 client; separate order '+saved.order+'; transaction '+agentTransaction);
  console.log('AGENT: independently verified local settlement; signed response deliberately lost; authorizations=1; signed submissions=1. Delivery retrieval awaits recovery.');
  const recoveryTransport=async(input,init)=>{assert.equal(new Headers(init?.headers??(input instanceof Request?input.headers:undefined)).has('PAYMENT-SIGNATURE'),false);return fetch(input,init);};
  assert.equal((await resumePurchase(directory,recoveryTransport)).payment_state,'settled');assert.deepEqual(await retrievePurchase(directory,recoveryTransport),expected);assert.equal(agentSigns,1);assert.equal(signedPosts,1);
  console.log('RECOVERY: same agent order; settled; 35 matching private bytes; authorizations=1; signed submissions=1; no second payment.');
  const chainEvidence=(await import('../tests/operator/fixtures.mjs')).publicEvidence;assert.equal(chainEvidence.length,2);assert.equal(new Set(chainEvidence.map(x=>x.transaction)).size,2);assert.equal(chainEvidence.every(x=>x.settleCalls===1),true);assert.equal((await admin.query('SELECT count(*) n FROM orders')).rows[0].n,'2');assert.equal(humanSignedPosts,1);
  const fixtures=await import('../tests/operator/fixtures.mjs');await new Promise(resolve=>{fixtures.server.close(resolve);fixtures.server.closeAllConnections();});await assert.rejects(fetch(origin+'/operator'));console.log('INDEPENDENCE: Dispatch API stopped; ordinary merchant site remains separate.');
  await assert.rejects(fetch('https://127.0.0.1:19999'));
  const product=(await admin.query('SELECT product_id FROM products')).rows[0].product_id;site=merchantSite({port:18446,dispatchOrigin:origin,product});await once(site,'listening');
  context=await browser.newContext({viewport:{width:1440,height:1000}});const ordinary=await context.newPage();await ordinary.goto('http://127.0.0.1:18446');await ordinary.getByLabel('Name for your order').fill('Local demo buyer');await ordinary.getByRole('button',{name:'Continue ordinary checkout'}).click();await ordinary.waitForURL('**/ordinary-checkout');assert.match(await ordinary.textContent('body'),/Ordinary checkout accepted/);keepContext(context);context=undefined;
   await (await import('../tests/operator/fixtures.mjs')).bootApi();
   const refreshed=buyer.waitForResponse(r=>r.url().endsWith('/v1/checkouts/'+humanOrder)&&r.request().method()==='GET');await buyer.getByRole('button',{name:'Check payment status',exact:true}).click();assert.equal((await refreshed).status(),200);await buyer.getByRole('link',{name:'Download file',exact:true}).waitFor();assert.equal(humanSigns,1);assert.equal(humanSignedPosts,1);
   console.log('INDEPENDENCE: ordinary merchant checkout accepted with Dispatch link unavailable. Local form only; no card payment.');
   await writeFile(out+'/native-result.json',JSON.stringify({status:'passed',orders:2,human_authorizations:humanSigns,human_signed_submissions:humanSignedPosts,agent_authorizations:agentSigns,agent_signed_submissions:signedPosts,private_bytes_equal:true,private_bytes_sha256:createHash('sha256').update(expected).digest('hex'),unauthenticated_download_denied:true,human_reload_recovery:true,agent_lost_response_recovery:true,ordinary_checkout_during_api_outage:true,api_restart_recovered:true,transactions:chainEvidence.map(x=>x.transaction),local_evm:true,mainnet_enabled:false,named_wallet_tested:false},null,2)+'\n');
   console.log('COMPLETE: two real local purchases, exact private delivery, recovery without another authorization, and independent ordinary checkout.');
 }finally{
  try{
   await context?.close();
   for(const saved of contexts)await saved.close();
  }finally{
   try{await browser?.close();}
   finally{try{if(site)await new Promise(resolve=>site.close(resolve));}finally{await teardown();}}
  }
 }
});
