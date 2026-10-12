import { constants } from 'node:fs';
import { open,mkdir,rename,lstat,unlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { canonical } from '../../../packages/buyer/src/contracts.js';
import type { Journal,PurchaseRecord } from '../../../packages/buyer/src/client.js';
export class FileJournal implements Journal {
  readonly directory:string;
  constructor(directory:string){this.directory=resolve(directory);}
  private async directoryCheck(){const s=await lstat(this.directory);if(!s.isDirectory() || s.isSymbolicLink() || (s.mode&0o077)!==0 || s.uid!==process.getuid?.())throw new Error('private_directory_required');}
  private async readPrivate(name:string){await this.directoryCheck();const handle=await open(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const s=await handle.stat();if(!s.isFile() || (s.mode&0o077)!==0 || s.uid!==process.getuid?.() || s.size>131072)throw new Error('private_file_required');return await handle.readFile();}finally{await handle.close();}}
  private async syncDirectory(){const h=await open(this.directory,constants.O_RDONLY|constants.O_DIRECTORY);try{await h.sync();}finally{await h.close();}}
  async initialize(value:PurchaseRecord){
    // Existing directory means recovery, never silently initialize a second purchase.
    await mkdir(this.directory,{mode:0o700});await this.directoryCheck();
    const h=await open(join(this.directory,'journal.key'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await h.writeFile(randomBytes(32));await h.sync();}finally{await h.close();}
    await this.save(value);
  }
  async read():Promise<PurchaseRecord>{
    const key=await this.readPrivate('journal.key'),encrypted=await this.readPrivate('purchase.enc');
    if(key.length!==32 || encrypted.length<28)throw new Error('invalid_journal');
    const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));decipher.setAAD(Buffer.from('dispatch-buyer-journal-v1'));decipher.setAuthTag(encrypted.subarray(12,28));
    const value=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]).toString('utf8')) as PurchaseRecord;
    // A crash after the atomic claim but before the stage save must still forbid signing.
    try{await this.readPrivate('signing.claim');if(value.stage==='ready' || value.stage==='rejected')value.stage='signing';}catch(e){if(!(e instanceof Error && 'code' in e && e.code==='ENOENT'))throw e;}
    return value;
  }
  private async mutate(action:()=>Promise<void>){
    await this.directoryCheck();
    const handle=await open(join(this.directory,'mutation.lock'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await action();}finally{await handle.close();await unlink(join(this.directory,'mutation.lock'));await this.syncDirectory();}
  }
  async save(value:PurchaseRecord){await this.mutate(async()=>{
    let old:PurchaseRecord|undefined;
    try{old=await this.read();}catch(e){if(!(e instanceof Error && 'code' in e && e.code==='ENOENT'))throw e;}
    if(old && (old.order!==value.order || old.origin!==value.origin || old.payKey!==value.payKey || canonical(old.policy)!==canonical(value.policy)
      || (['signing','signed'].includes(old.stage) && (canonical(old.quote??null)!==canonical(value.quote??null) || old.credential!==value.credential || old.confirmed!==value.confirmed))
      || (old.stage==='signed' && (value.stage!=='signed' || canonical(old.payment)!==canonical(value.payment)))
      || (old.stage==='signing' && !['signing','signed'].includes(value.stage))))throw new Error('journal_regression');
    await this.write(value);
  });}
  private async write(value:PurchaseRecord){
    const key=await this.readPrivate('journal.key'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('dispatch-buyer-journal-v1'));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    const temporary='write-'+randomBytes(16).toString('hex'),h=await open(join(this.directory,temporary),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await h.writeFile(Buffer.concat([iv,cipher.getAuthTag(),encrypted]));await h.sync();}finally{await h.close();}
    await rename(join(this.directory,temporary),join(this.directory,'purchase.enc'));await this.syncDirectory();
  }
  async claimSigning(){
    const saved=await this.read();if(saved.stage!=='ready')throw new Error('already_attempted');
    // Preserve refusal of a preexisting/unknown interrupted mutation. Never steal it.
    try{await this.readPrivate('mutation.lock');throw new Error('journal_busy');}catch(e){if(!(e instanceof Error && 'code' in e && e.code==='ENOENT'))throw e;}
    // Permanent signing ownership precedes temporary mutation coordination. A loser
    // must never hold mutation.lock while the winner persists its original payload.
    const h=await open(join(this.directory,'signing.claim'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await h.writeFile('signing claimed; never remove automatically\n');await h.sync();}finally{await h.close();}
    await this.syncDirectory();
    await this.mutate(async()=>{const current=await this.read();
      if(current.stage!=='signing' || canonical({...current,stage:'ready'})!==canonical(saved))throw new Error('journal_regression');
      await this.write({...saved,stage:'signing'});
    });
  }

  async rejected(){
    // Agent example remains conservative even after explicit signer rejection.
    // Resume only reads status; a new purchase requires new owner-approved inputs.
    const saved=await this.read();await this.save({...saved,stage:'signing'});
  }
}
