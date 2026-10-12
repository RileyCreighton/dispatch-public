import type { ClientEvmSigner } from '@x402/evm';
import { createHash, randomUUID } from 'node:crypto';
import { canonical,id,json,product,record,status,text,quote,type Status } from '../../../packages/buyer/src/contracts.js';
import {payOnce,readCreated,transport,validateOrigin,validateQuote,type Policy} from '../../../packages/buyer/src/client.js';
import {FileJournal} from './journal.js';
function paths(order?:string){return new Map<string,Set<string>>([
  ['/v1/catalog',new Set(['GET'])],['/v1/checkouts',new Set(['POST'])],
  ...(order?[[`/v1/checkouts/${order}`,new Set(['GET'])],[`/v1/checkouts/${order}/quote`,new Set(['POST'])],[`/v1/checkouts/${order}/pay`,new Set(['POST'])]] as [string,Set<string>][]:[])
]);}
async function ok(response:Response){const value=await json(response);if(!response.ok)throw new Error('commerce_request_refused');return value;}
export async function createPurchase(approved:Policy,directory:string,nativeFetch:typeof fetch=fetch):Promise<FileJournal>{
  const policy=structuredClone(approved);validateOrigin(policy.origin);id(policy.productId);
  const send=transport(policy.origin,paths(),nativeFetch,'omit');
  const catalog=record(await ok(await send(policy.origin+'/v1/catalog')));
  if(!Array.isArray(catalog.products))throw new Error('invalid_catalog');
  const item=catalog.products.map(product).find(p=>p.id===policy.productId && p.version===policy.productVersion);
  if(!item || !item.available)throw new Error('approved_product_unavailable');
  // Descriptions and HTTP text are display-only data, never policy/tool instructions.
  const created=readCreated(await ok(await send(policy.origin+'/v1/checkouts',{method:'POST',headers:{Origin:policy.origin,'Content-Type':'application/json'},
    body:JSON.stringify({product_id:policy.productId,product_version:policy.productVersion,quantity:1,client_kind:'agent'})})));
  const credential=text(created.agent_capability);if(!/^[A-Za-z0-9_-]{43}$/.test(credential))throw new Error('invalid_credential');
  const order=id(created.id),journal=new FileJournal(directory);
  await journal.initialize({order,origin:policy.origin,policy,credential,confirmed:false,stage:'ready',payKey:randomUUID()});
  await preparePurchase(directory,policy,nativeFetch);return journal;
}
// Explicit pre-sign preparation/review recovery. It never changes a signing/signed stage.
export async function preparePurchase(directory:string,approved:Policy,nativeFetch:typeof fetch=fetch):Promise<FileJournal>{
  const journal=new FileJournal(directory),saved=await journal.read(),policy=structuredClone(approved);
  if(canonical(saved.policy)!==canonical(policy) || !['ready','rejected'].includes(saved.stage))throw new Error('preparation_refused');
  const order=id(saved.order),fetcher=transport(policy.origin,paths(order),nativeFetch,'omit');
  const headers={Origin:policy.origin,Authorization:'Bearer '+saved.credential};
  const s=status(await ok(await fetcher(policy.origin+'/v1/checkouts/'+order,{headers})),order);
  if(s.payment_state!=='none' || !['draft','quoted'].includes(s.order_state)
    || s.product.id!==policy.productId || s.product.version!==policy.productVersion || s.policy_version!==policy.policyVersion || canonical(s.policy_urls)!==canonical(policy.policyURLs))throw new Error('approved_policy_mismatch');
  const q=s.quote && Date.parse(s.quote.expires_at)>Date.now() ? s.quote : quote(await ok(await fetcher(policy.origin+'/v1/checkouts/'+order+'/quote',{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':randomUUID()},
    body:JSON.stringify({product_version:policy.productVersion,quantity:1,policy_version:s.policy_version})})));
  validateQuote(q,policy,order);
  const latest=await journal.read();if(!['ready','rejected'].includes(latest.stage))throw new Error('already_attempted');
  await journal.save({...latest,confirmed:true,quote:q});return journal;
}

export async function resumePurchase(directory:string,nativeFetch:typeof fetch=fetch):Promise<Status>{
  const saved=await new FileJournal(directory).read();validateOrigin(saved.origin);id(saved.order);
  const fetcher=transport(saved.origin,paths(saved.order),nativeFetch,'omit');
  return status(await ok(await fetcher(saved.origin+'/v1/checkouts/'+saved.order,{headers:{Origin:saved.origin,Authorization:'Bearer '+saved.credential}})),saved.order);
}
export async function authorizePurchase(directory:string,approved:Policy,signer:ClientEvmSigner,nativeFetch:typeof fetch=fetch):Promise<Status>{
  const journal=new FileJournal(directory),saved=await journal.read();
  if(canonical(saved.policy)!==canonical(approved) || saved.origin!==approved.origin)throw new Error('approval_changed');
  const fetcher=transport(saved.origin,paths(saved.order),nativeFetch,'omit');
  return payOnce({journal,signer,fetch:fetcher,headers:{Origin:saved.origin,Authorization:'Bearer '+saved.credential},guard:async()=>{
    if(canonical((await journal.read()).policy)!==canonical(approved))throw new Error('approval_changed');
  }});
}

// Explicit retrieval only: no payment/signing path and no execution of downloaded instructions.
export async function retrievePurchase(directory:string,nativeFetch:typeof fetch=fetch):Promise<Buffer>{
  const saved=await new FileJournal(directory).read(),s=await resumePurchase(directory,nativeFetch),d=s.delivery;
  if(d.state!=='available'||d.download_path!==`/v1/orders/${saved.order}/download`||d.size_bytes===undefined||!d.sha256)throw new Error('delivery_unavailable');
  const fetcher=transport(saved.origin,new Map([[d.download_path,new Set(['GET'])]]),nativeFetch,'omit');
  const response=await fetcher(saved.origin+d.download_path,{headers:{Authorization:'Bearer '+saved.credential}});
  if(response.status!==200||response.headers.get('content-length')!==String(d.size_bytes)||!response.body)throw new Error('download_refused');
  const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>d.size_bytes)throw new Error('download_size');chunks.push(Buffer.from(r.value));}}
  finally{await reader.cancel();}
  const bytes=Buffer.concat(chunks);if(bytes.length!==d.size_bytes||'0x'+createHash('sha256').update(bytes).digest('hex')!==d.sha256)throw new Error('download_integrity');return bytes;
}
