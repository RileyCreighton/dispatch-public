import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setup,teardown,admin,policy,newSigner,support} from './fixtures.mjs';
import {createPurchase,authorizePurchase,resumePurchase} from '../../dist/examples/agent/src/purchase.js';
import {FileJournal} from '../../dist/examples/agent/src/journal.js';
test.before(setup);test.after(teardown);
test('R5-S a losing live claimant cannot prevent the winning signature from being durably saved',async()=>{
 await support();const directory=process.env.DISPATCH_DB_HOST+'/scheduled-'+randomUUID(),journal=await createPurchase(policy(),directory),p=await journal.read(),account=await newSigner();
 let bothReached,claimed,loserHeld,releaseLoser;const both=new Promise(r=>bothReached=r),winner=new Promise(r=>claimed=r),held=new Promise(r=>loserHeld=r),release=new Promise(r=>releaseLoser=r);
 const original=FileJournal.prototype.claimSigning;let claims=0,signs=0,sends=0,originalPayload;const schedule=[];
 const transport=async(input,init)=>{const req=new Request(input,init);if(req.headers.has('PAYMENT-SIGNATURE')){sends++;originalPayload=JSON.parse(Buffer.from(req.headers.get('PAYMENT-SIGNATURE'),'base64').toString());assert.deepEqual((await new FileJournal(directory).read()).payment,originalPayload);}return fetch(req);};
 class PausedLoser extends FileJournal{async read(){const v=await super.read();schedule.push('loser read signing stage before permanent-claim attempt; no mutation lock');loserHeld();await release;return v;}}
 // Reviewer scheduling seam only: preserve original claim implementation and real file operations.
 // Both calls already passed the pre-claim guards. Delay loser at the legitimate read await, now outside mutation coordination.
 FileJournal.prototype.claimSigning=async function(){const index=++claims;if(index===1){await both;await original.call(this);schedule.push('winner durable claim');claimed();}else{bothReached();await winner;return original.call(new PausedLoser(this.directory));}};
 const signer={address:account.address,async signTypedData(d){await held;signs++;schedule.push('winner signs while losing live claimant is paused outside mutation coordination');return account.signTypedData(d);}};
 let results;
 try{const calls=[authorizePurchase(directory,policy(),signer,transport),authorizePurchase(directory,policy(),signer,transport)].map(p=>p.finally(()=>releaseLoser()));
 results=await Promise.allSettled(calls);
 }finally{FileJournal.prototype.claimSigning=original;releaseLoser();}
 const saved=await journal.read(),attempts=Number((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[p.order])).rows[0].n);
 let resigns=0;const resumed=await authorizePurchase(directory,policy(),{address:account.address,async signTypedData(){resigns++;throw Error('must_not_resign');}},transport);
 const report={scheduling_only:true,actual_corrected_claim_and_save:true,schedule,signs,sends,attempts,journal_stage:saved.stage,payload_saved:!!saved.payment,resume_payment_state:resumed.payment_state,resume_signs:resigns,results:results.map(r=>({status:r.status,...(r.status==='rejected'?{error:String(r.reason?.message).replaceAll(directory,'<fixture-journal>')}: {})}))};
 await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/scheduled-concurrency.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 assert.equal(signs,1);assert.equal(resigns,0);assert.equal(sends,1);assert.deepEqual(saved.payment,originalPayload);assert.equal(saved.order,p.order);assert.equal(saved.payKey,p.payKey);assert.deepEqual(saved.quote,p.quote);assert.equal(saved.stage,'signed');assert.equal(attempts,1,'winning live caller lost its signed payload to the losing claimant mutation lock');
});

