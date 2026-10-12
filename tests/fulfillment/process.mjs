import {digest} from '../../dist/packages/db/src/commerce.js';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {Pool} from 'pg';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {WebhookTransport} from '../../dist/packages/fulfillment/src/transport.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {merchantServer,MerchantReceiver} from '../../dist/examples/merchant-adapter/src/server.js';
const base=process.env.DISPATCH_DB_HOST;
if(!/^\/tmp\/dispatch-b4-/.test(base))throw new Error('disposable_only');
const pool=new Pool({host:base,port:55442,user:process.argv[2]==='receiver'?'fixture_receiver':'local_worker',database:'dispatch'});
const key=await readFile(base+'/webhook.key'),bearer=(await readFile(base+'/adapter.bearer','utf8')).trim(),cert=await readFile(base+'/tls.crt','utf8');
const target=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18444/dispatch/v1/events',keyId:'fixture-v1',key,bearer,demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:cert}});
if(process.argv[2]==='worker'){
 const store=new DeliveryStore(pool,new Map([['reference',digest('https://127.0.0.1:18444/dispatch/v1/events')]]));
 if(process.argv[3]==='claim-crash'){const pending=await store.pending();await store.claim(pending[0].id);process.send?.('claimed');await new Promise(()=>{});}
 else{await deliveryTick(store,new Map([['reference',target]]));await pool.end();}
}else if(process.argv[2]==='api'){
 const fixture=await import('./fixtures.mjs');await fixture.bootApi();process.send?.('ready');
}else{
 const server=merchantServer(new MerchantReceiver(pool),{origin:'https://127.0.0.1:18444',keys:new Map([['fixture-v1',key]]),bearer,tls:{key:await readFile(base+'/tls.key'),cert:Buffer.from(cert)}});
 server.listen(18444,'127.0.0.1');await once(server,'listening');process.send?.('ready');
}
