import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setup,teardown,admin,policy,newSigner,settle,support,origin} from '../buyer/fixtures.mjs';
import {createPurchase,authorizePurchase} from '../../dist/examples/agent/src/purchase.js';
const reports=[];
test.before(setup);
test.after(async()=>{await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/concurrency.json',JSON.stringify(reports,null,2)+'\n');await teardown();});
for(let iteration=1;iteration<=12;iteration++)test('R5-C concurrent actual agent authorization '+iteration,async()=>{
 await support();await admin.query('TRUNCATE abuse_counters');
 const directory=process.env.DISPATCH_DB_HOST+'/agent-review-'+randomUUID(),journal=await createPurchase(policy(),directory),saved=await journal.read(),signer=await newSigner();
 let signs=0;const trace=[];const transport=async(input,init)=>{const q=new Request(input,init),r=await fetch(q);trace.push({method:q.method,operation:new URL(q.url).pathname.endsWith('/pay')?'pay':'status',signed:q.headers.has('PAYMENT-SIGNATURE'),status:r.status,...(r.status>=400&&r.status!==402?{error:(await r.clone().json()).code}:{})});return r;};
 const boundary={address:signer.address,async signTypedData(d){signs++;return signer.signTypedData(d);}};
 const results=await Promise.allSettled([authorizePurchase(directory,policy(),boundary,transport),authorizePurchase(directory,policy(),boundary,transport)]);
 const n=Number((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[saved.order])).rows[0].n),j=await journal.read();
 const report={iteration,signs,attempts:n,journal_stage:j.stage,payload_saved:!!j.payment,results:results.map(r=>({status:r.status,...(r.status==='rejected'?{name:r.reason?.name,code:r.reason?.code,message:String(r.reason?.message).replaceAll(directory,'<fixture-journal>')}: {})})),trace};
 reports.push(report);console.log(JSON.stringify(report));assert.equal(signs,1);assert.equal(n,1);await settle(saved.order);
});
