import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {Hex} from 'viem';
import {discover,type Wallet} from './wallets.js';
import {formatUSDC} from '../../../packages/buyer/src/contracts.js';
type Controls={version:number;payment_paused:boolean;fulfillment_paused:boolean};
type Config={state:string;config_version:number;controls:Controls;config:null|{merchant_name:string;payee:string;policy_version:string;policy_urls:string[]}};
type Status={id:string;payment_state:string;delivery:{state:string};merchant_handoff?:{state:string};refund_state:string;shipment_state:string};
type Order=Status&{id:string;title:string;payment_state:string;delivery_state:string;refund_state:string;shipment_state:string;settlement_id:string|null;original_payer:string|null;amount_atomic:string|null;original_payee:string};
type Refund={id:string;state:string;version:number;expected_signer:string;destination:string;amount_atomic:string;transaction_hint?:string;binding?:{wallet_account_nonce:string;transaction_to:Hex;transaction_value:string;transaction_calldata:Hex;chain_id:number}};
type Product={id:string;title:string;description:string;version:number;unit_atomic:string;purchase_path:string;asset_manifest_id:string;tax_status:string;tax_source:string;tax_version:string;enabled:boolean};
type Products={products:Product[];assets:{id:string;download_name:string}[]};
const value=(f:HTMLFormElement,name:string)=>String(new FormData(f).get(name)??'');
const publicKey=(id:string)=>'dispatch-refund-invocation:'+id;
export function OperatorApp(){
 const [session,setSession]=useState(false),[csrf,setCsrf]=useState(''),[page,setPage]=useState('setup'),[message,setMessage]=useState(''),[pending,setPending]=useState(false);
 const busy=useRef(false),[config,setConfig]=useState<Config|null>(null),[products,setProducts]=useState<Products>({products:[],assets:[]}),[orders,setOrders]=useState<Order[]>([]);
 const [detail,setDetail]=useState<{order:Order;status:Status;timeline:{time:string;kind:string;safe_message:string}[];refunds:{id:string}[];retry_jobs:{id:string;fence:string}[]}|null>(null);
 const [ready,setReady]=useState<{payments_ready:boolean;checks:{code:string;status:string;safe_message:string}[]}|null>(null);
 const [wallets,setWallets]=useState<Wallet[]>([]),[wallet,setWallet]=useState<Wallet|null>(null),[sender,setSender]=useState(''),[refund,setRefund]=useState<Refund|null>(null);
 const [editing,setEditing]=useState<Product|null>(null);
 const [invocation,setInvocation]=useState<Refund|null>(null);
 const [approved,setApproved]=useState(false),[fresh,setFresh]=useState(false);
 async function api<T>(path:string,method='GET',body?:unknown,key?:string):Promise<{body:T;replayed:boolean}>{
  const res=await fetch('/v1/operator'+path,{method,redirect:'error',credentials:'same-origin',headers:{...(method==='GET'?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf}),...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!res.ok){const e=await res.json();if(res.status===401)setFresh(false);throw new Error(e.code??'Request unavailable');}
  return {body:res.status===204?{} as T:await res.json() as T,replayed:res.headers.get('Idempotency-Replayed')==='true'};
 }
 async function keyed<T>(path:string,method:string,body:unknown){
  const slot='dispatch-operator-command:'+path,previous=localStorage.getItem(slot);
  const saved=previous?JSON.parse(previous) as {body:unknown;method:string;key:string;rejected?:boolean}:null;
  if(saved&&(JSON.stringify(saved.body)!==JSON.stringify(body)||saved.method!==method))throw new Error('Recover or explicitly discard the rejected saved action before changing it.');
  const entry=saved??{body,method,key:crypto.randomUUID()};localStorage.setItem(slot,JSON.stringify(entry));
  try{const result=await api<T>(path,method,body,entry.key);localStorage.removeItem(slot);return result;}
  catch(e){if(e instanceof Error&&['STALE_CONFIG','IDEMPOTENCY_CONFLICT','INVALID_INPUT'].includes(e.message))localStorage.setItem(slot,JSON.stringify({...entry,rejected:true}));throw e;}
 }
 async function recoverCommands(discard=false){
  for(const slot of Object.keys(localStorage).filter(k=>k.startsWith('dispatch-operator-command:'))){
   const saved=JSON.parse(localStorage.getItem(slot)!) as {body:unknown;method:string;key:string;rejected?:boolean};
   if(discard){if(saved.rejected)localStorage.removeItem(slot);continue;}
   await keyed(slot.slice('dispatch-operator-command:'.length),saved.method,saved.body);
  }
  await refresh();setMessage(discard?'Rejected actions discarded. Review current values before a new deliberate save.':'Saved actions recovered; current state refreshed.');
 }
 const act=async(fn:()=>Promise<void>)=>{if(busy.current)return;busy.current=true;setPending(true);setMessage('');try{await fn();}catch(e){setMessage(e instanceof Error?e.message:'Request unavailable');}finally{busy.current=false;setPending(false);}};
 async function refresh(){setConfig((await api<Config>('/config')).body);setProducts((await api<Products>('/products')).body);setReady((await api<typeof ready>('/readiness')).body);}
 useEffect(()=>{void api<{csrf_token:string}>('/session').then(async r=>{setCsrf(r.body.csrf_token);setSession(true);await refresh();}).catch(()=>{});return discover(w=>setWallets(old=>old.some(x=>x.uuid===w.uuid)?old:[...old,w]));},[]);
 async function login(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget,password=value(form,'password');form.reset();await act(async()=>{
  const challenge=await api<{csrf_token:string}>('/session/challenge');
  const response=await fetch('/v1/operator/session',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':challenge.body.csrf_token},body:JSON.stringify({password})});
  if(!response.ok)throw new Error('Sign-in unavailable. Check local initialization and password.');const s=await response.json();setCsrf(s.csrf_token);setSession(true);setFresh(true);await refresh();
 });}
 async function openOrder(id:string){setInvocation(null);const d=(await api<NonNullable<typeof detail>>('/orders/'+id)).body;setDetail(d);setRefund(d.refunds[0]?(await api<Refund>('/refunds/'+d.refunds[0].id)).body:null);setApproved(false);setPage('detail');}
 async function connect(w:Wallet){setInvocation(null);await w.provider.request({method:'eth_requestAccounts'});const accounts=await w.provider.request({method:'eth_accounts'}),chain=await w.provider.request({method:'eth_chainId'});
  if(chain!=='0x2105'||accounts.length!==1)throw new Error('Choose one sending account on Base.');setWallet(w);setSender(accounts[0]!.toLowerCase());setApproved(false);}
 async function saveObservation(r:Refund,body:Record<string,unknown>){
  const key=crypto.randomUUID();localStorage.setItem(publicKey(r.id),JSON.stringify({invoked:true,key,body}));
  const result=await api<Refund>('/refunds/'+r.id+'/observation','POST',body,key);setRefund(result.body);
 }
 async function invoke(){
  if(!wallet||!refund||!approved||refund.state!=='prepared'||localStorage.getItem(publicKey(refund.id)))throw new Error('This refund is status-only. Do not send another transfer.');
  const accounts=await wallet.provider.request({method:'eth_accounts'}),chain=await wallet.provider.request({method:'eth_chainId'});
  if(chain!=='0x2105'||accounts.length!==1||accounts[0]!.toLowerCase()!==refund.expected_signer)throw new Error('Sending account or network changed. Review again.');
  const nonce=await wallet.provider.request({method:'eth_getTransactionCount',params:[accounts[0]!,'pending']});
  // Permanent client marker precedes request. Lost claim response/reload never reopens invocation.
  localStorage.setItem(publicKey(refund.id),JSON.stringify({invoked:true}));
  const result=await api<Refund>('/refunds/'+refund.id+'/wallet-start','POST',{expected_version:refund.version,signer:refund.expected_signer,observed_account_nonce:BigInt(nonce).toString()},crypto.randomUUID());
  setRefund(result.body);if(result.replayed||!result.body.binding)throw new Error('Saved wallet authorization recovered. Status only.');
  setInvocation(result.body);setApproved(false);setMessage('Nonce and exact transfer are now reserved. Review them below before opening the wallet.');
 }
 async function sendWallet(){
  if(!invocation||!wallet||!approved||invocation.id!==refund?.id||refund.expected_signer!==sender)throw new Error('Review the bound transfer first.');
  const r=invocation,b=r.binding!;setInvocation(null);
  let changed=false,started=false;
  const invalidate=()=>{changed=true;setApproved(false);};
  const provider=wallet.provider;
  provider.on?.('accountsChanged',invalidate);provider.on?.('chainChanged',invalidate);provider.on?.('disconnect',invalidate);
  const guard=()=>{if(changed)throw new Error('wallet_changed');};
  try{
   const current=await wallet.provider.request({method:'eth_accounts'}),network=await wallet.provider.request({method:'eth_chainId'});
   if(current.length!==1||current[0]!.toLowerCase()!==r.expected_signer||network!=='0x2105')throw new Error('account_changed');
   await api('/refunds/'+r.id+'/invocation','POST',{expected_version:r.version});
   const finalAccounts=await wallet.provider.request({method:'eth_accounts'}),finalChain=await wallet.provider.request({method:'eth_chainId'});
   if(finalChain!=='0x2105'||finalAccounts.length!==1||finalAccounts[0]!.toLowerCase()!==r.expected_signer)throw new Error('account_changed');
   guard();
   const authorizationStarted=performance.now();
   const authority=await api<{authorization_window_ms:number}>('/refunds/'+r.id+'/authorization','POST',{expected_version:r.version});
   guard();if(!Number.isFinite(authority.body.authorization_window_ms)||performance.now()-authorizationStarted>=authority.body.authorization_window_ms)throw new Error('authorization_response_stale');
   // No further awaits before invocation. The server commit and wallet call are not atomic.
   started=true;
   const hash=await wallet.provider.request({method:'eth_sendTransaction',params:[{from:current[0]!,to:b.transaction_to,value:'0x0',data:b.transaction_calldata,nonce:('0x'+BigInt(b.wallet_account_nonce).toString(16)) as Hex,chainId:'0x2105'}]});
   await saveObservation(r,{expected_version:r.version,invocation_version:r.version,outcome:'transaction_hash',transaction_hash:hash});
   setMessage('Transaction saved. Confirmation requires independent reconciliation.');
  }catch(e){
   // A generic 4001, disconnect or lost response cannot prove that no transaction broadcast.
   const saved=JSON.parse(localStorage.getItem(publicKey(r.id))??'{}') as {body?:unknown};
   if(started&&!saved.body)await saveObservation(r,{expected_version:r.version,invocation_version:r.version,outcome:'unknown'});
   setMessage(started?'Refund outcome is uncertain. Check status; do not send another refund.':'Wallet was not invoked. Reservation remains consumed; review status.');
  }finally{provider.removeListener?.('accountsChanged',invalidate);provider.removeListener?.('chainChanged',invalidate);provider.removeListener?.('disconnect',invalidate);}
 }
 async function checkRefund(){if(!refund)return;
  const saved=JSON.parse(localStorage.getItem(publicKey(refund.id))??'{}') as {key?:string;body?:Record<string,unknown>};
  if(saved.key&&saved.body){try{await api('/refunds/'+refund.id+'/observation','POST',saved.body,saved.key);}catch{/* Current server status remains authoritative. */}}
  setRefund((await api<Refund>('/refunds/'+refund.id)).body);
 }
 const field=(label:string,name:string,initial='',type='text')=><label>{label}<input name={name} type={type} defaultValue={initial} required autoComplete={type==='password'?'current-password':'off'}/></label>;
 return <><header className="top"><a className="brand" href="/operator">Dispatch <span>Merchant operations</span></a><span className="environment">Local demonstration · Mainnet disabled</span></header>
 <main className="operator"><h1>{!session?'Initialize and sign in':page==='setup'?'Setup & readiness':page==='settings'?'Receiving wallet & controls':page==='products'?'Products & purchase links':page==='detail'?'Order detail':'Orders'}</h1>
 <div role="status" aria-live="polite" className="status">{pending?'Working…':message||'Private operator access. Payment, delivery and refund states are tracked separately.'}</div>
 {!session?<section className="card"><h2>Owner-local initialization</h2><p>Run the documented local bootstrap command on this host, then complete it with your own password. There is no public signup.</p><form onSubmit={e=>void login(e)}>{field('Operator password','password','','password')}<button className="primary" disabled={pending}>Sign in</button></form><a href="/health/live">Check service liveness</a></section>:<>
 <nav aria-label="Operator pages">{['setup','products','orders','settings'].map(p=><button className="secondary" disabled={pending} key={p} aria-current={page===p?'page':undefined} onClick={()=>void act(async()=>{setInvocation(null);setApproved(false);setPage(p);if(p==='orders'){const data=(await api<{orders:Status[];summaries:Order[]}>('/orders')).body;setOrders(data.summaries.map(o=>({...o,...data.orders.find(s=>s.id===o.id)})));}else await refresh();})}>{p==='setup'?'Setup & readiness':p==='settings'?'Settings & pauses':p[0]!.toUpperCase()+p.slice(1)}</button>)}</nav>
 <details><summary>Fresh authentication for settings and refunds {fresh?'· recently verified':''}</summary><form onSubmit={e=>{e.preventDefault();const f=e.currentTarget,password=value(f,'password');f.reset();void act(async()=>{await api('/session/reauth','POST',{password});setFresh(true);setMessage('Password verified. Confirm the exact action within five minutes.');});}}>{field('Confirm operator password','password','','password')}<button className="secondary" disabled={pending}>Authenticate again</button></form></details>
 {(page==='setup'||page==='settings')&&config&&<div className="layout"><section className="card"><h2>{config.config?'Merchant settings':'Set up merchant details'}</h2><p className="subtle">Existing purchases retain their original receiving wallet and policy. Unresolved payments remain bound.</p><form key={config.config_version} onSubmit={e=>{e.preventDefault();const f=e.currentTarget;const body={expected_config_version:config.config_version,merchant_name:value(f,'merchant'),pay_origin:location.origin,payee:value(f,'payee'),confirmation_payee:value(f,'confirmation'),policy_version:value(f,'policy'),policy_urls:[value(f,'url')]};void act(async()=>{
  const r=await keyed('/config','PUT',body);await refresh();setMessage(r.replayed?'Recovered original save; current settings refreshed.':'Merchant details saved. Payment controls remain unchanged.');});}}>
 {field('Merchant name','merchant',config.config?.merchant_name)}{field('Receiving wallet on Base','payee',config.config?.payee)}<p className="address">Current: {config.config?.payee??'Not configured'}</p>{field('Type the exact receiving wallet to confirm','confirmation')}{field('Policy version','policy',config.config?.policy_version)}{field('Public versioned policy URL','url',config.config?.policy_urls[0],'url')}
 <button className="primary" disabled={pending}>Confirm and save settings</button></form>
</section>
 <section className="card"><h2>Independent pause controls</h2><p>Payment pause blocks new payment authorizations. Submitted signatures may still settle. Fulfillment pause blocks future file access and delivery work; previously sent bytes or effects cannot be recalled.</p>{(['payments','fulfillment'] as const).map(kind=>{const paused=kind==='payments'?config.controls.payment_paused:config.controls.fulfillment_paused;return <div className="delivery" key={kind}><strong>{kind==='payments'?'Payments':'Fulfillment'}: {paused?'Paused':'Resumed'}</strong><button className="secondary" disabled={pending} onClick={()=>void act(async()=>{await keyed('/pause/'+kind,'POST',{paused:!paused,expected_version:config.controls.version,reason:'Explicit operator '+(paused?'resume':'pause')});await refresh();})}>{paused?'Resume':'Pause'} {kind}</button></div>;})}<h2>Readiness</h2><p><strong>{ready?.payments_ready?'Local purchase path ready':'Local setup blocked'}</strong> · Live release unverified</p>{ready?.checks.map(c=><div className="readiness-row" key={c.code}><strong>{c.code.replaceAll('_',' ')} · {c.status}</strong><p>{c.safe_message}</p></div>)}</section></div>}
 {page==='products'&&<div className="layout"><section className="card"><h2>Products</h2>{products.products.map(p=><article key={p.id}><h3>{p.title}</h3><p>{formatUSDC(p.unit_atomic)} USDC · version {p.version}</p><a href={p.purchase_path}>Open purchase page</a><button className="text-button" onClick={()=>void act(async()=>{await navigator.clipboard.writeText(location.origin+p.purchase_path);setMessage('Purchase link copied.');})}>Copy purchase link</button><p className="address">{location.origin+p.purchase_path}</p><button className="secondary" onClick={()=>setEditing(p)}>Edit next version of {p.title}</button></article>)}{!products.products.length&&<p>No products yet. Import an immutable private asset using the local command, then publish its price and tax treatment.</p>}</section><section className="card"><h2>{editing?'Publish a new product version':'Create a digital product'}</h2><form key={editing?.id??'new'} onSubmit={e=>{e.preventDefault();const f=e.currentTarget;void act(async()=>{await keyed(editing?'/products/'+editing.id:'/products',editing?'PUT':'POST',{...(editing?{expected_version:editing.version}:{}),title:value(f,'title'),description:value(f,'description'),kind:'digital',asset_manifest_id:value(f,'asset'),unit_atomic:value(f,'price'),tax_status:value(f,'tax'),tax_source:value(f,'tax_source'),tax_version:value(f,'tax_version'),policy_version:config?.config?.policy_version,enabled:value(f,'enabled')==='on'});setEditing(null);await refresh();setMessage('Product version published. Existing orders retain their purchased version.');});}}>
 {field('Product title','title',editing?.title)}{field('Description','description',editing?.description)}<label>Imported private asset<select name="asset" defaultValue={editing?.asset_manifest_id??''} required><option value="">Choose imported asset</option>{products.assets.map(a=><option value={a.id} key={a.id}>{a.download_name}</option>)}</select></label>{field('Price in integer USDC units (1 USDC = 1000000)','price',editing?.unit_atomic)}<label>Explicit tax treatment<select name="tax" defaultValue={editing?.tax_status??'tax_included'}><option value="tax_included">Tax included in price</option><option value="merchant_attested_zero">Merchant attests zero tax</option></select></label>{field('Tax policy source','tax_source',editing?.tax_source)}{field('Tax policy version','tax_version',editing?.tax_version)}<label className="consent"><input type="checkbox" name="enabled" defaultChecked={editing?.enabled??true}/>Available for new purchases</label><p>Confirmed refunds preserve existing file access under the current purchase policy.</p><button className="primary" disabled={pending||!products.assets.length}>{editing?'Publish next version':'Publish first version'}</button>{editing&&<button type="button" className="secondary" onClick={()=>setEditing(null)}>Cancel product edit</button>}</form></section></div>}
 {page==='orders'&&<section className="card"><h2>Oldest unresolved orders first</h2>{orders.map(o=><article className="delivery" key={o.id}><h3>{o.title}</h3><p>Payment: {o.payment_state} · Delivery: {o.delivery.state} · Merchant handoff: {o.merchant_handoff?.state??'none'} · Shipment: {o.shipment_state} · Refund: {o.refund_state}</p><button className="secondary" onClick={()=>void act(()=>openOrder(o.id))}>Review order {o.id.slice(0,8)}</button></article>)}{!orders.length&&<p>No orders yet. Create and share your first product link.</p>}</section>}
 {page==='detail'&&detail&&<div className="layout"><section className="card"><h2>{detail.order.title}</h2><p className="address">{detail.order.id}</p><dl className="breakdown">{['payment_state','delivery','merchant_handoff','refund_state','shipment_state'].map(k=><div key={k}><dt>{k.replace('_state','').replaceAll('_',' ')}</dt><dd>{String(k==='refund_state'&&refund?refund.state:k==='delivery'?detail.status.delivery.state:k==='merchant_handoff'?detail.status.merchant_handoff?.state??'none':detail.status[k as keyof Status]).replaceAll('_',' ')}</dd></div>)}</dl><a href={'/v1/operator/orders/'+detail.order.id+'/receipt'}>Download purchase record</a><h2>Timeline</h2><ol>{detail.timeline.map((t,i)=><li key={i}><strong>{t.kind.replaceAll('_',' ')}</strong><p>{t.safe_message}</p><time>{new Date(t.time).toLocaleString()}</time></li>)}</ol><button className="secondary" onClick={()=>void act(()=>openOrder(detail.order.id))}>Refresh order</button>{detail.retry_jobs.map(j=><button className="secondary" key={j.id} onClick={()=>void act(async()=>{await keyed('/orders/'+detail.order.id+'/delivery/retry','POST',{job_id:j.id,expected_fence:j.fence});await openOrder(detail.order.id);})}>Retry existing delivery</button>)}</section>
 <section className="card"><h2>Manual full refund</h2>{!detail.order.settlement_id?<p>A refund requires an independently verified original settlement.</p>:<><p>Original payment history is retained. This policy preserves file access; previously downloaded bytes cannot be recalled.</p><p><strong>{formatUSDC(detail.order.amount_atomic!)} USDC</strong> · Base · native USDC</p><p className="label">Original payer / refund destination</p><p className="address">{detail.order.original_payer}</p><p className="label">Original receiving wallet</p><p className="address">{detail.order.original_payee}</p>
 {!refund&&<>{wallets.map(w=><button className="secondary" key={w.uuid} onClick={()=>void act(()=>connect(w))}>Connect refund wallet: {w.name}</button>)}<p>Visibly approved sending wallet (may differ from original payee):</p><p className="address">{sender||'Connect an external wallet'}</p><label className="consent"><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>I approve this exact full amount, original payer, Base USDC and sending wallet.</label><button className="primary" disabled={pending||!sender||!approved} onClick={()=>void act(async()=>{setRefund((await keyed<Refund>('/orders/'+detail.order.id+'/refunds','POST',{settlement_id:detail.order.settlement_id,confirmed_original_payer:detail.order.original_payer,expected_signer:sender})).body);setApproved(false);})}>Prepare full refund</button></>}
 {refund&&<><div className="notice"><strong>Refund: {refund.state.replaceAll('_',' ')}</strong><p>{refund.state==='confirmed'?'Refund independently confirmed. Original payment remains recorded.':refund.state==='prepared'||invocation?'Review the exact transfer before one wallet invocation.':'Outcome may be unresolved. Check status; do not send another refund.'}</p></div><p className="address">Approved sender: {refund.expected_signer}</p>{refund.binding&&<p>Reserved nonce: {refund.binding.wallet_account_nonce}</p>}{refund.transaction_hint&&<p className="address">Transaction: {refund.transaction_hint}</p>}
 {refund.state==='prepared'&&<>{wallets.map(w=><button className="secondary" key={w.uuid} onClick={()=>void act(()=>connect(w))}>Select sending wallet: {w.name}</button>)}<label className="consent"><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>Confirm one full transfer from the approved sending account to the original payer.</label><button className="primary" disabled={pending||!wallet||!approved} onClick={()=>void act(invoke)}>Approve one wallet invocation</button></>}
 <p className="address">Native token: 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913</p>{invocation&&<><label className="consent"><input type="checkbox" checked={approved} onChange={e=>setApproved(e.target.checked)}/>I confirm the displayed reserved nonce, full USDC amount, destination and sending account.</label><button className="primary" disabled={pending||!approved} onClick={()=>void act(sendWallet)}>Send exact bound refund</button></>}<button className="secondary" onClick={()=>void act(checkRefund)} disabled={pending}>Check refund status</button></>}
 </>}</section></div>}
 <button className="text-button" onClick={()=>void act(()=>recoverCommands())}>Recover saved actions</button><button className="text-button" onClick={()=>void act(()=>recoverCommands(true))}>Discard rejected actions after review</button><button className="text-button" onClick={()=>void act(async()=>{await api('/session','DELETE',{});setInvocation(null);setSession(false);setFresh(false);})}>Sign out</button></>}
 </main></>;
}
