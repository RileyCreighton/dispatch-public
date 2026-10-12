import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {fork} from 'node:child_process';
import {createServer} from 'node:https';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {setup,teardown,admin,api,worker,fixture,policy,newSigner,settle,origin,httpCall,server,restartApi,support,commerce,logs} from '../fulfillment/fixtures.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {digest} from '../../dist/packages/db/src/commerce.js';
import {PrivateFiles} from '../../dist/packages/fulfillment/src/files.js';
import {WebhookTransport} from '../../dist/packages/fulfillment/src/transport.js';
import {verifyBody,signBody} from '../../dist/packages/fulfillment/src/webhook.js';
import {merchantServer,MerchantReceiver} from '../../dist/examples/merchant-adapter/src/server.js';
import {merchantSite} from '../../dist/examples/merchant-site/src/server.js';
import {apiServer} from '../../dist/apps/api/src/app.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE;
const endpoint='https://127.0.0.1:18444',url=endpoint+'/dispatch/v1/events';
const store=new DeliveryStore(worker.pool,new Map([['reference',digest(url)]]));
let cert,tls,key,bearer,target,receiverPool,receiver,rs,browser,purchased;const children=new Set(),reports=[];
const auth=p=>({Authorization:'Bearer '+p.credential});
async function paid(){await support();const directory=base+'/review-agent-'+randomUUID(),j=await createPurchase(policy(),directory),p=await j.read();await authorizePurchase(directory,policy(),await newSigner());await settle(p.order);return {...p,directory};}
async function job(p,type='entitlement'){return (await admin.query('SELECT * FROM outbox_jobs WHERE order_id=$1 AND effect_type=$2',[p.order,type])).rows[0];}
async function ready(p,type='merchant_paid'){const j=await job(p,type);await admin.query("UPDATE outbox_jobs SET available_at=clock_timestamp()-interval '1 second',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[j.id]);return j.id;}
async function grant(p){await store.entitlement(await store.claim((await job(p)).id));}
async function count(table,order){return Number((await admin.query(`SELECT count(*) n FROM ${table} WHERE ${table==='merchant_adapter.orders'?'dispatch_order_id':'order_id'}=$1`,[order])).rows[0].n);}
async function startReceiver(){rs=merchantServer(receiver,{origin:endpoint,keys:new Map([['review-key',key]]),bearer,tls});rs.listen(18444,'127.0.0.1');await once(rs,'listening');}
async function closeReceiver(){if(rs){rs.closeAllConnections();await new Promise(r=>rs.close(r));rs=undefined;}}
async function kill(c){c.kill('SIGKILL');await once(c,'exit');children.delete(c);}
async function waitFor(fn){for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('review_schedule_timeout');}
test.before(async()=>{await setup();key=randomBytes(32);bearer=randomBytes(32).toString('base64url');cert=await readFile(base+'/tls.crt','utf8');tls={cert,key:await readFile(base+'/tls.key')};
 await admin.query(await readFile('examples/merchant-adapter/schema.sql','utf8'));await admin.query('CREATE ROLE fixture_receiver LOGIN; GRANT USAGE ON SCHEMA merchant_adapter TO fixture_receiver; GRANT SELECT,INSERT ON merchant_adapter.orders TO fixture_receiver');
 receiverPool=new Pool({host:base,port:55442,database:'dispatch',user:'fixture_receiver'});receiver=new MerchantReceiver(receiverPool);await startReceiver();
 target=new WebhookTransport({id:'reference',url,keyId:'review-key',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
 browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});
});
test.beforeEach(async()=>{await admin.query('TRUNCATE abuse_counters');await support();});
test.after(async()=>{for(const c of children)await kill(c);await browser?.close();await closeReceiver();await receiverPool?.end();
 await writeFile(out+'/independent-observations.json',JSON.stringify(reports,null,2)+'\n');await teardown();});
test('R5-01 positive real payment, metadata, entitlement, signed receiver and agent private bytes',async()=>{
 purchased=await paid();await deliveryTick(store,new Map([['reference',target]]));await deliveryTick(store,new Map([['reference',target]]));
 const bytes=await retrievePurchase(purchased.directory);assert.deepEqual(bytes,await readFile(base+'/assets/guide.json'));
 assert.equal(await count('entitlements',purchased.order),1);assert.equal(await count('merchant_adapter.orders',purchased.order),1);
 reports.push({case:'R5-01',bytes:bytes.length,sha256:digest(bytes),payment:'genuine local EVM with synthetic facilitator',entitlements:1,merchant_orders:1});
});
test('R5-02 imported recovery grant cannot download before its own authenticated confirmation',async()=>{
 const recovery=await commerce.buyers.export(purchased.order,purchased.credential,randomUUID());
 const context=await browser.newContext({ignoreHTTPSErrors:true});try{
 const r=await context.request.post(origin+'/v1/recovery/import',{headers:{Origin:origin,'X-Dispatch-Intent':'recovery'},data:{capability:recovery.capability}});assert.equal(r.status(),200);
 const path=origin+'/v1/orders/'+purchased.order+'/download';assert.equal((await context.request.get(path)).status(),401);
 assert.equal((await context.request.get(origin+'/v1/checkouts/'+purchased.order)).status(),200);assert.equal((await context.request.get(path)).status(),200);
 }finally{await context.close();}
});
test('R5-03 kill real worker after entitlement INSERT but before COMMIT; rollback then takeover preserves purchase',async()=>{
 const p=await paid(),j=await job(p),blocker=await admin.connect();
 await admin.query(`CREATE FUNCTION dispatch.review_entitlement_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(91265001); RETURN NEW; END $$; CREATE TRIGGER review_entitlement_gate AFTER INSERT ON dispatch.entitlements FOR EACH ROW EXECUTE FUNCTION dispatch.review_entitlement_gate()`);
 await blocker.query('SELECT pg_advisory_lock(91265001)');
 const c=fork('tests/regressions/crash-child.mjs',[j.id],{stdio:['ignore','ignore','pipe','ipc'],env:process.env});children.add(c);c.stderr.resume();
 try{await once(c,'message');await waitFor(async()=>Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE usename='local_worker' AND wait_event='advisory'")).rows[0].n)>0);
 assert.equal(await count('entitlements',p.order),0);await kill(c);
 }finally{await blocker.query('SELECT pg_advisory_unlock(91265001)');blocker.release();await admin.query('DROP TRIGGER review_entitlement_gate ON dispatch.entitlements; DROP FUNCTION dispatch.review_entitlement_gate()');}
 assert.equal(await count('entitlements',p.order),0);await ready(p,'entitlement');await grant(p);
 assert.equal(await count('entitlements',p.order),1);assert.equal(await count('payment_attempts',p.order),1);assert.equal(await count('settlements',p.order),1);
 reports.push({case:'R5-03',kill_point:'AFTER entitlement INSERT inside uncommitted application transaction',uncommitted_visible:0,after_takeover_entitlements:1,payments:1});
});
test('R5-04 kill real worker after durable entitlement COMMIT before caller observes completion; same identity survives',async()=>{
 const p=await paid(),j=await job(p);const c=fork('tests/regressions/crash-child.mjs',[j.id],{stdio:['ignore','ignore','pipe','ipc'],env:process.env});children.add(c);c.stderr.resume();
 await new Promise((resolve,reject)=>{c.on('message',m=>{if(m==='committed')resolve();});c.once('exit',()=>reject(Error('early_exit')));});
 const before=(await admin.query('SELECT id FROM entitlements WHERE order_id=$1',[p.order])).rows[0].id;await kill(c);
 await deliveryTick(store,new Map([['reference',target]]));assert.equal((await admin.query('SELECT id FROM entitlements WHERE order_id=$1',[p.order])).rows[0].id,before);
 assert.equal((await job(p)).state,'done');assert.equal(await count('merchant_adapter.orders',p.order),1);assert.equal(await count('payment_attempts',p.order),1);
 reports.push({case:'R5-04',kill_point:'after COMMIT, child waiting before return',same_entitlement:true,payments:1,merchant_orders:1});
});
test('R5-05 queued and claimed work rechecks current order, incidents and fulfillment restriction',async()=>{
 const p=await paid(),j=await job(p);
 for(const state of ['review_required','cancelled']){await admin.query('UPDATE orders SET state=$2 WHERE id=$1',[p.order,state]);await assert.rejects(store.claim(j.id),/delivery_blocked/);}
 await admin.query("UPDATE orders SET state='paid' WHERE id=$1",[p.order]);const lease=await store.claim(j.id);
 await admin.query("INSERT INTO payment_incidents(id,order_id,kind,evidence) VALUES($1,$2,'review_probe','{}')",[randomUUID(),p.order]);
 await assert.rejects(store.entitlement(lease),/delivery_blocked/);assert.equal(await count('entitlements',p.order),0);
 reports.push({case:'R5-05',current_order_and_incident_blocked:true,entitlements:0});
});
test('R5-06 final download authorization denies session revocation after actual file read, with no DB transaction across file I/O',async()=>{
 await new Promise(r=>server.close(r));let reached,release;const readDone=new Promise(r=>reached=r),resume=new Promise(r=>release=r);
 class Gated extends PrivateFiles{async read(a){const b=await super.read(a);reached();await resume;return b;}}
 const s=apiServer(api,origin,()=>{},commerce,{tls,files:new Gated(base+'/assets')});s.listen(18443,'127.0.0.1');await once(s,'listening');
 try{const response=httpCall('/v1/orders/'+purchased.order+'/download',{headers:auth(purchased)});await readDone;
 assert.equal(Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE usename='local_api' AND xact_start IS NOT NULL AND state='idle in transaction'")).rows[0].n),0);
 await admin.query('UPDATE buyer_sessions SET revoked_at=clock_timestamp() WHERE capability_hash=$1',[digest(purchased.credential)]);release();const r=await response;assert.equal(r.status,401);assert.doesNotMatch(await r.text(),/Private purchased fixture bytes/);
 }finally{release();await new Promise(r=>s.close(r));await admin.query('UPDATE buyer_sessions SET revoked_at=NULL WHERE capability_hash=$1',[digest(purchased.credential)]);await restartApi();}
});
test('R5-07 future timestamp, bad MAC, raw whitespace and all immutable field conflicts leave one receiver effect',async()=>{
 const row=(await admin.query('SELECT raw_body FROM merchant_events WHERE order_id=$1',[purchased.order])).rows[0],body=Buffer.from(row.raw_body),event=JSON.parse(row.raw_body),now=String(Math.floor(Date.now()/1000));
 assert.throws(()=>verifyBody(body,{'dispatch-timestamp':String(Number(now)+301),'dispatch-key-id':'review-key','dispatch-signature':signBody(body,String(Number(now)+301),key)},new Map([['review-key',key]])),/unauthorized/);
 const post=async(raw,stamp=now,sig=signBody(raw,stamp,key))=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Dispatch-Key-Id':'review-key','Dispatch-Timestamp':stamp,'Dispatch-Signature':sig},body:raw});
 assert.equal((await post(body,String(Number(now)+301))).status,401);assert.equal((await post(body,now,'v1'+'='.repeat(65))).status,401);
 assert.equal((await post(Buffer.concat([body,Buffer.from(' ')]),now,signBody(body,now,key))).status,401);
 for(const changed of [{amount_atomic:'999'},{product_version:2},{quote_id:randomUUID()},{dispatch_order_id:randomUUID()},{merchant_order_id:'different'},{effect_id:'different'}])assert.equal((await post(Buffer.from(JSON.stringify({...event,...changed})))).status,409);
 for(const changed of [{network:'eip155:1'},{asset:'0x'+'aa'.repeat(20)}])assert.equal((await post(Buffer.from(JSON.stringify({...event,...changed})))).status,401);
 assert.equal(await count('merchant_adapter.orders',purchased.order),1);
});
test('R5-08 rejected/malformed/wrong receipt and timeout persist unknown, never manufacture completion; eight attempts stop',async()=>{
 const p=await paid();await grant(p);await closeReceiver();let requests=0,mode='malformed';
 rs=createServer(tls,async(req,res)=>{requests++;for await(const _ of req){}if(mode==='timeout')return;res.writeHead(mode==='rejected'?403:200,{'Content-Type':'application/json'});res.end(mode==='malformed'?'not-json':JSON.stringify({operation_id:randomUUID(),state:'committed',effect_id:'wrong',merchant_order_id:'wrong',receipt_id:'wrong'}));});rs.listen(18444,'127.0.0.1');await once(rs,'listening');
 try{for(let n=1;n<=8;n++){mode=n===1?'timeout':n===2?'rejected':n===3?'wrong':'malformed';const lease=await store.claim(await ready(p)),a=await store.beginWebhook(lease,target.keyId,target.binding);let r;
 try{r=await target.send(a.body,a.timestamp);}catch(error){assert.equal(mode,'timeout');assert.match(error.message,/receiver_timeout/);}
 await store.finishWebhook(lease,a.id,r?.status===200?r.receipt:undefined,r?.status??null);
 assert.equal((await job(p,'merchant_paid')).state,n===8?'dead_letter':'retry');assert.equal(await count('merchant_adapter.orders',p.order),0);}
 assert.equal(requests,8);assert.equal(await count('payment_attempts',p.order),1);assert.equal(await count('entitlements',p.order),1);
 }finally{await closeReceiver();await startReceiver();}
 reports.push({case:'R5-08',attempts:8,state:'dead_letter',receipt:false,merchant_orders:0});
});
test('R5-09 forbidden alternate address encodings and DNS changes never reach counting TLS listener; redirects do not forward auth',async()=>{
 let hits=0;const forbidden=createServer(tls,(_q,r)=>{hits++;r.end('{}');});forbidden.listen(18449,'127.0.0.1');await once(forbidden,'listening');
 const cfg={id:'blocked',keyId:'review-key',key,bearer};
 try{for(const host of ['127.0.0.1','127.1','2130706433','0x7f000001','0177.0.0.1','[::ffff:127.0.0.1]']){
 await assert.rejects(async()=>{const t=new WebhookTransport({...cfg,url:`https://${host}:18449/dispatch/v1/events`});await t.send(Buffer.from('{}'),String(Math.floor(Date.now()/1000)));});}
 for(const answers of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'::1',family:6}]]){
 const t=new WebhookTransport({...cfg,url:'https://forbidden.invalid:18449/dispatch/v1/events'},async()=>answers);await assert.rejects(t.status(randomUUID()),/forbidden_destination/);}
 const redirect=createServer(tls,(_q,r)=>r.writeHead(307,{Location:'https://127.0.0.1:18449/dispatch/v1/events'}).end());redirect.listen(18448,'127.0.0.1');await once(redirect,'listening');
 try{const t=new WebhookTransport({...cfg,url:'https://127.0.0.1:18448/dispatch/v1/events',demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});await assert.rejects(t.status(randomUUID()),/redirect_denied/);await assert.rejects(t.send(Buffer.from('{}'),String(Math.floor(Date.now()/1000))),/redirect_denied/);}finally{await new Promise(r=>redirect.close(r));}
 assert.equal(hits,0);reports.push({case:'R5-09',forbidden_listener_hits:hits,controls_disabled:false});
 }finally{await new Promise(r=>forbidden.close(r));}
});
test('R5-10 browser cache never serves revoked private data; delivery states pass axe and keyboard access',async()=>{
 const recovery=await commerce.buyers.export(purchased.order,purchased.credential,randomUUID()),ctx=await browser.newContext({ignoreHTTPSErrors:true});
 try{await ctx.request.post(origin+'/v1/recovery/import',{headers:{Origin:origin,'X-Dispatch-Intent':'recovery'},data:{capability:recovery.capability}});const page=await ctx.newPage();await page.goto(origin+'/checkout/'+purchased.order);await page.getByRole('link',{name:'Download file',exact:true}).waitFor();
 const path='/v1/orders/'+purchased.order+'/download';assert.equal(await page.evaluate(async p=>(await fetch(p)).status,path),200);
 for(const state of ['available','blocked','revoked']){
 if(state==='blocked')await admin.query('UPDATE merchant_control SET fulfillment_paused=true');
 if(state==='revoked'){await admin.query('UPDATE merchant_control SET fulfillment_paused=false');await admin.query("UPDATE entitlements SET state='revoked' WHERE order_id=$1",[purchased.order]);}
 await page.getByRole('button',{name:'Check payment status',exact:true}).click();await page.getByText('File delivery: '+state,{exact:true}).waitFor();
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();reports.push({case:'R5-10',state,violations:axe.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)}))});assert.equal(axe.violations.length,0);
 await page.setViewportSize({width:360,height:900});await page.screenshot({path:out+'/review-'+state+'-360.png',fullPage:true});
 if(state==='available'){await page.getByRole('link',{name:'Download file',exact:true}).focus();assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Download file');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Check payment status');}
 else{const response=await page.evaluate(async p=>{const r=await fetch(p,{cache:'force-cache'});return {status:r.status,text:await r.text()};},path);assert.equal(response.status,409);assert.doesNotMatch(response.text,/Private purchased fixture bytes/);}
 }
 }finally{await ctx.close();await admin.query('UPDATE merchant_control SET fulfillment_paused=false');}
});
test('R5-11 merchant form layout, validation, network and submission independent with absent, DNS failed, API refused, worker unavailable',async()=>{
 let baseline;for(const mode of ['absent','present','dns-down','api-down','worker-down']){
 const site=merchantSite({port:18446,...(mode==='absent'?{}:{dispatchOrigin:mode==='dns-down'?'https://dispatch-outage.invalid':mode==='api-down'?'https://127.0.0.1:19999':origin,product:fixture.product})});await once(site,'listening');
 const context=await browser.newContext({ignoreHTTPSErrors:true});const page=await context.newPage();const requests=[];page.on('request',r=>requests.push({method:r.method(),url:r.url()}));
 if(mode==='dns-down')await page.route('https://dispatch-outage.invalid/**',route=>route.abort('namenotresolved'));
 try{await page.goto('http://127.0.0.1:18446');await page.setViewportSize({width:360,height:900});const box=await page.locator('form').boundingBox();if(!baseline)baseline=box;else assert.deepEqual(box,baseline);
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.equal(axe.violations.length,0);await page.screenshot({path:out+'/review-merchant-'+mode+'.png',fullPage:true});
 await page.getByRole('button',{name:'Continue ordinary checkout'}).click();assert.equal(requests.filter(r=>r.method==='POST').length,0);
 await page.getByLabel('Name for your order').fill('Synthetic Reviewer');await page.getByRole('button',{name:'Continue ordinary checkout'}).click();await page.waitForURL('**/ordinary-checkout');assert.match(await page.textContent('body'),/Ordinary checkout accepted/);
 assert.deepEqual(requests.map(r=>new URL(r.url).origin).filter(x=>x!=='http://127.0.0.1:18446'),[]);assert.equal(requests.filter(r=>r.method==='POST'&&r.url==='http://127.0.0.1:18446/ordinary-checkout').length,1);
 reports.push({case:'R5-11',mode,form:box,requests,axe_violations:0,worker_called:false});
 }finally{await context.close();await new Promise(r=>site.close(r));}
 }
 assert.ok(logs.every(l=>!l.includes(purchased.credential)&&!l.includes(base)&&!l.includes(bearer)));
});