test('B5-C1 process competition exercises claim, sign, durable save and initial API send',async()=>{
 await support();await admin.query('TRUNCATE abuse_counters');
 const directory=process.env.DISPATCH_DB_HOST+'/process-'+randomUUID(),journal=await createPurchase(policy(),directory),before=await journal.read();
 const {fork}=await import('node:child_process');const children=[];
 try{
  const report=[];
  const runners=[];
  try {
   for(let index=0;index<4;index++) {
    const child=fork('tests/buyer/journal-purchase-child.mjs',[],{stdio:['ignore','pipe','pipe','ipc'],env:process.env});children.push(child);
    const events={index,pid:child.pid,stdout:'',stderr:'',progress:[]};report.push(events);
    let fundedResolve,readyResolve,doneResolve,exitResolve;
    const funded=new Promise(r=>fundedResolve=r),ready=new Promise(r=>readyResolve=r),done=new Promise(r=>doneResolve=r),exited=new Promise(r=>exitResolve=r);
    child.stdout.on('data',d=>events.stdout+=d);child.stderr.on('data',d=>events.stderr+=d);
    child.on('message',m=>{events.progress.push(m);if(m.funded)fundedResolve();else if(m.ready)readyResolve();else doneResolve(m);});
    child.on('error',e=>{events.error=e.message;exitResolve({code:null,signal:null,error:e.message});});
    child.on('exit',(code,signal)=>{events.exit={code,signal};exitResolve({code,signal});});
    const stage=async(p,name)=>{
     let timer;try{return await Promise.race([p,exited.then(e=>{throw Error('child exited before '+name+': '+JSON.stringify(e));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('child stalled before '+name)),30000);})]);}finally{clearTimeout(timer);}
    };
    child.send({directory,approved:policy(),diagnosticExit:process.env.DISPATCH_CONTENTION_DIAGNOSTIC_EXIT==='before-ready'&&index===2});runners.push({child,ready,done,exited,stage});
    // Only fixture minting shares a relayer nonce. No journal claim is released until all four processes wait there.
    await stage(funded,'fixture funding');
   }
   await Promise.all(runners.map(r=>r.stage(r.ready,'claim barrier')));
   assert.equal(report.filter(r=>r.progress.some(m=>m.ready)).length,4);
   for(const r of runners)r.child.send({go:true});
   const results=await Promise.all(runners.map(r=>r.stage(r.done,'outcome')));
   const exits=await Promise.all(runners.map(r=>r.exited));for(const e of exits)assert.deepEqual(e,{code:0,signal:null});
  assert.equal(results.reduce((n,r)=>n+r.signs,0),1);assert.equal(results.reduce((n,r)=>n+r.sends,0),1);
  const saved=await new FileJournal(directory).read();assert.equal(saved.stage,'signed');assert.ok(saved.payment);assert.deepEqual(saved.quote,before.quote);assert.equal(saved.order,before.order);assert.equal(saved.payKey,before.payKey);
  assert.equal(Number((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[before.order])).rows[0].n),1);
  await authorizePurchase(directory,policy(),{address:saved.payment.payload.authorization.from,async signTypedData(){assert.fail('resume signed');}},async(input,init)=>{const req=new Request(input,init);assert.equal(req.headers.has('PAYMENT-SIGNATURE'),false);return fetch(req);});
  await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/process-contention.json',JSON.stringify({results,signs:1,sends:1,attempts:1,exact_payload_persisted_before_send:true,resume_no_sign_or_send:true})+'\n');
  }finally{
   for(const r of runners)if(r.child.exitCode===null&&r.child.signalCode===null)r.child.kill('SIGKILL');
   await Promise.all(runners.map(r=>r.exited));
   await writeFile(process.env.DISPATCH_BUYER_EVIDENCE+'/process-contention-children.json',JSON.stringify(report,null,2)+'\n');
  }
 }finally{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill('SIGKILL');}
});

for(const operation of ['writeFile','sync'])test('B5-C1 failed payload '+operation+' forbids signed send and resumed signing',async()=>{
 await support();await admin.query('TRUNCATE abuse_counters');
 const {open,readlink}=await import('node:fs/promises');
 const directory=process.env.DISPATCH_DB_HOST+'/failure-'+randomUUID(),journal=await createPurchase(policy(),directory),account=await newSigner();
 const h=await open(directory+'/journal.key','r'),proto=Object.getPrototypeOf(h),original=proto[operation];await h.close();let armed=false,failures=0,sends=0,signs=0;
 proto[operation]=async function(...args){const path=await readlink('/proc/self/fd/'+this.fd);if(armed&&path.startsWith(directory+'/write-')){failures++;throw Error('injected_payload_'+operation);}return original.apply(this,args);};
 try{await assert.rejects(authorizePurchase(directory,policy(),{address:account.address,async signTypedData(data){signs++;const signature=await account.signTypedData(data);armed=true;return signature;}},async(input,init)=>{const req=new Request(input,init);if(req.headers.has('PAYMENT-SIGNATURE'))sends++;return fetch(req);}));}
 finally{proto[operation]=original;}
 assert.equal(failures,1);assert.equal(signs,1);assert.equal(sends,0);assert.equal((await journal.read()).stage,'signing');assert.equal((await journal.read()).payment,undefined);
 await authorizePurchase(directory,policy(),{address:account.address,async signTypedData(){assert.fail('failed persistence reopened signing');}});
 assert.equal(Number((await admin.query('SELECT count(*) n FROM payment_attempts WHERE order_id=$1',[(await journal.read()).order])).rows[0].n),0);
});

test('B5-C1 signed purchase quote, credential, order and exact payload remain immutable',async()=>{
 await support();await admin.query('TRUNCATE abuse_counters');
 const directory=process.env.DISPATCH_DB_HOST+'/immutable-'+randomUUID(),journal=await createPurchase(policy(),directory);await authorizePurchase(directory,policy(),await newSigner());const saved=await journal.read();
 for(const change of [{order:randomUUID()},{quote:{...saved.quote,id:randomUUID()}},{credential:'replacement'},{payKey:randomUUID()},{payment:{...saved.payment,payload:{fixture:'replacement'}}}])await assert.rejects(new FileJournal(directory).save({...saved,...change}),/journal_regression/);
 assert.deepEqual(await journal.read(),saved);
});
