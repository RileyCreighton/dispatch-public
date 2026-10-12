import { approvedSigner } from './signer.js';
import { WalletSignatureRejected } from '../../payments/src/wallet.js';
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import type { ClientEvmSigner } from '@x402/evm';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { NETWORK,TOKEN,address,amount,canonical,id,json,quote,record,status,text, type Quote, type Status } from './contracts.js';
export type Policy = { origin:string;productId:string;productVersion:number;maxAtomic:string;payees:string[];network:string;token:string;policyVersion:string;policyURLs:string[] };
export type PurchaseRecord = { order:string;origin:string;policy:Policy;stage:'ready'|'signing'|'signed'|'rejected';confirmed:boolean;quote?:Quote;payment?:PaymentPayload;credential?:string;payKey:string };
export interface Journal { read():Promise<PurchaseRecord>; save(value:PurchaseRecord):Promise<void>; claimSigning():Promise<void>; rejected():Promise<void>; }
export function validateOrigin(origin:string) {
  const u=new URL(origin);if(u.origin!==origin || u.username || u.password || (u.protocol!=='https:' && !(u.protocol==='http:' && u.hostname==='127.0.0.1')))throw new Error('unapproved_origin');
}
export function validateQuote(q:Quote,p:Policy,order:string,now=Date.now()) {
  validateOrigin(p.origin);id(order);
  if(q.order_id!==order || q.product_id!==p.productId || q.product_version!==p.productVersion || q.quantity!==1
    || p.network!==NETWORK || q.network!==NETWORK || address(p.token)!==TOKEN || address(q.asset)!==TOKEN
    || !p.payees.map(address).includes(address(q.payee)) || amount(q.total_atomic)<=0n || amount(q.total_atomic)>amount(p.maxAtomic)
    || amount(q.unit_atomic)-amount(q.discount_atomic)+amount(q.tax_atomic)+amount(q.shipping_atomic)!==amount(q.total_atomic)
    || q.discount_atomic!=='0' || q.shipping_atomic!=='0' || q.shipping_source!=='not_applicable'
    || !['tax_included','merchant_attested_zero'].includes(q.tax_status) || !q.tax_source || !q.tax_version
    || q.policy_version!==p.policyVersion || canonical(q.policy_urls)!==canonical(p.policyURLs)
    || !Number.isFinite(Date.parse(q.expires_at)) || Date.parse(q.expires_at)<=now
    || !Number.isFinite(Date.parse(q.server_time)) || Math.abs(Date.parse(q.server_time)-now)>5000
    || Date.parse(q.expires_at)-Date.parse(q.server_time)>125000)throw new Error('quote_policy_refused');
  for(const url of q.policy_urls){const u=new URL(url);if(u.protocol!=='https:' || u.username || u.password)throw new Error('policy_url_refused');}
}
export function validateChallenge(required:PaymentRequired,selected:PaymentRequirements,q:Quote,p:Policy,order:string) {
  validateQuote(q,p,order);
  if(required.x402Version!==2 || required.resource.url!==`${p.origin}/v1/checkouts/${order}/pay`
    || required.accepts.length!==1 || canonical(required.accepts[0])!==canonical(selected)
    || (required.extensions && Object.keys(required.extensions).length>0)
    || selected.scheme!=='exact' || selected.network!==NETWORK || address(selected.asset)!==TOKEN
    || address(selected.payTo)!==address(q.payee) || selected.amount!==q.total_atomic
    || canonical(selected.extra)!==canonical({name:'USD Coin',version:'2',assetTransferMethod:'eip3009'})
    || !Number.isInteger(selected.maxTimeoutSeconds) || selected.maxTimeoutSeconds<1 || selected.maxTimeoutSeconds>30
    || Date.now()+selected.maxTimeoutSeconds*1000+5000>Date.parse(q.expires_at))throw new Error('challenge_policy_refused');
}
export function transport(origin:string,paths:ReadonlyMap<string,ReadonlySet<string>>,nativeFetch:typeof fetch,credentials:'omit'|'same-origin'):typeof fetch {
  validateOrigin(origin);
  return async(input,init)=>{
    const req=new Request(input,init),url=new URL(req.url);
    if(url.origin!==origin || url.username || url.password || url.search || url.hash || !paths.get(url.pathname)?.has(req.method))throw new Error('destination_refused');
    const response=await nativeFetch(new Request(req,{redirect:'error',credentials,cache:'no-store',referrerPolicy:'no-referrer'}));
    if(response.redirected || (response.status>=300 && response.status<400) || (response.url && response.url!==req.url))throw new Error('redirect_refused');
    return response;
  };
}
export async function responseStatus(response:Response,order:string):Promise<Status> {
  const body=await json(response);
  if(!response.ok){const r=record(body);throw new Error(['UNAUTHENTICATED','STALE_POLICY','NOT_READY','FORBIDDEN'].includes(String(r.code))?String(r.code):'status_unavailable');}
  return status(body,order);
}
export function purchasable(s:Status) { return s.order_state==='quoted' && s.payment_state==='none' && s.next_action==='review_quote'; }
export async function payOnce(options:{journal:Journal;signer:ClientEvmSigner;fetch:typeof fetch;headers:Record<string,string>;guard:()=>Promise<void>;onStage?:(stage:string)=>void}) {
  const saved=await options.journal.read(),p=structuredClone(saved.policy),q=saved.quote;
  const path=p.origin+'/v1/checkouts/'+id(saved.order),readStatus=async()=>responseStatus(await options.fetch(path,{headers:options.headers}),saved.order);
  if(!saved.confirmed || !q)throw new Error('recovery_not_ready');
  if(!['ready','rejected'].includes(saved.stage))return readStatus();
  const verify=async()=>{
    await options.guard();const s=await readStatus();
    if(!purchasable(s) || !s.quote || s.quote.quote_hash!==q.quote_hash || s.quote.id!==q.id)throw new Error('purchase_changed');
    const {server_time:_before,...before}=q,{server_time:_after,...after}=s.quote;
    if(canonical(before)!==canonical(after))throw new Error('purchase_changed');
    // server_time is refreshed by authenticated status; immutable quote fields must agree.
    validateQuote(s.quote,p,saved.order);await options.guard();
  };
  await verify();
  let walletRejected=false;
  const guardedSigner=approvedSigner(options.signer,q);
  const signer:ClientEvmSigner={address:options.signer.address,async signTypedData(data){
    try { await options.guard(); const signature=await guardedSigner.signTypedData(data);await options.guard();return signature; }
    catch(error){if(error instanceof WalletSignatureRejected)walletRejected=true;throw error;}
  }};
  // Private client: no failure/recovery hooks capable of requesting another authorization.
  const client=new x402Client().register(NETWORK,new ExactEvmScheme(signer));
  client.onBeforePaymentCreation(async({paymentRequired,selectedRequirements})=>{
    const current=await options.journal.read();
    if(!['ready','rejected'].includes(current.stage) || canonical(current.policy)!==canonical(p) || current.quote?.quote_hash!==q.quote_hash)throw new Error('already_attempted');
    const fresh=await readStatus();if(!purchasable(fresh) || !fresh.quote || fresh.quote.quote_hash!==q.quote_hash)throw new Error('purchase_changed');
    validateChallenge(paymentRequired,selectedRequirements,fresh.quote,p,saved.order);
    await options.guard();await options.journal.claimSigning();options.onStage?.('awaiting_wallet');
  });
  client.onAfterPaymentCreation(async({paymentPayload})=>{
    await options.guard();const current=await options.journal.read();
    await options.journal.save({...current,stage:'signed',payment:paymentPayload});
    await verify();options.onStage?.('submitting');
  });
  let signedSent=false;
  const guarded:typeof fetch=async(input,init)=>{
    const req=new Request(input,init);
    if(req.headers.has('PAYMENT-SIGNATURE')){
      if(signedSent)throw new Error('second_submission_refused');
      await verify();const current=await options.journal.read();if(current.stage!=='signed' || !current.payment)throw new Error('payload_not_persisted');
      signedSent=true;
    }
    return options.fetch(req);
  };
  try {
    const result=await wrapFetchWithPayment(guarded,client)(path+'/pay',{method:'POST',headers:{...options.headers,'Content-Type':'application/json','Idempotency-Key':saved.payKey},
      body:JSON.stringify({quote_id:q.id,quote_hash:q.quote_hash})});
    // Ignore facilitator/browser assertions and the POST body's status: read authoritative GET.
    if(![200,202].includes(result.status)){const body=record(await json(result));throw new Error(body.code==='NOT_READY'?'NOT_READY':'payment_status_required');}
    return readStatus();
  }catch(error){if(walletRejected && !signedSent){await options.journal.rejected();throw new Error('signature_rejected');}throw error;}
}
export function readCreated(value:unknown) {
  const r=record(value);id(r.id);text(r.expires_at);if(r.status_path!=='/v1/checkouts/'+r.id)throw new Error('invalid_create');return r;
}
export { quote };
