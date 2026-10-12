import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {FileJournal} from '../../dist/examples/agent/src/journal.js';
function start(directory){const p=spawn(process.execPath,[new URL('./claim-child.mjs',import.meta.url).pathname,directory],{stdio:['ignore','pipe','pipe'],timeout:10000,env:{PATH:process.env.PATH,LC_ALL:'C'}});let output='',errors='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>errors+=d);const done=once(p,'close').then(([code])=>{assert.equal(code,0,errors);return output;});return {done};}
function record(){return {order:randomUUID(),origin:'https://fixture.invalid',policy:{origin:'https://fixture.invalid',productId:randomUUID(),productVersion:1,maxAtomic:'100',payees:['0x'+'22'.repeat(20)],network:'eip155:8453',token:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',policyVersion:'policy-1',policyURLs:['https://fixture.invalid/policy/1']},confirmed:true,stage:'ready',payKey:randomUUID()};}
test('JOURNAL-01 six independent processes claim exactly one durable signing right; stale saves and changed original payload fail',async()=>{
 const base=await mkdtemp('/tmp/dispatch-b4-review-journal-');try{const dir=base+'/journal',journal=new FileJournal(dir),initial=record();await journal.initialize(initial);
 const children=Array.from({length:6},()=>start(dir));
 const results=await Promise.all(children.map(x=>x.done));assert.equal(results.filter(x=>x.includes('claimed')).length,1,JSON.stringify(results));
 assert.equal((await new FileJournal(dir).read()).stage,'signing');await assert.rejects(journal.save(initial),/journal_regression/);
 const payment={x402Version:2,payload:{fixture:'original-disposable-payload'}};await journal.save({...await journal.read(),stage:'signed',payment});
 await assert.rejects(journal.save({...await journal.read(),payment:{x402Version:2,payload:{fixture:'replacement'}}}),/journal_regression/);
 assert.deepEqual((await new FileJournal(dir).read()).payment,payment);
 }finally{await rm(base,{recursive:true,force:true});}
});
test('JOURNAL-02 crash-held mutation marker preserves the original purchase and denies new claims',async()=>{
 const base=await mkdtemp('/tmp/dispatch-b4-review-journal-');try{const journal=new FileJournal(base+'/journal');await journal.initialize(record());const before=await journal.read();
 await writeFile(base+'/journal/mutation.lock','disposable interrupted writer',{mode:0o600,flag:'wx'});
 await assert.rejects(journal.claimSigning());await assert.rejects(journal.save({...before,stage:'signed'}));assert.deepEqual(await journal.read(),before);
 }finally{await rm(base,{recursive:true,force:true});}
});
