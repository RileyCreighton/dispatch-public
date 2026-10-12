import type { EIP1193Provider } from 'viem';
import { encodeFunctionData, parseAbi } from 'viem';
import { address, TOKEN } from '../../../packages/buyer/src/contracts.js';
export type Wallet = {uuid:string;name:string;provider:EIP1193Provider};
export function discover(onWallet:(wallet:Wallet)=>void) {
  // EIP-6963 event boundary, with bounded text-only metadata; icons and RDNS claims are never rendered.
  const listener=(event:Event)=>{
    const detail=(event as CustomEvent<unknown>).detail;
    if(!detail || typeof detail!=='object')return;
    const d=detail as {info?:{uuid?:unknown;name?:unknown};provider?:EIP1193Provider};
    if(typeof d.info?.uuid!=='string' || !/^[a-f0-9-]{36}$/i.test(d.info.uuid) || typeof d.info.name!=='string' || typeof d.provider?.request!=='function')return;
    onWallet({uuid:d.info.uuid,name:d.info.name.slice(0,64).replace(/[\u0000-\u001f\u007f]/g,''),provider:d.provider});
  };
  window.addEventListener('eip6963:announceProvider',listener);window.dispatchEvent(new Event('eip6963:requestProvider'));
  return ()=>window.removeEventListener('eip6963:announceProvider',listener);
}
export async function context(provider:EIP1193Provider) {
  const [chain,accounts]=await Promise.all([provider.request({method:'eth_chainId'}),provider.request({method:'eth_accounts'})]);
  if(chain!=='0x2105')throw new Error('wrong_network');if(accounts.length!==1)throw new Error('wallet_disconnected');
  const account=address(accounts[0]);
  const data=encodeFunctionData({abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[account as `0x${string}`]});
  let balance:string;
  try{const raw=await provider.request({method:'eth_call',params:[{to:TOKEN as `0x${string}`,data},'latest']});
    if(!/^0x[0-9a-fA-F]{64}$/.test(raw))throw new Error('invalid_balance');balance=BigInt(raw).toString();
  }catch{throw new Error('balance_unavailable');}
  return {account,balance};
}
