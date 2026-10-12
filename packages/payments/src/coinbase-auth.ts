// Pinned public helper composition, never the SDK HTTP client or environment fallback.
import { createFacilitatorConfig } from '@coinbase/x402';
import type { FacilitatorConfig } from '@x402/core/server';
const endpoint='https://api.cdp.coinbase.com/platform/v2/x402';
export function coinbaseTransportConfig(input:{url:string;apiKeyId:string;apiKeySecret:string;disposableLoopback?:boolean}) {
  if(!input.apiKeyId || !input.apiKeySecret)throw new Error('explicit_auth_required');
  const url=new URL(input.url);
  const fixture=input.disposableLoopback===true;
  if(fixture ? (url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.pathname!=='/platform/v2/x402'
      || !!url.username || !!url.password || !!url.search || !!url.hash) : input.url!==endpoint)throw new Error('auth_endpoint_mismatch');
  const helper=createFacilitatorConfig(input.apiKeyId,input.apiKeySecret);
  if(helper.url!==endpoint || !helper.createAuthHeaders)throw new Error('auth_contract_changed');
  const callback=helper.createAuthHeaders;
  const createAuthHeaders:NonNullable<FacilitatorConfig['createAuthHeaders']>=async()=>{
    const raw=await callback();
    // Explicit projection; Correlation-Context/list never reach the wire.
    const select=(op:'verify'|'settle'|'supported')=>{
      const value=raw[op]?.Authorization;
      if(typeof value!=='string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(value) || value.length>8192)throw new Error('auth_contract_changed');
      return {Authorization:value};
    };
    return {verify:select('verify'),settle:select('settle'),supported:select('supported')};
  };
  return {url:input.url,createAuthHeaders,loopbackFixture:fixture};
}
