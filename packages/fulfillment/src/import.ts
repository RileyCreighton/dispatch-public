import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { PrivateFiles, MAX_ASSET_BYTES, manifestDigest, assetMetadata, type Asset } from './files.js';
// Owner-side import only; no HTTP upload or remote URL importer.
export async function inspectPrivateAsset(root:string,name:string,downloadName:string,mime:string):Promise<Asset> {
 const files=new PrivateFiles(root);
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)||name.includes('..')||await realpath(root)!==root)throw new Error('asset_invalid');
 const directory=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 try {
  const file=await open(`/proc/self/fd/${directory.fd}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
   const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_ASSET_BYTES)throw new Error('asset_invalid');
   const bytes=Buffer.alloc(stat.size);let offset=0;
   while(offset<bytes.length){const r=await file.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)throw new Error('asset_changed');offset+=r.bytesRead;}
   const entry={id:randomUUID(),private_relative_path:name,download_name:downloadName,mime_type:mime,size_bytes:stat.size,file_sha256:'0x'+createHash('sha256').update(bytes).digest('hex')};
   const asset={...entry,manifest_sha256:manifestDigest(entry)};assetMetadata(asset);await files.read(asset);return Object.freeze(asset);
  }finally{await file.close();}
 }finally{await directory.close();}
}
