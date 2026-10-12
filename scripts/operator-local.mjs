// Owner-local CLI only; no HTTP registration, password argument, URL or logging.
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {localPool} from '../dist/packages/db/src/config.js';
import {localBootstrap,completeLocalBootstrap} from '../dist/packages/db/src/operator-auth.js';
import {importPrivateAsset} from '../dist/packages/db/src/private-assets.js';
const [command,...args]=process.argv.slice(2),pool=localPool(command==='import'?'operator':'migrator');
try {
 if(process.env.DISPATCH_RECOVERY==='quarantined'&&['begin','complete'].includes(command))throw new Error('recovery_bootstrap_fenced');
 if(command==='begin'&&args.length===2){
  const file=await open(args[1],'wx',0o600);
  try{const secret=await localBootstrap(pool,args[0]);await file.writeFile(secret);await file.sync();}finally{await file.close();}
  process.stdout.write('Local bootstrap written to the private file; expires in 15 minutes. Complete using password on stdin.\n');
 }else if(command==='complete'&&args.length===1){
  const file=await open(args[0],constants.O_RDONLY|constants.O_NOFOLLOW);let secret;
  try{const stat=await file.stat();if(!stat.isFile()||(stat.mode&0o077)||stat.uid!==process.getuid?.())throw new Error('private_file_required');secret=(await file.readFile('utf8')).trim();}finally{await file.close();}
  let password='';for await(const chunk of process.stdin){password+=chunk.toString();if(password.length>1025)throw new Error('invalid_password');}
  await completeLocalBootstrap(pool,secret,password.replace(/\n$/,''));password='';process.stdout.write('Operator initialized. Bootstrap cannot be reused.\n');
 }else if(command==='import'&&args.length===4){
  const a=await importPrivateAsset(pool,...args);process.stdout.write(JSON.stringify({asset_manifest_id:a.id,download_name:a.download_name})+'\n');
 }else throw new Error('usage');
}catch{process.stderr.write('Local operator command failed. Check command, private input and current initialization state.\n');process.exitCode=1;}
finally{await pool.end();}
