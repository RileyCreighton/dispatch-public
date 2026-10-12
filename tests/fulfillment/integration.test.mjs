import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,symlink,unlink,rename,link} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:https';
import {Pool} from 'pg';
import {pageWithWallets,beginPage,connectPage} from './human.mjs';
import {chromium} from 'playwright';
import {importPrivateAsset} from '../../dist/packages/db/src/private-assets.js';
import {assetMetadata} from '../../dist/packages/fulfillment/src/files.js';
import {apiServer} from '../../dist/apps/api/src/app.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {PrivateFiles,manifestDigest,byteRange} from '../../dist/packages/fulfillment/src/files.js';
import {WebhookTransport,publicAddress} from '../../dist/packages/fulfillment/src/transport.js';
import {signBody,verifyBody,paidEvent} from '../../dist/packages/fulfillment/src/webhook.js';
import {MerchantReceiver,merchantServer} from '../../dist/examples/merchant-adapter/src/server.js';
import {merchantSite} from '../../dist/examples/merchant-site/src/server.js';
import {createPurchase,authorizePurchase,resumePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {digest} from '../../dist/packages/db/src/commerce.js';
import {setup,teardown,admin,api,worker,pools,fixture,policy,newSigner,settle,origin,httpCall,server,restartApi,support,commerce} from './fixtures.mjs';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE;
const store=new DeliveryStore(worker.pool,new Map([['reference',digest('https://127.0.0.1:18444/dispatch/v1/events')]])),access=new DeliveryStore(api);
const assets=new PrivateFiles(base+'/assets'),children=new Set();let receiverPool,receiver,receiverServer,target,key,bearer,cert,browser;
let purchased,second;const screenshots=[],contracts=[];
async function child(mode,arg){const p=fork('tests/fulfillment/process.mjs',[mode,...(arg?[arg]:[])],{env:process.env,stdio:['ignore','pipe','pipe','ipc']});children.add(p);let errors='';p.stderr.on('data',c=>errors+=c);p.stdout.resume();
 if(mode!=='worker'||arg){await Promise.race([once(p,'message'),once(p,'exit').then(()=>{throw new Error('child exited: '+errors);})]);return p;}
 const [code]=await once(p,'exit');children.delete(p);assert.equal(code,0,errors);return p;}
async function stop(p){p.kill('SIGKILL');await once(p,'exit');children.delete(p);}
async function paid(approved=policy()){const directory=base+'/agent-'+randomUUID(),journal=await createPurchase(approved,directory),saved=await journal.read();await authorizePurchase(directory,approved,await newSigner());await settle(saved.order);return {directory,...saved};}
async function entitlement(order){const j=(await admin.query("SELECT id FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[order])).rows[0];const lease=await store.claim(j.id);assert.ok(lease);await store.entitlement(lease);return j.id;}
async function readyJob(order,type='merchant_paid'){const j=(await admin.query('SELECT id FROM outbox_jobs WHERE order_id=$1 AND effect_type=$2',[order,type])).rows[0];await admin.query("UPDATE outbox_jobs SET available_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);return j.id;}
function auth(p=purchased){return {Authorization:'Bearer '+p.credential};}
async function count(table,where='',args=[]){return Number((await admin.query(`SELECT count(*) n FROM ${table} ${where}`,args)).rows[0].n);}
async function assetRow(id=fixture.asset){return (await admin.query('SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM asset_versions WHERE id=$1',[id])).rows[0];}
function event(){return {type:'dispatch.order.paid.v1',event_id:randomUUID(),effect_id:'effect:'+randomUUID(),occurred_at:new Date().toISOString(),merchant_id:'single',merchant_order_id:'order-'+randomUUID(),dispatch_order_id:randomUUID(),quote_id:randomUUID(),product_version:1,amount_atomic:'100',asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',network:'eip155:8453',payment_reference:{transaction_hash:'0x'+'ab'.repeat(32),authorization_log_index:0,transfer_log_index:1,observation_policy:'safe'}};}
async function post(raw,stamp=String(Math.floor(Date.now()/1000)),signature=signBody(raw,stamp,key),keyId='fixture-v1'){
 return fetch('https://127.0.0.1:18444/dispatch/v1/events',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Dispatch-Timestamp':stamp,'Dispatch-Key-Id':keyId,'Dispatch-Signature':signature},body:raw});}
test.before(async()=>{
 await setup();key=randomBytes(32);bearer=randomBytes(32).toString('base64url');cert=await readFile(base+'/tls.crt','utf8');
 await writeFile(base+'/webhook.key',key,{mode:0o600});await writeFile(base+'/adapter.bearer',bearer,{mode:0o600});
 await admin.query(await readFile('examples/merchant-adapter/schema.sql','utf8'));
 await admin.query('CREATE ROLE fixture_receiver LOGIN; GRANT USAGE ON SCHEMA merchant_adapter TO fixture_receiver; GRANT SELECT,INSERT ON merchant_adapter.orders TO fixture_receiver');
 receiverPool=new Pool({host:base,port:55442,user:'fixture_receiver',database:'dispatch'});receiver=new MerchantReceiver(receiverPool);
 receiverServer=merchantServer(receiver,{origin:'https://127.0.0.1:18444',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});receiverServer.listen(18444,'127.0.0.1');await once(receiverServer,'listening');
 target=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18444/dispatch/v1/events',keyId:'fixture-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
 browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});
});
test.beforeEach(async()=>{await admin.query('TRUNCATE abuse_counters');await support();});
test.after(async()=>{for(const p of children)await stop(p);await browser?.close();if(receiverServer)await new Promise(r=>receiverServer.close(r));await receiverPool?.end();await writeFile(out+'/contracts.json',JSON.stringify(contracts,null,2)+'\n');await writeFile(out+'/screenshots.json',JSON.stringify(screenshots,null,2)+'\n');await teardown();});
test('B5-01 unpaid, other buyer and public payment credentials disclose no bytes',async()=>{
 const dir=base+'/unpaid',j=await createPurchase(policy(),dir),p=await j.read();
 for(const headers of [{},auth(p),{Authorization:'Bearer '+'a'.repeat(43)},{Authorization:'Bearer 0x'+'ab'.repeat(32)}]){const r=await httpCall('/v1/orders/'+p.order+'/download',{headers});assert.notEqual(r.status,200);assert.doesNotMatch(await r.text(),/Private purchased fixture bytes/);}
 assert.equal(await count('entitlements'),0);
});
test('B5-02 genuine upstream agent payment, durable entitlement worker and exact private bytes',async()=>{
 purchased=await paid();assert.equal((await resumePurchase(purchased.directory)).delivery.state,'queued');
 await child('worker');const s=await resumePurchase(purchased.directory);assert.equal(s.delivery.state,'available');assert.equal(s.delivery.download_path,'/v1/orders/'+purchased.order+'/download');
 contracts.push({schema:'CheckoutStatus',raw:await (await httpCall('/v1/checkouts/'+purchased.order,{headers:auth()})).text()});
 const bytes=await retrievePurchase(purchased.directory);assert.deepEqual(bytes,await readFile(base+'/assets/guide.json'));assert.equal(digest(bytes),s.delivery.sha256);
 assert.equal(await count('entitlements','WHERE order_id=$1',[purchased.order]),1);
 assert.equal(await count('settlements','WHERE order_id=$1',[purchased.order]),1);
});
test('B5-03 second buyer, public IDs/signatures, unsupported methods and every HEAD/range/conditional path deny access',async()=>{
 const j=await createPurchase(policy(),base+'/other'),other=await j.read();const path='/v1/orders/'+purchased.order+'/download';
 for(const method of ['GET','HEAD'])for(const headers of [{},{...auth(other),Range:'bytes=0-2'},{Authorization:'Bearer '+'0'.repeat(43),'If-None-Match':'*'}]){
  const r=await httpCall(path,{method,headers});assert.equal(r.status,401);assert.doesNotMatch(await r.text(),/Private purchased fixture bytes/);
 }
 assert.equal((await httpCall(path,{method:'POST',body:{},headers:auth()})).status,405);
 for(const path of ['/v1/orders/'+purchased.order+'/download/../guide.json','/assets/guide.json','/v1/orders/%2e%2e/download'])assert.notEqual((await httpCall(path,{headers:auth()})).status,200);
});
test('B5-04 HEAD, single ranges, invalid ranges and conditional headers reauthorize with safe attachment/cache headers',async()=>{
 const path='/v1/orders/'+purchased.order+'/download',bytes=await readFile(base+'/assets/guide.json');
 for(const method of ['GET','HEAD'])for(const range of [undefined,'bytes=0-4','bytes=-5','bytes=5-']){
  const r=await httpCall(path,{method,headers:{...auth(),...(range?{Range:range}:{}),'If-None-Match':'*','If-Modified-Since':new Date(Date.now()+100000).toUTCString()}});
  assert.equal(r.status,range?206:200);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-disposition'),/^attachment/);assert.match(r.headers.get('vary'),/Authorization/);
  const got=Buffer.from(await r.arrayBuffer()),ranged=byteRange(range,bytes.length);assert.deepEqual(got,method==='HEAD'?Buffer.alloc(0):ranged?bytes.subarray(ranged.start,ranged.end+1):bytes);
 }
 for(const range of ['bytes=999-','bytes=1-0','bytes=0-1,3-4','items=0-1','bytes=-0','bytes=9007199254740992-'])assert.equal((await httpCall(path,{headers:{...auth(),Range:range}})).status,416);
});
test('B5-05 manifest refuses traversal, symlink, hardlink and changed/in-place bytes; verified buffer survives later replacement',async()=>{
 const row=await assetRow(),original=await readFile(base+'/assets/guide.json');
 const altered={...row,private_relative_path:'../tls.key'};altered.manifest_sha256=manifestDigest((({manifest_sha256,...r})=>r)(altered));await assert.rejects(assets.read(altered));
 await rename(base+'/assets/guide.json',base+'/assets/retained');await symlink(base+'/assets/retained',base+'/assets/guide.json');await assert.rejects(assets.read(row));await unlink(base+'/assets/guide.json');await rename(base+'/assets/retained',base+'/assets/guide.json');
 await link(base+'/assets/guide.json',base+'/assets/hardlink');await assert.rejects(assets.read(row));await unlink(base+'/assets/hardlink');
 const verified=await assets.read(row);await writeFile(base+'/assets/guide.json',Buffer.alloc(original.length,120));await assert.rejects(assets.read(row));assert.deepEqual(verified,original);
 assert.equal((await httpCall('/v1/orders/'+purchased.order+'/download',{headers:auth()})).status,409);await writeFile(base+'/assets/guide.json',original);
 const raceRoot=base+'/race-assets';await mkdir(raceRoot);await writeFile(raceRoot+'/guide.json',original);const raced=new PrivateFiles(raceRoot);
 const replacing=(async()=>{for(let i=0;i<20;i++){await writeFile(raceRoot+'/replacement',i%2?original:Buffer.alloc(original.length,120));await rename(raceRoot+'/replacement',raceRoot+'/guide.json');}})();
 for(let i=0;i<20;i++){try{assert.deepEqual(await raced.read(row),original);}catch(error){assert.ok(['asset_changed','ENOENT'].includes(error.message)||error.code==='ENOENT');}}
 await replacing;
 const active={id:randomUUID(),private_relative_path:'active.svg',file_sha256:digest('<svg/>'),mime_type:'image/svg+xml',download_name:'active.svg',size_bytes:6};await writeFile(base+'/assets/active.svg','<svg/>');active.manifest_sha256=manifestDigest(active);
 assert.deepEqual(await assets.read(active),Buffer.from('<svg/>'));assert.equal(assetMetadata(active).mime_type,'application/octet-stream');
});
test('B5-06 catalog version updates preserve purchased asset; response loss/restart recovers same entitlement',async()=>{
 await writeFile(base+'/assets/guide-v2.json','{"edition":2}');const v2=await importPrivateAsset(admin,base+'/assets','guide-v2.json','guide-v2.json','application/json');
 await admin.query(`INSERT INTO products(product_id,version,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version)
  SELECT product_id,2,'New catalog edition','Changed title',kind,$2,unit_amount,tax_status,tax_source,tax_version,policy_version FROM products WHERE product_id=$1 AND version=1`,[fixture.product,v2.id]);
 await admin.query('UPDATE product_publication SET version=2 WHERE product_id=$1',[fixture.product]);
 const r=await httpCall('/v1/orders/'+purchased.order+'/download',{headers:auth()});await r.body.cancel();await restartApi();
 assert.deepEqual(await retrievePurchase(purchased.directory),await readFile(base+'/assets/guide.json'));assert.equal((await resumePurchase(purchased.directory)).product.version,1);
 await admin.query('UPDATE product_publication SET version=1 WHERE product_id=$1',[fixture.product]);
});
test('B5-07 fulfillment pause, grant revocation/expiry deny access; payment pause preserves paid access',async()=>{
 await admin.query('UPDATE merchant_control SET payment_paused=true');assert.ok((await retrievePurchase(purchased.directory)).length);
 await admin.query('UPDATE merchant_control SET fulfillment_paused=true');await assert.rejects(retrievePurchase(purchased.directory));assert.equal((await resumePurchase(purchased.directory)).delivery.state,'blocked');
 await admin.query('UPDATE merchant_control SET payment_paused=false,fulfillment_paused=false');
 await admin.query('UPDATE buyer_sessions SET revoked_at=clock_timestamp() WHERE capability_hash=$1',[digest(purchased.credential)]);await assert.rejects(access.authorize(purchased.order,purchased.credential));
 await admin.query('UPDATE buyer_sessions SET revoked_at=NULL WHERE capability_hash=$1',[digest(purchased.credential)]);
});
test('B5-08 queued job is not authorization; pause between claim and entitlement prevents effect, concurrent takeover fences old worker',async()=>{
 second=await paid();const job=await readyJob(second.order,'entitlement'),old=await store.claim(job);await admin.query('UPDATE merchant_control SET fulfillment_paused=true');
 await assert.rejects(store.entitlement(old),/delivery_blocked/);assert.equal(await count('entitlements','WHERE order_id=$1',[second.order]),0);
 await admin.query('UPDATE merchant_control SET fulfillment_paused=false');await readyJob(second.order,'entitlement');const current=await store.claim(job);
 await assert.rejects(store.entitlement(old),/stale_delivery/);await store.entitlement(current);assert.equal(await count('entitlements','WHERE order_id=$1',[second.order]),1);
});
test('B5-09 actual worker killed after durable claim, restart and concurrent processes retain one merchant effect',async()=>{
 await readyJob(second.order);const p=await child('worker','claim-crash');await stop(p);await readyJob(second.order);
 await Promise.all([child('worker'),child('worker')]);
 assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[second.order]),1);
 assert.equal(await count('merchant_receipts','WHERE event_id IN (SELECT event_id FROM merchant_events WHERE order_id=$1)',[second.order]),1);
});
test('B5-10 exact raw body HMAC, key selection, stale timestamp, tamper and conflicting immutable duplicate',async()=>{
 const e=event(),raw=Buffer.from(JSON.stringify(e)),stamp=String(Math.floor(Date.now()/1000));
 const r=await post(raw,stamp);assert.equal(r.status,200);const responseRaw=await r.text();contracts.push({schema:'OperationReceipt',raw:responseRaw},{schema:'PaidEvent',raw:raw.toString()});const receipt=JSON.parse(responseRaw);assert.equal(receipt.state,'committed');
 assert.equal((await post(Buffer.concat([raw,Buffer.from(' ')]),stamp,signBody(raw,stamp,key))).status,401);
 assert.equal((await post(raw,String(Number(stamp)-301))).status,401);assert.equal((await post(raw,stamp,signBody(raw,stamp,key),'missing')).status,401);
 const conflict=Buffer.from(JSON.stringify({...e,amount_atomic:'101'}));assert.equal((await post(conflict)).status,409);assert.equal((await post(Buffer.from(JSON.stringify({...e,event_id:randomUUID()})))).status,409);
 const duplicates=await Promise.all(Array.from({length:8},()=>post(raw)));for(const d of duplicates)assert.equal(d.status,200);
 assert.equal(await count('merchant_adapter.orders','WHERE event_id=$1',[e.event_id]),1);assert.deepEqual(await receiver.status(e.event_id),receipt);
});
test('B5-11 receiver commits then loses response; durable status across receiver restart recovers same receipt',async()=>{
 const e=event(),raw=Buffer.from(JSON.stringify(e));await new Promise(r=>receiverServer.close(r));receiverServer=undefined;
 const dropped=createServer({key:await readFile(base+'/tls.key'),cert},async(req,res)=>{const chunks=[];for await(const x of req)chunks.push(x);const parsed=verifyBody(Buffer.concat(chunks),req.headers,new Map([['fixture-v1',key]]));await receiver.record(parsed);res.destroy();});
 dropped.listen(18444,'127.0.0.1');await once(dropped,'listening');await assert.rejects(target.send(raw,String(Math.floor(Date.now()/1000))));await new Promise(r=>dropped.close(r));
 const p=await child('receiver');const result=await target.status(e.event_id);assert.equal(result.receipt.state,'committed');assert.equal(await count('merchant_adapter.orders','WHERE event_id=$1',[e.event_id]),1);
 const again=await target.send(raw,String(Math.floor(Date.now()/1000)));assert.deepEqual(again.receipt,result.receipt);await stop(p);
 receiverServer=merchantServer(receiver,{origin:'https://127.0.0.1:18444',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});receiverServer.listen(18444,'127.0.0.1');await once(receiverServer,'listening');
});
test('B5-12 forbidden IPv4/IPv6, mixed DNS and redirects never reach an alternate target',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','0.0.0.0','224.1.2.3','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 for(const answers of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'::1',family:6}]]){
  const blocked=new WebhookTransport({id:'reference',url:'https://receiver.example/dispatch/v1/events',keyId:'fixture-v1',key,bearer},async()=>answers);
  await assert.rejects(blocked.send(Buffer.from(JSON.stringify(event())),String(Math.floor(Date.now()/1000))),/forbidden_destination/);
 }
 const redirect=createServer({key:await readFile(base+'/tls.key'),cert},(_q,r)=>r.writeHead(307,{Location:'https://169.254.169.254/'}).end());redirect.listen(18445,'127.0.0.1');await once(redirect,'listening');
 const t=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18445/dispatch/v1/events',keyId:'fixture-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
 await assert.rejects(t.send(Buffer.from(JSON.stringify(event())),String(Math.floor(Date.now()/1000))),/redirect_denied/);await new Promise(r=>redirect.close(r));
});
test('B5-22 API process death and fresh process recover original grant/entitlement without repurchase',async()=>{
 await new Promise(r=>server.close(r));const process=await child('api');
 assert.deepEqual(await retrievePurchase(purchased.directory),await readFile(base+'/assets/guide.json'));await stop(process);await restartApi();
 assert.equal(await count('entitlements','WHERE order_id=$1',[purchased.order]),1);assert.equal(await count('payment_attempts','WHERE order_id=$1',[purchased.order]),1);
});
test('B5-23 pause after file read and session expiry during order lock wait disclose no private bytes',async()=>{
 await new Promise(r=>server.close(r));let opened,release;const readDone=new Promise(r=>opened=r),resume=new Promise(r=>release=r);
 class PausingFiles extends PrivateFiles {async read(a){const bytes=await super.read(a);opened();await resume;return bytes;}}
 const gated=apiServer(api,origin,()=>{},commerce,{tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)},files:new PausingFiles(base+'/assets')});gated.listen(18443,'127.0.0.1');await once(gated,'listening');
 const request=httpCall('/v1/orders/'+purchased.order+'/download',{headers:auth()});await readDone;await admin.query('UPDATE merchant_control SET fulfillment_paused=true');release();
 const response=await request;assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/Private purchased fixture bytes/);await new Promise(r=>gated.close(r));await admin.query('UPDATE merchant_control SET fulfillment_paused=false');await restartApi();
 const blocker=await admin.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE',[purchased.order]);
 await admin.query("UPDATE buyer_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE capability_hash=$1",[digest(purchased.credential)]);
 const pending=access.authorize(purchased.order,purchased.credential);let blocked=false;for(let i=0;i<100;i++){blocked=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='local_api' AND cardinality(pg_blocking_pids(pid))>0) yes")).rows[0].yes;if(blocked)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(blocked,true);await new Promise(r=>setTimeout(r,350));await blocker.query('COMMIT');blocker.release();await assert.rejects(pending,/unauthorized/);
 await admin.query("UPDATE buyer_sessions SET expires_at=clock_timestamp()+interval '30 days' WHERE capability_hash=$1",[digest(purchased.credential)]);
});
test('B5-13 human recovery session retrieves same private bytes and responsive delivery states',async()=>{
 const exported=await commerce.buyers.export(purchased.order,purchased.credential,randomUUID());const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();
 const response=await context.request.post(origin+'/v1/recovery/import',{headers:{Origin:origin,'X-Dispatch-Intent':'recovery'},data:{capability:exported.capability}});assert.equal(response.status(),200);
 await page.goto(origin+'/checkout/'+purchased.order);await page.getByRole('link',{name:'Download file',exact:true}).waitFor();
 for(const state of ['available','blocked','revoked']){
  if(state==='blocked')await admin.query('UPDATE merchant_control SET fulfillment_paused=true');
  if(state==='revoked'){await admin.query('UPDATE merchant_control SET fulfillment_paused=false');await admin.query("UPDATE entitlements SET state='revoked',revoked_at=clock_timestamp() WHERE order_id=$1",[purchased.order]);}
  await page.getByRole('button',{name:'Check payment status',exact:true}).click();await page.getByText('File delivery: '+state,{exact:true}).waitFor();
  for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});const name=`delivery-${state}-${width}.png`;await page.screenshot({path:out+'/'+name,fullPage:true});screenshots.push(name);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  if(state==='available'){const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download file',exact:true}).click()]);assert.deepEqual(await readFile(await download.path()),await readFile(base+'/assets/guide.json'));}
 }
 await assert.rejects(access.authorize(purchased.order,purchased.credential));await context.close();
});
test('B5-14 ordinary merchant checkout identical absent/present/unavailable, browser required validation and form submit',async()=>{
 let baseline;for(const mode of ['absent','present','unavailable']){
  const site=merchantSite({port:18446,...(mode==='absent'?{}:{dispatchOrigin:mode==='present'?origin:'https://127.0.0.1:19999',product:fixture.product})});await once(site,'listening');
  const page=await browser.newPage();await page.goto('http://127.0.0.1:18446');const form=await page.locator('form').evaluate(e=>e.outerHTML);if(!baseline)baseline=form;else assert.equal(form,baseline);
  await page.getByRole('button',{name:'Continue ordinary checkout'}).click();assert.equal(page.url(),'http://127.0.0.1:18446/');assert.equal(await page.locator('input').evaluate(e=>e.validity.valueMissing),true);
  for(const width of [360,768,1440]){await page.setViewportSize({width,height:1000});const name=`merchant-${mode}-${width}.png`;await page.screenshot({path:out+'/'+name,fullPage:true});screenshots.push(name);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.getByLabel('Name for your order').fill('Local Buyer');await page.getByRole('button',{name:'Continue ordinary checkout'}).click();await page.waitForURL('**/ordinary-checkout');assert.match(await page.textContent('body'),/Ordinary checkout accepted/);
  await page.close();await new Promise(r=>site.close(r));
 }
});
test('B5-16 fresh human browser payment followed by available private file and one signed handoff',async()=>{
 const f=await pageWithWallets(browser),order=await beginPage(f.page);await connectPage(f.page);await f.page.getByRole('button',{name:/^Authorize /}).click();
 await f.page.getByRole('heading',{name:'Checking your payment',exact:true}).waitFor();assert.equal(f.signs(),1);await settle(order);
 await f.page.getByRole('button',{name:'Check payment status',exact:true}).click();await f.page.getByText('File delivery: pending',{exact:true}).waitFor();
 for(const width of [360,768,1440]){await f.page.setViewportSize({width,height:1000});const name=`delivery-pending-${width}.png`;await f.page.screenshot({path:out+'/'+name,fullPage:true});screenshots.push(name);}
 await child('worker');await child('worker');await f.page.getByRole('button',{name:'Check payment status',exact:true}).click();await f.page.getByRole('link',{name:'Download file',exact:true}).waitFor();
 const [download]=await Promise.all([f.page.waitForEvent('download'),f.page.getByRole('link',{name:'Download file',exact:true}).click()]);assert.deepEqual(await readFile(await download.path()),await readFile(base+'/assets/guide.json'));
 assert.equal(await count('entitlements','WHERE order_id=$1',[order]),1);assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[order]),1);assert.equal(f.signs(),1);await f.context.close();
});
test('B5-17 sender lost ACK persists unknown then same-event status recovers, fresh timestamp on real redelivery',async()=>{
 const p=await paid();await entitlement(p.order);const job=await readyJob(p.order),lease=await store.claim(job);await assert.rejects(store.beginWebhook(lease,target.keyId,digest('https://other.invalid/dispatch/v1/events')),/invalid_effect/);const attempt=await store.beginWebhook(lease,target.keyId,target.binding);
 await new Promise(r=>receiverServer.close(r));receiverServer=undefined;
 const dropped=createServer({key:await readFile(base+'/tls.key'),cert},async(req,res)=>{const chunks=[];for await(const x of req)chunks.push(x);await receiver.record(verifyBody(Buffer.concat(chunks),req.headers,new Map([['fixture-v1',key]])));res.destroy();});
 dropped.listen(18444,'127.0.0.1');await once(dropped,'listening');await assert.rejects(target.send(attempt.body,attempt.timestamp));await store.finishWebhook(lease,attempt.id,undefined,null);await new Promise(r=>dropped.close(r));
 assert.equal((await admin.query('SELECT state FROM outbox_jobs WHERE id=$1',[job])).rows[0].state,'retry');assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[p.order]),1);
 const process=await child('receiver');await readyJob(p.order);await child('worker');assert.equal((await admin.query('SELECT state FROM outbox_jobs WHERE id=$1',[job])).rows[0].state,'done');
 assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[p.order]),1);assert.equal((await resumePurchase(p.directory)).merchant_handoff.state,'recorded');await stop(process);
 receiverServer=merchantServer(receiver,{origin:'https://127.0.0.1:18444',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});receiverServer.listen(18444,'127.0.0.1');await once(receiverServer,'listening');
 const later=String(Number(attempt.timestamp)+1);assert.notEqual(signBody(attempt.body,later,key),signBody(attempt.body,attempt.timestamp,key));assert.equal((await target.send(attempt.body,later)).receipt.state,'committed');
});
test('B5-18 actual DB lock wait crossing webhook authorization lease expiry rolls back attempt',async()=>{
 const p=await paid();await entitlement(p.order);const job=await readyJob(p.order),lease=await store.claim(job);
 await admin.query("UPDATE outbox_jobs SET lease_until=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[job]);
 const blocker=await admin.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE webhook_attempts IN ACCESS EXCLUSIVE MODE');
 const pending=store.beginWebhook(lease,target.keyId,target.binding);let blocked=false;
 for(let i=0;i<100;i++){blocked=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE 'INSERT INTO dispatch.webhook_attempts%' AND cardinality(pg_blocking_pids(pid))>0) yes")).rows[0].yes;if(blocked)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(blocked,true);await new Promise(r=>setTimeout(r,350));await blocker.query('COMMIT');blocker.release();
 await assert.rejects(pending,/stale_delivery/);assert.equal(await count('webhook_attempts','WHERE job_id=$1',[job]),0);
 await readyJob(p.order);await child('worker');assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[p.order]),1);
});
test('B5-19 revoked entitlement fences webhook begin even when order projection is unchanged; eight expired attempts dead-letter',async()=>{
 const p=await paid();await entitlement(p.order);const job=await readyJob(p.order),lease=await store.claim(job);
 await admin.query("UPDATE entitlements SET state='revoked',revoked_at=clock_timestamp() WHERE order_id=$1",[p.order]);await assert.rejects(store.beginWebhook(lease,target.keyId,target.binding),/delivery_blocked/);
 assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[p.order]),0);
 await admin.query("UPDATE outbox_jobs SET attempts=8,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);
 assert.equal(await store.claim(job),undefined);assert.equal((await admin.query('SELECT state FROM outbox_jobs WHERE id=$1',[job])).rows[0].state,'dead_letter');
 await assert.rejects(worker.pool.query('UPDATE entitlements SET asset_id=$1 WHERE order_id=$2',[randomUUID(),p.order]),/immutable entitlement/);
 await assert.rejects(worker.pool.query("UPDATE outbox_jobs SET effect_key='changed' WHERE id=$1",[job]),/immutable delivery job/);
 await assert.rejects(receiverPool.query("UPDATE merchant_adapter.orders SET payment_state='recorded'"),/permission denied/);
});
test('B5-20 checked DNS is pinned through real TLS connect; changed answers and IPv6 destinations are enforced',async()=>{
 const dnsServer=merchantServer(receiver,{origin:'https://adapter.dispatch-demo.invalid:18448',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});dnsServer.listen(18448,'127.0.0.1');await once(dnsServer,'listening');
 let lookups=0;const dnsTarget=new WebhookTransport({id:'reference',url:'https://adapter.dispatch-demo.invalid:18448/dispatch/v1/events',keyId:'fixture-v1',key,bearer,
  demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}},async()=>{lookups++;return [{address:lookups===1?'127.0.0.1':'169.254.169.254',family:4}];});
 const raw=Buffer.from(JSON.stringify(event())),stamp=String(Math.floor(Date.now()/1000));assert.equal((await dnsTarget.send(raw,stamp)).receipt.state,'committed');assert.equal(lookups,1);
 await assert.rejects(dnsTarget.send(raw,stamp),/forbidden_destination/);assert.equal(lookups,2);await new Promise(r=>dnsServer.close(r));
 const ipv6=merchantServer(receiver,{origin:'https://[::1]:18447',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});
 ipv6.listen(18447,'::1');await once(ipv6,'listening');
 try{const v6=new WebhookTransport({id:'reference',url:'https://[::1]:18447/dispatch/v1/events',keyId:'fixture-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'::1',ca:cert}});
  assert.equal((await v6.send(Buffer.from(JSON.stringify(event())),stamp)).receipt.state,'committed');
  const blocked=new WebhookTransport({id:'reference',url:'https://[::1]:18447/dispatch/v1/events',keyId:'fixture-v1',key,bearer});await assert.rejects(blocked.send(raw,stamp),/forbidden_destination/);
 }finally{await new Promise(r=>ipv6.close(r));}
});
test('B5-21 owner importer rejects symlinks, preserves immutable manifest and empty-file boundary',async()=>{
 await writeFile(base+'/assets/empty.txt','');const a=await importPrivateAsset(admin,base+'/assets','empty.txt','empty.txt','text/plain');
 assert.deepEqual(await assets.read(a),Buffer.alloc(0));assert.throws(()=>byteRange('bytes=0-',0),/range_invalid/);assert.equal(byteRange(undefined,0),undefined);
 await symlink(base+'/assets/guide.json',base+'/assets/link.json');await assert.rejects(importPrivateAsset(admin,base+'/assets','link.json','link.json','application/json'));await unlink(base+'/assets/link.json');
 await assert.rejects(admin.query("UPDATE asset_versions SET download_name='changed.txt' WHERE id=$1",[a.id]),/immutable/);
});
test('B5-24 purchased active content is a real authenticated inert attachment, not rendered inline',async()=>{
 const content='<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';await writeFile(base+'/assets/purchased.svg',content);
 const a=await importPrivateAsset(admin,base+'/assets','purchased.svg','purchased.svg','image/svg+xml'),product=randomUUID();
 await admin.query(`INSERT INTO products(product_id,version,title,description,kind,asset_id,unit_amount,tax_status,tax_source,tax_version,policy_version)
  SELECT $1,1,'Active fixture','Untrusted SVG','digital',$2,unit_amount,tax_status,tax_source,tax_version,policy_version FROM products WHERE product_id=$3 AND version=1`,[product,a.id,fixture.product]);await admin.query('INSERT INTO product_publication VALUES($1,1,true)',[product]);
 const p=await paid({...policy(),productId:product});await entitlement(p.order);
 const r=await httpCall('/v1/orders/'+p.order+'/download',{headers:auth(p)});assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-disposition'),/^attachment/);assert.equal(await r.text(),content);
});
test('B5-25 real TLS 429 Retry-After durably delays the same effect without another order',async()=>{
 const limited=createServer({key:await readFile(base+'/tls.key'),cert},(_req,res)=>res.writeHead(429,{'Content-Type':'application/json','Retry-After':'20'}).end('{}'));limited.listen(18449,'127.0.0.1');await once(limited,'listening');
 const t=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18449/dispatch/v1/events',keyId:'fixture-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
 try{const result=await t.send(Buffer.from(JSON.stringify(event())),String(Math.floor(Date.now()/1000)));assert.equal(result.status,429);assert.equal(result.retryAfterSeconds,20);
  const p=await paid();await entitlement(p.order);const job=await readyJob(p.order),lease=await store.claim(job),attempt=await store.beginWebhook(lease,target.keyId,target.binding);
  await store.finishWebhook(lease,attempt.id,undefined,429,result.retryAfterSeconds);const state=(await admin.query('SELECT state,extract(epoch FROM available_at-clock_timestamp()) delay FROM outbox_jobs WHERE id=$1',[job])).rows[0];assert.equal(state.state,'retry');assert.ok(Number(state.delay)>19);assert.equal(await count('merchant_adapter.orders','WHERE dispatch_order_id=$1',[p.order]),0);
 }finally{await new Promise(r=>limited.close(r));}
});
test('B5-15 quarantine and entitlement revocation block future effects/access without erasing recorded payment or merchant order',async()=>{
 const before=await count('merchant_adapter.orders');const settlement=(await admin.query("SELECT id FROM settlements WHERE order_id=$1 AND disposition='credited'",[second.order])).rows[0].id;
 await worker.quarantine(settlement,'0x'+'ee'.repeat(32));await assert.rejects(access.authorize(second.order,second.credential));assert.equal((await resumePurchase(second.directory)).delivery.state,'blocked');
 assert.equal(await count('merchant_adapter.orders'),before);assert.equal((await admin.query('SELECT state FROM payment_attempts WHERE order_id=$1',[second.order])).rows[0].state,'settled');
});
