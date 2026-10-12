import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical } from '../../payments/src/canonical.js';
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export type Asset = Readonly<{ id: string; private_relative_path: string; file_sha256: string;
  manifest_sha256: string; mime_type: string; download_name: string; size_bytes: string | number }>;
export function manifestDigest(asset: Omit<Asset, 'manifest_sha256'>): string {
  return '0x' + createHash('sha256').update(canonical({ ...asset, size_bytes: String(asset.size_bytes) })).digest('hex');
}
export function assetMetadata(asset: Asset) {
  const size = Number(asset.size_bytes);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ASSET_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.private_relative_path)
    || asset.private_relative_path.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(asset.download_name)
    || !/^0x[0-9a-f]{64}$/.test(asset.file_sha256)) throw new Error('asset_invalid');
  const { manifest_sha256, ...entry } = asset;
  if (manifestDigest(entry) !== manifest_sha256) throw new Error('manifest_invalid');
  // All responses are attachments; active/unknown formats receive an inert type.
  const mime = ['application/json', 'text/csv', 'text/plain', 'application/pdf', 'application/zip'].includes(asset.mime_type)
    ? asset.mime_type : 'application/octet-stream';
  return { file_name: asset.download_name, mime_type: mime, size_bytes: size, sha256: asset.file_sha256 };
}
export class PrivateFiles {
  constructor(readonly root: string) {
    if (process.platform !== 'linux' || !root.startsWith('/') || resolve(root) !== root) throw new Error('private_root_invalid');
    for (const publicRoot of [resolve('apps/web'), resolve('examples/merchant-site')])
      if (root === publicRoot || root.startsWith(publicRoot + sep)) throw new Error('private_root_invalid');
  }
  async read(asset: Asset): Promise<Buffer> {
    const meta = assetMetadata(asset);
    if (await realpath(this.root) !== this.root) throw new Error('private_root_invalid');
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      // Flat manifest names + pinned directory descriptor eliminate ancestor replacement races.
      const file = await open(`/proc/self/fd/${directory.fd}/${asset.private_relative_path}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== meta.size_bytes) throw new Error('asset_changed');
        const bytes = Buffer.alloc(meta.size_bytes); let offset = 0;
        while (offset < bytes.length) {
          const r = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!r.bytesRead) throw new Error('asset_changed'); offset += r.bytesRead;
        }
        const after = await file.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || '0x' + createHash('sha256').update(bytes).digest('hex') !== meta.sha256) throw new Error('asset_changed');
        // Return only the verified buffer, never stream mutable storage after checking its hash.
        return bytes;
      } finally { await file.close(); }
    } finally { await directory.close(); }
  }
}
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  if (header === undefined) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || size === 0) throw new Error('range_invalid');
  const first = m[1] ? Number(m[1]) : undefined, last = m[2] ? Number(m[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) throw new Error('range_invalid');
  const start = first ?? Math.max(0, size - (last ?? 0)), end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || start > end || (first === undefined && !last)) throw new Error('range_invalid');
  return { start, end };
}
