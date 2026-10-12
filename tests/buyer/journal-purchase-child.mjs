import assert from 'node:assert/strict';
import {once} from 'node:events';
import {FileJournal} from '../../dist/examples/agent/src/journal.js';
import {authorizePurchase} from '../../dist/examples/agent/src/purchase.js';
import {newSigner,pools} from './fixtures.mjs';
const [input]=await once(process,'message');if(input.diagnosticExit)process.exit(23);const account=await newSigner();process.send({funded:true});let signs=0,sends=0;
const original=FileJournal.prototype.claimSigning;
FileJournal.prototype.claimSigning=async function(){const go=once(process,'message');process.send({ready:true});await go;return original.call(this);};
try{
 await authorizePurchase(input.directory,input.approved,{address:account.address,async signTypedData(data){signs++;return account.signTypedData(data);}},async(inputRequest,init)=>{
  const req=new Request(inputRequest,init);if(req.headers.has('PAYMENT-SIGNATURE')){sends++;const payload=JSON.parse(Buffer.from(req.headers.get('PAYMENT-SIGNATURE'),'base64').toString());assert.deepEqual((await new FileJournal(input.directory).read()).payment,payload);}return fetch(req);
 });process.send({signs,sends,outcome:'completed'});
}catch(error){process.send({signs,sends,outcome:'refused',code:error.code??'guard'});}
finally{for(const pool of pools)await pool.end();process.disconnect();}
