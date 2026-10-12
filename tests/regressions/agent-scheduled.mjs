import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setup,teardown,admin,policy,newSigner,support} from '../buyer/fixtures.mjs';
import {createPurchase,authorizePurchase,resumePurchase} from '../../dist/examples/agent/src/purchase.js';
import {FileJournal} from '../../dist/examples/agent/src/journal.js';
test.before(setup);test.after(teardown);
test('R5-S a losing live claimant cannot prevent the winning signature from being durably saved',async()=>{
 await support();const directory=process.env.DISPATCH_DB_HOST+'/scheduled-'+randomUUID(),journal=await createPurchase(policy(),directory),p=await journal.read(),account=await newSigner();
 let bothReached,claimed,loserHeld,releaseLoser;const both=new Promise(r=>bothReached=r),winner=new Promise(r=>claimed=r),held=new Promise(r=>loserHeld=r),release=new Promise(r=>releaseLoser=r);
 const original=FileJournal.prototype.claimSigning;let claims=0,signs=0;const schedule=[];
 class PausedLoser extends FileJournal{async read(){const v=await super.read();schedule.push('loser read signing stage while holding mutation.lock');loserHeld();await release;return v;}}
 // Reviewer scheduling seam only: preserve original claim implementation and real file operations.
 // Both calls already passed the pre-claim guards. Delay loser at the legitimate read await.
 FileJournal.prototype.claimSigning=async function(){const index=++claims;if(index===1){await both;await original.call(this);schedule.push('winner durable claim');claimed();}else{bothReached();await winner;return original.call(new PausedLoser(this.directory));}};
 const signer={address:account.address,async signTypedData(d){await held;signs++;schedule.push('winner signs while losing live claim holds mutation.lock');return account.signTypedData(d);}};
 let results;
 try{const calls=[authorizePurchase(directory,policy(),signer),authorizePurchase(directory,policy(),signer)].map(p=>p.finally(()=>releaseLoser()));
 results=await Promise.allSettled(calls);
 }finally{FileJournal.prototype.claimSigning=original;releaseLoser();}
 const saved=await journal.read(),attempts=Number((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[p.order])).rows[0].n);
 let resigns=0;const resumed=await authorizePurchase(directory,policy(),{address:account.address,async signTypedData(){resigns++;throw Error('must_not_resign');}});
 const report={scheduling_only:true,original_claim_and_save_unchanged:true,schedule,signs,attempts,journal_stage:saved.stage,payload_saved:!!saved.payment,resume_payment_state:resumed.payment_state,resume_signs:resigns,results:results.map(r=>({status:r.status,...(r.status==='rejected'?{error:String(r.reason?.message).replaceAll(directory,'<fixture-journal>')}: {})}))};
 await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/scheduled-concurrency.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 assert.equal(signs,1);assert.equal(resigns,0);assert.equal(attempts,1,'winning live caller lost its signed payload to the losing claimant mutation lock');
});
