import assert from 'node:assert/strict';
import {admin,newSigner,request,origin,fixture} from './fixtures.mjs';
export async function pageWithWallets(browser){
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),page=await context.newPage(),accounts=[await newSigner(),await newSigner()];let signs=0;
  await page.exposeFunction('__fixtureSign',async(index,data)=>{signs++;const confirmed=await admin.query(`SELECT count(*) n FROM buyer_grants WHERE confirmed_at IS NOT NULL`);assert.ok(Number(confirmed.rows[0].n)>0);return accounts[index].signTypedData(JSON.parse(data));});
  await page.exposeFunction('__fixtureRpc',async(method,params)=>request(method,params));
  await page.addInitScript(({addresses})=>{
    const state={mode:'normal',chain:'0x2105',addresses,accounts:[addresses[0]],balanceMode:'real',prompts:0,release:null};
    const providers=addresses.map((address,index)=>{const listeners={};return {
      on(name,fn){(listeners[name]??=[]).push(fn);},removeListener(name,fn){listeners[name]=(listeners[name]??[]).filter(f=>f!==fn);},
      emit(name,value){for(const fn of listeners[name]??[])fn(value);},
      async request({method,params}){
        if(method==='eth_chainId')return state.chain;
        if(method==='eth_accounts'){if(state.mode==='post_reject'&&state.prompts>0)throw {code:4001};return state.accounts.length?[address]:[];}
        if(method==='eth_requestAccounts'){if(state.mode==='connect_reject')throw {code:4001};return [address];}
        if(method==='wallet_switchEthereumChain'){state.chain='0x2105';this.emit('chainChanged',state.chain);return null;}
        if(method==='eth_call'){if(state.balanceMode==='unavailable')throw new Error('offline');if(state.balanceMode==='zero')return '0x'+'0'.repeat(64);return window.__fixtureRpc(method,params);}
        if(method==='eth_signTypedData_v4'){state.prompts++;if(state.mode==='reject')throw {code:4001};if(state.mode==='hold')await new Promise(r=>state.release=r);return window.__fixtureSign(index,params[1]);}
        throw new Error('unsupported fixture method');
      }};});
    window.__wallet={state,providers};
    window.addEventListener('eip6963:requestProvider',()=>providers.forEach((provider,index)=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:index?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111',name:index?'Fixture Wallet B':'Fixture Wallet A',icon:'data:image/svg+xml,<svg onload=alert(1)>',rdns:'untrusted.fixture'},provider}}))));
  },{addresses:accounts.map(a=>a.address)});
  return {context,page,accounts,signs:()=>signs};
}
export async function beginPage(page){const started=Date.now();await page.goto(origin+'/buy/'+fixture.product);await page.getByRole('button',{name:'Begin checkout',exact:true}).waitFor();void started;assert.equal(await page.evaluate(()=>window.__wallet?.state.prompts??0),0);await page.getByRole('button',{name:'Begin checkout',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Review exact quote',exact:true}).click();await page.getByRole('button',{name:'Connect a wallet',exact:true}).waitFor();return page.url().split('/').at(-1);}
export async function connectPage(page,name='Fixture Wallet A'){await page.getByRole('button',{name:/Connect a wallet|Choose another wallet/}).click();await page.getByRole('button',{name:'Connect '+name,exact:true}).click();await page.getByRole('button',{name:/^Authorize /}).waitFor();}
