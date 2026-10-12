// Synchronize candidate observation only; actual worker claims/effects remain unchanged.
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {Pool} from 'pg';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {WebhookTransport} from '../../dist/packages/fulfillment/src/transport.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {digest} from '../../dist/packages/db/src/commerce.js';
const base=process.env.DISPATCH_DB_HOST;
if(!/^\/tmp\/dispatch-b4-/.test(base))throw Error('disposable_only');
const pool=new Pool({host:base,port:55442,user:'local_worker',database:'dispatch'});
const target=new WebhookTransport({id:'reference',url:'https://127.0.0.1:18444/dispatch/v1/events',keyId:'fixture-v1',key:await readFile(base+'/webhook.key'),bearer:(await readFile(base+'/adapter.bearer','utf8')).trim(),demo:{network:'dispatch-build005-disposable-loopback',address:'127.0.0.1',ca:await readFile(base+'/tls.crt','utf8')}});
class ObservedStore extends DeliveryStore{async pending(){const rows=await super.pending();process.send({selected:rows.map(r=>r.id)});await once(process,'message');return rows;}}
try{await deliveryTick(new ObservedStore(pool,new Map([['reference',target.binding]])),new Map([['reference',target]]));}
finally{await pool.end();process.disconnect();}
