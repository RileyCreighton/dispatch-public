import { createHmac, timingSafeEqual } from 'node:crypto';
import { object, uuid } from '../../domain/src/payment.js';
export const WEBHOOK_LIMIT=32768;
export type PaidEvent={type:'dispatch.order.paid.v1';event_id:string;effect_id:string;occurred_at:string;merchant_id:'single';merchant_order_id:string;
 dispatch_order_id:string;quote_id:string;product_version:number;amount_atomic:string;asset:string;network:'eip155:8453';
 payment_reference:{transaction_hash:string;authorization_log_index:number;transfer_log_index:number;observation_policy:string}};
export type OperationReceipt={operation_id:string;state:'pending'|'committed'|'rejected'|'review_required';effect_id?:string;merchant_order_id?:string;receipt_id?:string};
const bounded=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(v))throw new Error('invalid_event');return v;};
export function paidEvent(input:unknown):PaidEvent {
 const v=object(input,['type','event_id','effect_id','occurred_at','merchant_id','merchant_order_id','dispatch_order_id','quote_id','product_version','amount_atomic','asset','network','payment_reference']);
 for(const f of ['event_id','dispatch_order_id','quote_id'])uuid(v[f]);bounded(v.effect_id);bounded(v.merchant_order_id);
 if(v.type!=='dispatch.order.paid.v1'||v.merchant_id!=='single'||v.network!=='eip155:8453'||typeof v.asset!=='string'
  ||v.asset.toLowerCase()!=='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'||typeof v.amount_atomic!=='string'||! /^[1-9][0-9]{0,77}$/.test(v.amount_atomic)
  ||BigInt(v.amount_atomic)>2n**256n-1n||!Number.isSafeInteger(v.product_version)||Number(v.product_version)<1
  ||typeof v.occurred_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.occurred_at)||!Number.isFinite(Date.parse(v.occurred_at)))throw new Error('invalid_event');
 const p=object(v.payment_reference,['transaction_hash','authorization_log_index','transfer_log_index','observation_policy']);
 if(typeof p.transaction_hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(p.transaction_hash)||!['safe','finalized','l2_receipt_risk_accepted'].includes(String(p.observation_policy))
  ||![p.authorization_log_index,p.transfer_log_index].every(x=>Number.isSafeInteger(x)&&Number(x)>=0))throw new Error('invalid_event');
 return v as PaidEvent;
}
export function operationReceipt(input:unknown):OperationReceipt {
 const v=object(input,['operation_id','state','effect_id','merchant_order_id','receipt_id']);uuid(v.operation_id);
 if(!['pending','committed','rejected','review_required'].includes(String(v.state)))throw new Error('invalid_receipt');
 for(const f of ['effect_id','merchant_order_id','receipt_id'])if(v[f]!==undefined)bounded(v[f]);
 if(v.state==='committed'&&(!v.effect_id||!v.merchant_order_id||!v.receipt_id))throw new Error('invalid_receipt');
 return v as OperationReceipt;
}
export function signBody(body:Buffer,timestamp:string,key:Buffer):string {
 if(key.length<32||body.length>WEBHOOK_LIMIT||!/^\d{1,12}$/.test(timestamp))throw new Error('invalid_signing_input');
 return 'v1='+createHmac('sha256',key).update(timestamp+'.','ascii').update(body).digest('hex');
}
export function verifyBody(body:Buffer,headers:Record<string,string|string[]|undefined>,keys:ReadonlyMap<string,Buffer>,now=Date.now()):PaidEvent {
 const stamp=headers['dispatch-timestamp'],id=headers['dispatch-key-id'],signature=headers['dispatch-signature'];
 if(!Buffer.isBuffer(body)||body.length>WEBHOOK_LIMIT||typeof stamp!=='string'||!/^\d{1,12}$/.test(stamp)
  ||Math.abs(Math.floor(now/1000)-Number(stamp))>300||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)
  ||typeof signature!=='string'||!/^v1=[0-9a-f]{64}$/.test(signature))throw new Error('unauthorized');
 const key=keys.get(id);if(!key||!timingSafeEqual(Buffer.from(signBody(body,stamp,key)),Buffer.from(signature)))throw new Error('unauthorized');
 // Parse only after authenticating exact bytes. No reserialized-body signature comparison.
 return paidEvent(JSON.parse(body.toString('utf8')) as unknown);
}
