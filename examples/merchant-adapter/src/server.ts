import express, {type ErrorRequestHandler} from 'express';
import { createServer } from 'node:https';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { canonical } from '../../../packages/payments/src/canonical.js';
import { verifyBody, type PaidEvent, type OperationReceipt } from '../../../packages/fulfillment/src/webhook.js';
import { uuid } from '../../../packages/domain/src/payment.js';
export class MerchantReceiver {
 constructor(readonly pool:Pool){}
 async record(event:PaidEvent):Promise<OperationReceipt> {
  const fingerprint=createHash('sha256').update(canonical(event)).digest('hex');
  // Autocommit INSERT is atomic. Uniqueness serializes concurrent deliveries across processes.
  await this.pool.query(`INSERT INTO merchant_adapter.orders(merchant_order_id,event_id,effect_id,dispatch_order_id,content_hash,receipt_id,payment_state,fulfillment_state,shipment_state)
   VALUES($1,$2,$3,$4,$5,$6,'recorded','scheduled','not_applicable') ON CONFLICT DO NOTHING`,[event.merchant_order_id,event.event_id,event.effect_id,event.dispatch_order_id,fingerprint,randomUUID()]);
  const row=(await this.pool.query('SELECT * FROM merchant_adapter.orders WHERE event_id=$1',[event.event_id])).rows[0];
  if(!row||row.content_hash!==fingerprint||row.effect_id!==event.effect_id||row.merchant_order_id!==event.merchant_order_id)throw new Error('conflicting_event');
  return {operation_id:row.event_id,state:'committed',effect_id:row.effect_id,merchant_order_id:row.merchant_order_id,receipt_id:row.receipt_id};
 }
 async status(id:string):Promise<OperationReceipt|undefined>{const row=(await this.pool.query('SELECT * FROM merchant_adapter.orders WHERE event_id=$1',[uuid(id)])).rows[0];
  return row?{operation_id:row.event_id,state:'committed',effect_id:row.effect_id,merchant_order_id:row.merchant_order_id,receipt_id:row.receipt_id}:undefined;}
}
export function merchantServer(receiver:MerchantReceiver,config:{origin:string;keys:ReadonlyMap<string,Buffer>;bearer:string;tls:{key:Buffer;cert:Buffer}}) {
 const origin=new URL(config.origin);if(origin.protocol!=='https:'||origin.origin!==config.origin||! /^[A-Za-z0-9_-]{43,128}$/.test(config.bearer))throw new Error('invalid_receiver');
 const app=express();app.disable('x-powered-by');app.disable('etag');
 app.use((req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  if(req.headers.host!==origin.host||req.url.includes('?')||req.headers['transfer-encoding']){res.sendStatus(400);return;}next();});
 app.post('/dispatch/v1/events',express.raw({type:'application/json',limit:32768,inflate:false}),async(req,res)=>{
  try{if(!req.is('application/json')){res.sendStatus(415);return;}
   const event=verifyBody(req.body as Buffer,req.headers,config.keys);res.json(await receiver.record(event));
  }catch(error){res.sendStatus(error instanceof Error&&error.message==='conflicting_event'?409:401);}});
 app.get('/dispatch/v1/operations/:id',async(req,res)=>{try{
  const auth=req.headers.authorization,expected=Buffer.from('Bearer '+config.bearer);
  if(typeof auth!=='string'||Buffer.byteLength(auth)!==expected.length||!timingSafeEqual(Buffer.from(auth),expected)){res.sendStatus(401);return;}
  const receipt=await receiver.status(req.params.id);if(!receipt){res.sendStatus(404);return;}res.json(receipt);
 }catch{res.sendStatus(400);}});
 app.use((_req,res)=>res.sendStatus(404));
 const errors:ErrorRequestHandler=(_err,_req,res,_next)=>{res.sendStatus(413);};app.use(errors);
 const server=createServer({...config.tls,maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000},app);server.maxConnections=32;server.keepAliveTimeout=1000;return server;
}
