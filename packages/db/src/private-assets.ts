import type {Pool} from 'pg';
import {inspectPrivateAsset} from '../../fulfillment/src/import.js';
// Provision with a separate owner/operator connection. Public API never exposes this function.
export async function importPrivateAsset(pool:Pool,root:string,name:string,downloadName:string,mime:string) {
 const a=await inspectPrivateAsset(root,name,downloadName,mime);
 await pool.query(`INSERT INTO dispatch.asset_versions(id,manifest_sha256,file_sha256,private_relative_path,mime_type,download_name,size_bytes)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[a.id,a.manifest_sha256,a.file_sha256,a.private_relative_path,a.mime_type,a.download_name,a.size_bytes]);return a;
}
