import type { Journal, PurchaseRecord } from '../../../packages/buyer/src/client.js';
function database():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{const req=indexedDB.open('dispatch-buyer',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('purchases',{keyPath:'order'});
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(new Error('storage_unavailable'));
  });
}
export class BrowserJournal implements Journal {
  constructor(readonly order:string){}
  async read():Promise<PurchaseRecord> {
    const db=await database();try{return await new Promise((resolve,reject)=>{
      const req=db.transaction('purchases').objectStore('purchases').get(this.order);
      req.onsuccess=()=>req.result?resolve(req.result as PurchaseRecord):reject(new Error('journal_missing'));req.onerror=()=>reject(new Error('storage_unavailable'));
    });}finally{db.close();}
  }
  private async change(update:(old:PurchaseRecord|undefined)=>PurchaseRecord):Promise<void> {
    const db=await database();try{await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('purchases','readwrite',{durability:'strict'}),store=tx.objectStore('purchases'),req=store.get(this.order);
      req.onsuccess=()=>{try{const next=update(req.result as PurchaseRecord|undefined);
        if(next.credential || next.order!==this.order)throw new Error('browser_capability_refused');store.put(next);
      }catch{tx.abort();}};
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(new Error('journal_transition_refused'));tx.onerror=()=>reject(new Error('storage_unavailable'));
    });}finally{db.close();}
  }
  async initialize(value:PurchaseRecord){await this.change(old=>{if(old)throw new Error('already_exists');return value;});}
  async save(value:PurchaseRecord){await this.change(old=>{
    if(!old || (old.stage==='signed' && value.stage!=='signed') || (old.stage==='signing' && !['signing','signed'].includes(value.stage)))throw new Error('stage_regression');return value;
  });}
  async claimSigning(){await this.change(old=>{if(!old || !['ready','rejected'].includes(old.stage))throw new Error('already_attempted');return {...old,stage:'signing'};});}
  async rejected(){await this.change(old=>{if(!old || old.stage!=='signing')throw new Error('uncertain_signing');return {...old,stage:'rejected'};});}
}
