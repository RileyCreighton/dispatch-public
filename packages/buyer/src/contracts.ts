// Browser-safe runtime projections. No database, process environment or secret imports.
export const NETWORK = 'eip155:8453';
export const TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export type Quote = { id:string; order_id:string; product_id:string; product_version:number; quantity:1;
  unit_atomic:string; discount_atomic:string; tax_atomic:string; shipping_atomic:string; total_atomic:string;
  tax_status:string; tax_source:string; tax_version:string; shipping_source:string; policy_version:string;
  policy_urls:string[]; network:string; asset:string; payee:string; expires_at:string; server_time:string; quote_hash:string };
export type Product = { id:string; version:number; title:string; description:string; merchant_name:string;
  kind:'digital'; indicative_amount_atomic:string; network:string; asset:string; purchase_path:string; policy_urls:string[]; available:boolean };
export type Status = { id:string; order_state:string; payment_state:string; delivery:{state:string;download_path?:string;file_name?:string;mime_type?:string;size_bytes?:number;sha256?:string}; version:string;
  merchant_handoff?:{state:string;merchant_order_id?:string;receipt_id?:string}; credential_confirmed:true; policy_version:string; policy_urls:string[]; next_action:string; status_path:string;
  merchant_name:string; product:{id:string;version:number;title:string;description:string}; quote?:Quote };
export type Created = {id:string;status_path:string;expires_at:string;policy_version:string;policy_urls:string[];agent_capability?:string};
export function record(v:unknown):Record<string,unknown> { if(!v || typeof v!=='object' || Array.isArray(v))throw new Error('invalid_response'); return v as Record<string,unknown>; }
export function text(v:unknown):string { if(typeof v!=='string')throw new Error('invalid_response');return v; }
export function id(v:unknown):string { const s=text(v);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s))throw new Error('invalid_id');return s; }
export function amount(v:unknown):bigint { const s=text(v);if(!/^(0|[1-9][0-9]{0,77})$/.test(s) || BigInt(s)>2n**256n-1n)throw new Error('invalid_amount');return BigInt(s); }
export function strings(v:unknown):string[] { if(!Array.isArray(v) || v.some(x=>typeof x!=='string'))throw new Error('invalid_response');return v as string[]; }
export function version(v:unknown):number { if(typeof v!=='number' || !Number.isSafeInteger(v) || v<1)throw new Error('invalid_version');return v; }
export function address(v:unknown):string { const s=text(v);if(!/^0x[0-9a-fA-F]{40}$/.test(s) || /^0x0{40}$/i.test(s))throw new Error('invalid_address');return s.toLowerCase(); }
export function parseJSON(source:string):unknown {
  // Modern JSON reviver context retains the original integer token before Number rounding.
  const parse = JSON.parse as (s:string,reviver:(key:string,value:unknown,context?:{source?:string})=>unknown)=>unknown;
  return parse(source,(_key,value,context)=>{
    if(typeof value==='number' && !Number.isSafeInteger(value)) {
      if(!context?.source || !/^[0-9]+$/.test(context.source))throw new Error('lossy_json_refused');
      return context.source;
    }
    return value;
  });
}
export async function json(response:Response):Promise<unknown> { const body=await response.text();if(body.length>131072)throw new Error('response_too_large');return parseJSON(body); }
export function quote(value:unknown):Quote {
  const q=record(value);for(const f of ['id','order_id','product_id'])id(q[f]);version(q.product_version);
  for(const f of ['unit_atomic','discount_atomic','tax_atomic','shipping_atomic','total_atomic'])amount(q[f]);
  for(const f of ['tax_status','tax_source','tax_version','shipping_source','policy_version','network','expires_at','server_time','quote_hash'])text(q[f]);
  address(q.asset);address(q.payee);strings(q.policy_urls);
  if(q.quantity!==1 || !/^0x[0-9a-f]{64}$/.test(text(q.quote_hash)))throw new Error('invalid_quote');
  return q as Quote;
}
export function product(value:unknown):Product {
  const p=record(value);id(p.id);version(p.version);amount(p.indicative_amount_atomic);
  for(const f of ['title','description','merchant_name','network','asset','purchase_path'])text(p[f]);strings(p.policy_urls);
  if(p.kind!=='digital' || typeof p.available!=='boolean' || p.purchase_path!=='/buy/'+p.id)throw new Error('invalid_product');
  return p as Product;
}
export function status(value:unknown,order:string):Status {
  const s=record(value);if(s.id!==order || s.credential_confirmed!==true || s.status_path!=='/v1/checkouts/'+id(order))throw new Error('invalid_status');
  for(const f of ['order_state','payment_state','policy_version','next_action','merchant_name'])text(s[f]);
  strings(s.policy_urls);const delivery=record(s.delivery);text(delivery.state);
  if(delivery.download_path!==undefined){
    if(delivery.state!=='available'||delivery.download_path!==`/v1/orders/${order}/download`||typeof delivery.size_bytes!=='number'||!Number.isSafeInteger(delivery.size_bytes)||delivery.size_bytes<0||delivery.size_bytes>16777216
      ||!/^0x[0-9a-f]{64}$/.test(text(delivery.sha256)))throw new Error('invalid_delivery');
    text(delivery.file_name);text(delivery.mime_type);
  }
  const p=record(s.product);id(p.id);version(p.version);text(p.title);text(p.description);
  if(typeof s.version==='number' && Number.isSafeInteger(s.version) && s.version>=0)s.version=String(s.version);
  if(typeof s.version!=='string' || !/^(0|[1-9][0-9]*)$/.test(s.version))throw new Error('invalid_status_version');
  if(s.quote!==undefined)s.quote=quote(s.quote);
  return s as Status;
}
export function formatUSDC(value:string):string { const a=amount(value);return `${a/1000000n}.${(a%1000000n).toString().padStart(6,'0')}`; }
export function canonical(value:unknown):string {
  if(value===null || typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
