import {digest} from '../../dist/packages/db/src/commerce.js';
// Disposable local demonstration only. Generated PostgreSQL/TLS/EVM fixtures are supplied by the runner.
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {Pool} from 'pg';
import {setup,teardown,admin,worker,fixture,origin,policy,newSigner,settle} from '../../tests/fulfillment/fixtures.mjs';
import {pageWithWallets,beginPage,connectPage} from '../../tests/fulfillment/human.mjs';
import {createPurchase,authorizePurchase,retrievePurchase} from '../../dist/examples/agent/src/purchase.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {WebhookTransport} from '../../dist/packages/fulfillment/src/transport.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {MerchantReceiver,merchantServer} from '../../dist/examples/merchant-adapter/src/server.js';
import {merchantSite} from '../../dist/examples/merchant-site/src/server.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE;
if(!/^\/tmp\/dispatch-b4-/.test(base))throw new Error('disposable_only');
let site,adapter,browser,receiverPool;
try{
 await setup();const key=randomBytes(32),bearer=randomBytes(32).toString('base64url'),cert=await readFile(base+'/tls.crt','utf8');
 await admin.query(await readFile('examples/merchant-adapter/schema.sql','utf8'));
 await admin.query('CREATE ROLE fixture_receiver LOGIN; GRANT USAGE ON SCHEMA merchant_adapter TO fixture_receiver; GRANT SELECT,INSERT ON merchant_adapter.orders TO fixture_receiver');
 receiverPool=new Pool({host:base,port:55442,user:'fixture_receiver',database:'dispatch'});
 adapter=merchantServer(new MerchantReceiver(receiverPool),{origin:'https://127.0.0.1:18444',keys:new Map([['demo-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});adapter.listen(18444,'127.0.0.1');await once(adapter,'listening');
 site=merchantSite({port:18446,dispatchOrigin:origin,product:fixture.product});
 const target=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18444/dispatch/v1/events',keyId:'demo-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
 const store=new DeliveryStore(worker.pool,new Map([['reference',digest('https://127.0.0.1:18444/dispatch/v1/events')]])),targets=new Map([['reference',target]]);
 const directory=base+'/demo-agent',journal=await createPurchase(policy(),directory);await authorizePurchase(directory,policy(),await newSigner());const saved=await journal.read();await settle(saved.order);await deliveryTick(store,targets);await deliveryTick(store,targets);await retrievePurchase(directory);
 browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});const f=await pageWithWallets(browser),order=await beginPage(f.page);await connectPage(f.page);await f.page.getByRole('button',{name:/^Authorize /}).click();await f.page.getByRole('heading',{name:'Checking your payment',exact:true}).waitFor();await settle(order);await deliveryTick(store,targets);await deliveryTick(store,targets);await f.page.getByRole('button',{name:'Check payment status',exact:true}).click();await f.page.getByRole('link',{name:'Download file',exact:true}).waitFor();
 await f.page.screenshot({path:out+'/demo-human.png',fullPage:true});const [download]=await Promise.all([f.page.waitForEvent('download'),f.page.getByRole('link',{name:'Download file',exact:true}).click()]);if(!(await readFile(await download.path())).equals(await readFile(base+'/assets/guide.json')))throw new Error('demo_integrity');
 const result={ordinary_merchant:'http://127.0.0.1:18446',public_purchase_link:origin+'/buy/'+fixture.product,human:'generated local EVM signature, authenticated download passed',agent:'maintained x402 client, generated local EVM signature, authenticated download passed',merchant_orders:Number((await admin.query('SELECT count(*) n FROM merchant_adapter.orders')).rows[0].n),real_funds:false};
 await writeFile(out+'/demo.json',JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');
 if(!process.argv.includes('--smoke'))await Promise.race([new Promise(r=>setTimeout(r,300000)),once(process,'SIGINT'),once(process,'SIGTERM')]);
}finally{await browser?.close();if(site)await new Promise(r=>site.close(r));if(adapter)await new Promise(r=>adapter.close(r));await receiverPool?.end();await teardown();}
