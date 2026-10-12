// Read-only owner-local preflight. It never releases the recovery fence.
import {localPool} from '../dist/packages/db/src/config.js';
import {PaymentWorker} from '../dist/packages/db/src/payment-worker.js';
import {PrivateFiles} from '../dist/packages/fulfillment/src/files.js';
import {requireLocalRuntime,runtimeMaterial} from '../dist/packages/security/src/local-runtime.js';
requireLocalRuntime();const pool=localPool('worker');
try {
 const store=new PaymentWorker(pool,await runtimeMaterial('encryption.key')),files=new PrivateFiles('/private-assets');
 const attempts=(await pool.query('SELECT id FROM dispatch.payment_attempts')).rows;
 for(const a of attempts)await store.envelope(a.id);
 const assets=(await pool.query('SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM dispatch.asset_versions')).rows;
 for(const asset of assets)await files.read(asset);
 console.log(JSON.stringify({status:'verified',encrypted_attempts:attempts.length,matching_assets:assets.length,recovery_fence:'not_released'}));
}catch{console.error('Recovery material verification failed; keep application and money-moving work fenced.');process.exitCode=1;}
finally{await pool.end();}
