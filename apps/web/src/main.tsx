import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';
import { injectedSigner } from '../../../packages/payments/src/wallet.js';
import {NETWORK,TOKEN,amount,formatUSDC,id,json,product,record,status as readStatus,text,type Product,type Status} from '../../../packages/buyer/src/contracts.js';
import {payOnce,purchasable,readCreated,transport,type Policy} from '../../../packages/buyer/src/client.js';
import {BrowserJournal} from './journal.js';
import {context,discover,type Wallet} from './wallets.js';
import './style.css';
import {OperatorApp} from './operator.js';
const messages:Record<string,string>={
  wrong_network:'Your wallet is on another network. Switch to Base, then check your wallet.',
  wallet_disconnected:'Your wallet is disconnected. Select and connect it again.',
  wallet_context_changed:'Your wallet account or network changed. Check the current wallet before continuing. A pending authorization will not be submitted.',
  connect_rejected:'Connection declined. No payment was requested.',
  balance_unavailable:'We could not read your USDC balance. Check your wallet connection and try again.',
  insufficient_usdc:'Your wallet does not have enough USDC for this total.',
  signature_rejected:'Authorization declined. No signed payment was submitted. You can review and authorize again.',
  quote_policy_refused:'The price window expired or the quote changed. Check status, then review a new quote if no payment is pending.',
  STALE_POLICY:'The purchase terms changed. Check status and review the current terms. An unpaid draft may need to be closed before starting again.',
  NOT_READY:'New USDC payments are paused or unavailable. Existing payment status remains accessible.',
  UNAUTHENTICATED:'Your checkout session expired or is unavailable. Import a saved recovery file. A transaction hash cannot restore private access.',
  storage_unavailable:'Private purchase recovery could not be saved in this browser. Payment is blocked until storage is available.',
  uncertain:'The outcome is not yet known. Check this order’s status. Do not authorize another payment.',
  purchase_changed:'This purchase changed while your wallet was open. Check status; the late authorization was not submitted.'
};
function App(){
  const path=location.pathname.split('/'),initialOrder=path[1]==='checkout'?path[2]??'':'';
  const [item,setItem]=useState<Product|null>(null),[order,setOrder]=useState(initialOrder),[state,setState]=useState<Status|null>(null);
  const [error,setError]=useState(''),[phase,setPhase]=useState('loading'),[wallets,setWallets]=useState<Wallet[]>([]),[picker,setPicker]=useState(false);
  const [wallet,setWallet]=useState<Wallet|null>(null),[account,setAccount]=useState(''),[balance,setBalance]=useState<string|null>(null);
  const [terms,setTerms]=useState(false),[stage,setStage]=useState(''),[preparedHash,setPreparedHash]=useState(''),[now,setNow]=useState(Date.now());
  const walletTrigger=useRef<HTMLButtonElement>(null);
  const csrf=useRef(''),busy=useRef(false),generation=useRef(0),selected=useRef<Wallet|null>(null),current=useRef<Status|null>(null);
  const origin=location.origin;
  const request=async(pathname:string,method='GET',body?:unknown,extra:Record<string,string>={})=>{
    const allowed=new Map([[pathname,new Set([method])]]);
    return transport(origin,allowed,fetch.bind(window),'same-origin')(origin+pathname,{method,headers:{...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':csrf.current}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  };
  const session=async()=>{const r=await request('/v1/session');if(r.ok)csrf.current=text(record(await json(r)).csrf_token);else if(r.status!==401)throw new Error('status_unavailable');};
  const checked=async(response:Response)=>{const value=await json(response);if(!response.ok){const code=String(record(value).code);throw new Error(messages[code]?code:'status_unavailable');}return value;};
  const refresh=async(orderId=order)=>{
    if(!orderId)return null;
    const value=readStatus(await checked(await request('/v1/checkouts/'+id(orderId))),orderId);
    if(current.current?.id===value.id && BigInt(value.version)<BigInt(current.current.version))throw new Error('status_regressed');
    current.current=value;setState(value);
    try{const saved=await new BrowserJournal(orderId).read();setStage(saved.stage);setPreparedHash(saved.quote?.quote_hash??'');}catch{setStage('missing');setPreparedHash('');}
    return value;
  };
  const act=async(operation:()=>Promise<void>)=>{
    if(busy.current)return;busy.current=true;setError('');
    try{await operation();}catch(e){const code=e instanceof Error?e.message:'';setError(messages[code]?code:'uncertain');}
    finally{busy.current=false;setPhase('idle');}
  };
  useEffect(()=>discover(w=>setWallets(old=>old.some(x=>x.uuid===w.uuid)||old.length>=12?old:[...old,w])),[]);
  useEffect(()=>{
    void act(async()=>{await session();if(initialOrder)await refresh(initialOrder);else{
      const productId=id(path[2]);setItem(product(await checked(await request('/v1/catalog/'+productId))));
    }});
  },[]);
  useEffect(()=>{
    if(!order)return;
    const timer=setInterval(()=>{setNow(Date.now());if(!busy.current)void refresh().catch(e=>setError(e instanceof Error && e.message==='UNAUTHENTICATED'?'UNAUTHENTICATED':'uncertain'));},3000);
    return()=>clearInterval(timer);
  },[order]);
  useEffect(()=>{
    if(!wallet)return;
    const change=()=>{generation.current++;setBalance(null);setError('wallet_context_changed');};
    wallet.provider.on('accountsChanged',change);wallet.provider.on('chainChanged',change);wallet.provider.on('disconnect',change);
    return()=>{wallet.provider.removeListener('accountsChanged',change);wallet.provider.removeListener('chainChanged',change);wallet.provider.removeListener('disconnect',change);};
  },[wallet]);
  const policy=(s:Status,q=s.quote):Policy=>({origin,productId:s.product.id,productVersion:s.product.version,maxAtomic:q?.total_atomic??'0',
    payees:q?[q.payee]:[],network:NETWORK,token:TOKEN,policyVersion:s.policy_version,policyURLs:s.policy_urls});
  const begin=()=>act(async()=>{
    if(!item)return;setPhase('creating');await session();
    const r=readCreated(await checked(await request('/v1/checkouts','POST',{product_id:item.id,product_version:item.version,quantity:1,client_kind:'browser'},{'X-Dispatch-Intent':'checkout'})));
    const orderId=id(r.id);history.replaceState(null,'','/checkout/'+orderId);setOrder(orderId);
    await session();const s=await refresh(orderId);if(!s)throw new Error('status_unavailable');
    await new BrowserJournal(orderId).initialize({order:orderId,origin,policy:policy(s),stage:'ready',confirmed:true,payKey:crypto.randomUUID()});setStage('ready');
  });
  const getQuote=()=>act(async()=>{
    if(!terms)return;setPhase('quoting');const s=await refresh();if(!s || s.payment_state!=='none' || !['draft','quoted'].includes(s.order_state))throw new Error('purchase_changed');
    const journal=new BrowserJournal(order),saved=await journal.read();if(!['ready','rejected'].includes(saved.stage))throw new Error('uncertain');
    await checked(await request('/v1/checkouts/'+order+'/quote','POST',{product_version:s.product.version,quantity:1,policy_version:s.policy_version},{'Idempotency-Key':crypto.randomUUID()}));
    const next=await refresh();if(!next?.quote)throw new Error('status_unavailable');
    await journal.save({...saved,policy:policy(next),quote:next.quote});setPreparedHash(next.quote.quote_hash);setNow(Date.now());
  });
  const checkWallet=async(chosen:Wallet)=>{setBalance(null);const c=await context(chosen.provider);setAccount(c.account);setBalance(c.balance);
    if(current.current?.quote && amount(c.balance)<amount(current.current.quote.total_atomic))throw new Error('insufficient_usdc');return c;};
  const connect=(chosen:Wallet)=>act(async()=>{
    setPicker(false);generation.current++;selected.current=chosen;setWallet(chosen);setPhase('connecting');setBalance(null);
    try{const accounts=await chosen.provider.request({method:'eth_requestAccounts'});setAccount(accounts[0]??'');}catch{throw new Error('connect_rejected');}
    await checkWallet(chosen);
  });
  const authorize=()=>act(async()=>{
    if(!navigator.locks || !wallet || !account || !terms)throw new Error('storage_unavailable');
    await navigator.locks.request('dispatch-pay-'+order,{ifAvailable:true},async lock=>{
      if(!lock)throw new Error('uncertain');
      const s=await refresh();if(!s?.quote || !purchasable(s))throw new Error('purchase_changed');
      const q=s.quote,chosen=wallet,epoch=generation.current,c=await checkWallet(chosen);
      if(c.account!==account)throw new Error('wallet_context_changed');
      const guard=async()=>{
        if(generation.current!==epoch || selected.current!==chosen)throw new Error('wallet_context_changed');
        const checked=await context(chosen.provider);
        if(checked.account!==c.account || generation.current!==epoch)throw new Error('wallet_context_changed');
        if(amount(checked.balance)<amount(q.total_atomic))throw new Error('insufficient_usdc');
      };
      const signer=injectedSigner(chosen.provider,{account:c.account as `0x${string}`,token:TOKEN as `0x${string}`,payee:q.payee as `0x${string}`,
        amount:q.total_atomic,domainName:'USD Coin',domainVersion:'2',quoteExpiresAt:Math.floor(Date.parse(q.expires_at)/1000)});
      const base='/v1/checkouts/'+order;
      const fetcher=transport(origin,new Map([[base,new Set(['GET'])],[base+'/pay',new Set(['POST'])]]),fetch.bind(window),'same-origin');
      setPhase('checking');
      try{await payOnce({journal:new BrowserJournal(order),signer,fetch:fetcher,headers:{'X-CSRF-Token':csrf.current},guard,onStage:setPhase});}
      finally{await refresh();}
    });
  });
  const saveRecovery=()=>act(async()=>{
    const result=await checked(await request('/v1/orders/'+order+'/recovery','POST',{}, {'Idempotency-Key':crypto.randomUUID()}));
    const blob=new Blob([JSON.stringify(result)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='dispatch-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setError('recovery_saved');
  });
  const importRecovery=(file:File|undefined)=>act(async()=>{
    if(!file || file.size>2048)throw new Error('invalid_recovery');
    const saved=record(JSON.parse(await file.text()));if(saved.origin!==origin || saved.version!==1)throw new Error('invalid_recovery');
    const orderId=id(saved.order_id);await session();
    const result=record(await checked(await request('/v1/recovery/import','POST',{capability:text(saved.capability)},{'X-Dispatch-Intent':'recovery'})));
    csrf.current=text(result.csrf_token);history.replaceState(null,'','/checkout/'+orderId);setOrder(orderId);await refresh(orderId);
  });
  const closeDraft=()=>act(async()=>{
    const saved=await new BrowserJournal(order).read();if(!['ready','rejected'].includes(saved.stage))throw new Error('uncertain');
    const s=await refresh();if(!s || s.payment_state!=='none')throw new Error('uncertain');
    await checked(await request('/v1/checkouts/'+order+'/cancel','POST',{}, {'Idempotency-Key':crypto.randomUUID()}));
    location.assign('/buy/'+s.product.id);
  });
  const q=state?.quote,paid=state?.payment_state==='settled',review=state?.order_state==='review_required'||state?.payment_state==='review_required';
  const pending=!!state && state.payment_state!=='none' && !paid;
  const uncertain=['signing','signed','missing'].includes(stage),expired=!!q&&Date.parse(q.expires_at)<=now;
  const inProgress=phase!=='idle'&&phase!=='loading';
  let title='Review your purchase',detail='Pay directly to the merchant with USDC on Base.';
  if(review){title='Payment needs review';detail='The merchant is reviewing this order. Check status; do not pay again.';}
  else if(paid){title='Payment confirmed';detail=state?.delivery.state==='available'?'Your payment was verified. Your file is ready.':['blocked','revoked'].includes(state?.delivery.state??'')?'Your payment is recorded. File access is '+state?.delivery.state+'.':'Your payment was verified. File delivery is still pending.';}
  else if(pending){title='Checking your payment';detail='The outcome is being checked. Do not authorize another payment.';}
  else if(phase==='awaiting_wallet'){title='Review in your wallet';detail='Check the exact amount and recipient before approving.';}
  else if(phase==='submitting'){title='Saving your payment';detail='Keep this checkout to follow the outcome. A signature is not a confirmed payment.';}
  else if(uncertain){title='Check this order’s status';detail='A previous authorization may exist. This checkout will not request a new signature.';}
  else if(expired){title='Price window expired';detail='Review an updated quote before authorizing payment.';}
  const merchant=state?.merchant_name??item?.merchant_name??'Merchant checkout',name=state?.product.title??item?.title??'Loading product…';
  const policies=q?.policy_urls??state?.policy_urls??item?.policy_urls??[];
  const safePolicies=policies.filter(u=>{try{const x=new URL(u);return x.protocol==='https:'&&!x.username&&!x.password;}catch{return false;}});
  return <><header className="top"><a href={item?.purchase_path??'/buy/'+(state?.product.id??'')} className="brand">Dispatch <span>Checkout</span></a><span className="environment">Local preview · no real funds</span></header>
    <main><div className="intro"><p className="eyebrow">{merchant}</p><h1>{title}</h1><p>{detail}</p></div>
    <div className="layout"><section className="card summary" aria-labelledby="product-title"><span className="eyebrow">Digital product · quantity 1</span><h2 id="product-title">{name}</h2><p className="description">{state?.product.description??item?.description}</p>
      <div className="amount"><span>{q?(paid?'Total paid':'Total due'):'Indicative price'}</span><strong>{q?formatUSDC(q.total_atomic):item?formatUSDC(item.indicative_amount_atomic):'—'} <small>USDC</small></strong></div>
      {q&&<dl className="breakdown"><div><dt>Product</dt><dd>{formatUSDC(q.unit_atomic)} USDC</dd></div><div><dt>Tax</dt><dd>{q.tax_status==='tax_included'?'Included':'Merchant-attested zero'}</dd></div><div><dt>Tax source</dt><dd>{q.tax_source} · {q.tax_version}</dd></div><div><dt>Shipping</dt><dd>Not applicable</dd></div></dl>}
      <p className="subtle">{q?'This total is fixed for the displayed price window.':'Review an authoritative quote before payment. No wallet action occurs when you open this page.'}</p>
      <div className="network"><span className="dot"/>USDC on Base <span>EOA wallet</span></div>
      {q&&<><p className="label">Merchant recipient</p><code className="address">{q.payee}</code><p className="subtle">Quote expires {new Date(q.expires_at).toLocaleTimeString()}. Token: <span className="address">{TOKEN}</span></p></>}
    </section><section className="card payment" aria-labelledby="payment-title"><h2 id="payment-title">{paid?'Payment & delivery':'Payment details'}</h2>
      <div role="status" aria-live="polite" className={'status '+(paid?'confirmed':'')}><strong>{title}</strong><p>{detail}</p></div>
      {error&&<div role="alert" className="notice">{error==='recovery_saved'?'Recovery file saved. Store it privately; it grants access to this order.':messages[error]??'This action could not be completed. Check status or contact the merchant.'}</div>}
      {paid&&<div className="delivery"><strong>File delivery: {state?.delivery.state==='available'?'available':['blocked','revoked'].includes(state?.delivery.state??'')?state?.delivery.state:'pending'}</strong>{state?.delivery.download_path?<><p>{state.delivery.file_name} · {state.delivery.size_bytes} bytes. Availability does not confirm you have downloaded or read this file.</p><a className="secondary" href={state.delivery.download_path} download>Download file</a><p>You can download again from this order if the response is interrupted.</p></>:<p>{state?.delivery.state==='revoked'?'File access has been revoked. Previously downloaded copies are not removed.':state?.delivery.state==='blocked'?'File access is temporarily blocked. Check status or contact the merchant.':'Delivery has not completed. Keep this order for status and recovery.'}</p>}</div>}
      {paid&&state?.merchant_handoff&&state.merchant_handoff.state!=='not_configured'&&<p>Merchant handoff: {state.merchant_handoff.state}. This is not shipment evidence.</p>}
      {!order&&<button className="primary" disabled={inProgress||!item?.available} onClick={begin}>{inProgress?'Starting checkout…':item?.available?'Begin checkout':'USDC checkout unavailable'}</button>}
      {state&&!paid&&!pending&&!review&&!uncertain&&<>
        <label className="consent"><input type="checkbox" checked={terms} onChange={e=>setTerms(e.target.checked)}/>I have reviewed the purchase terms for {state.policy_version}.</label>
        {(!q||expired||preparedHash!==q.quote_hash)&&<button className="primary" disabled={!terms||inProgress} onClick={getQuote}>{phase==='quoting'?'Getting quote…':'Review exact quote'}</button>}
        {q&&!expired&&preparedHash===q.quote_hash&&<>
          <p className="label">Selected wallet</p><div className="wallet"><strong>{wallet?.name??'No wallet connected'}</strong><span className="address">{account||'Choose your wallet to continue'}</span>{balance!==null&&<span>Available: {formatUSDC(balance)} USDC</span>}</div>
          <button ref={walletTrigger} className="secondary" disabled={inProgress} onClick={()=>{setPicker(true);window.dispatchEvent(new Event('eip6963:requestProvider'));}}>{wallet?'Choose another wallet':'Connect a wallet'}</button>
          {wallet&&<button className="text-button" disabled={inProgress} onClick={()=>act(async()=>{await checkWallet(wallet);})}>Check wallet & balance</button>}
          {wallet&&error==='wrong_network'&&<button className="secondary" disabled={inProgress} onClick={()=>act(async()=>{await wallet.provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x2105'}]});await checkWallet(wallet);})}>Switch to Base</button>}
          <button className="primary" onClick={authorize} disabled={inProgress||!terms||!wallet||balance===null||amount(balance)<amount(q.total_atomic)}>{phase==='awaiting_wallet'?'Awaiting wallet approval…':phase==='submitting'?'Submitting…':`Authorize ${formatUSDC(q.total_atomic)} USDC`}</button>
          <p className="subtle">An authorization starts payment checking. Only verified server status confirms payment.</p>
        </>}
      </>}
      {order&&<div className="recovery"><button className="secondary" onClick={()=>act(async()=>{await refresh();})} disabled={inProgress}>Check payment status</button>
        {state&&<button className="text-button" onClick={saveRecovery} disabled={inProgress}>Save recovery file</button>}
        {state&&state.payment_state==='none'&&!uncertain&&<button className="text-button" onClick={closeDraft} disabled={inProgress}>Close unpaid checkout</button>}
      </div>}
      <details><summary>Recover a checkout</summary><p className="subtle">Import the private recovery file you saved. Payment IDs, signatures and transaction hashes are not access credentials.</p><label className="file-label">Recovery file<input type="file" accept="application/json,.json" disabled={inProgress} onChange={e=>void importRecovery(e.target.files?.[0])}/></label></details>
    </section></div>
    <footer><div><strong>Purchase terms</strong>{safePolicies.map((url,i)=><a key={url} href={url} target="_blank" rel="noreferrer">View policy {i+1} ↗</a>)}</div><p>Questions about this order? Contact the merchant through their purchase policies. Rabby and MetaMask are candidate EOA wallets; real extension verification is pending.</p></footer>
    </main><Dialog.Root open={picker} onOpenChange={setPicker}><Dialog.Portal><Dialog.Overlay className="overlay"/><Dialog.Content className="dialog" onCloseAutoFocus={event=>{event.preventDefault();walletTrigger.current?.focus();}}><Dialog.Title>Choose your wallet</Dialog.Title><Dialog.Description>Connection does not authorize payment. Select the wallet you intend to use.</Dialog.Description>
      {wallets.length?wallets.map(w=><button className="wallet-option" key={w.uuid} onClick={()=>void connect(w)}>Connect {w.name}</button>):<p>No injected wallet is available. Open your EOA wallet extension, then try discovery again, or use the merchant’s existing checkout.</p>}
      <button className="secondary" onClick={()=>window.dispatchEvent(new Event('eip6963:requestProvider'))}>Find wallets again</button><Dialog.Close className="text-button">Cancel</Dialog.Close>
    </Dialog.Content></Dialog.Portal></Dialog.Root></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname.startsWith('/operator')?<OperatorApp/>:<App/>}</React.StrictMode>);
