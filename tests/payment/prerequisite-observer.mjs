// Test-only, read-only observations. Never persist credentials, request bodies or headers.
import {appendFile} from 'node:fs/promises';
export function observePrerequisites({commerce,rpc,admin,origin}) {
  let latest=null,stage=null,preacceptCalls=0;
  const reason=error=>['invalid_snapshot_window','stale_snapshot','snapshot_digest_mismatch','support_unavailable','preaccept_unusable','preaccept_conflict_or_non_eoa','not_ready','missing_block'].includes(error.message)?error.message:'unclassified_error';
  const preaccept=rpc.preaccept.bind(rpc);
  rpc.preaccept=async(...args)=>{const started=Date.now();preacceptCalls++;try {const value=await preaccept(...args);latest={started,finished:Date.now(),chainId:value.chainId,block:String(value.block),hash:value.hash,chainTime:String(value.chainTime),observedAt:value.observedAt,nonceUsed:value.nonceUsed,token:value.token,domainName:value.domainName,domainVersion:value.domainVersion,decimals:value.decimals,domainSeparator:value.domainSeparator};return value;}catch(error){latest={started,finished:Date.now(),error:reason(error)};throw error;}};
  for(const name of ['snapshot','readiness','create']) {
    const original=commerce[name].bind(commerce);
    commerce[name]=async(...args)=>{try {return await original(...args);}catch(error){stage={operation:name,reason:reason(error),wall:Date.now(),preacceptCalls,latest};await record({kind:'application_refusal',...stage});throw error;}};
  }
  async function record(value){
    const db=(await admin.query(`SELECT clock_timestamp() AS wall,
      (SELECT row_to_json(c) FROM (SELECT payment_paused,fulfillment_paused,mainnet_enabled,physical_enabled FROM merchant_control) c) AS controls,
      (SELECT json_agg(h) FROM (SELECT service,checked_at FROM runtime_health) h) AS health,
      (SELECT json_agg(s) FROM (SELECT fetched_at,expires_at FROM provider_capability_snapshots ORDER BY fetched_at DESC LIMIT 2) s) AS support,
      (SELECT json_agg(a) FROM (SELECT window_start,count FROM abuse_counters) a) AS counters`)).rows[0];
    let failureTimeHead;
    try {const b=await rpc.client.getBlock({blockTag:'latest'});failureTimeHead={block:String(b.number),hash:b.hash,chainTime:String(b.timestamp),observedAt:Date.now()};}catch{failureTimeHead={error:'observation_unavailable'};}
    const entry={...value,db,failure_time_head_separate_from_original_read:failureTimeHead,recorded_at:Date.now()};
    await appendFile(process.env.DISPATCH_BUYER_EVIDENCE+'/prerequisite-observations.jsonl',JSON.stringify(entry)+'\n');
    console.log('PREREQUISITE_OBSERVATION',JSON.stringify(entry));
  }
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    const response=await originalFetch(input,options);
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(url===origin+'/v1/checkouts'&&(options?.method??input?.method)==='POST'&&!response.ok)
      await record({kind:'http_refusal',status:response.status,body:await response.clone().text(),wall:Date.now(),stage,latest});
    return response;
  };
}
