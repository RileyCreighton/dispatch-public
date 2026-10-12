import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { localPool } from './config.js';
export async function migrate(pool: Pool, directory = resolve('db/migrations'), through?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(8453, 2)');
    await client.query('SET ROLE dispatch_migrator');
    await client.query('SET search_path = dispatch, pg_catalog');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(directory)).filter(x => /^\d{3}_[a-z_]+\.sql$/.test(x)).sort();
    const applied = await client.query<{ name: string; sha256: string }>('SELECT name,sha256 FROM schema_migrations ORDER BY name');
    for (let i = 0; i < applied.rows.length; i++) {
      const row = applied.rows[i];
      if (!row || files[i] !== row.name) throw new Error('migration_history_mismatch');
    }
    for (const name of files) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const old = applied.rows.find(row => row.name === name);
      if (old) { if (old.sha256 !== digest) throw new Error('migration_checksum_mismatch'); continue; }
      if (through && name > through) break;
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,sha256) VALUES ($1,$2)', [name, digest]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally {
    // A dedicated connection is destroyed even if reset/unlock fails.
    client.release(true);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = localPool('migrator');
  try { await migrate(pool); process.stdout.write('migrations_applied\n'); }
  catch { process.stderr.write('migration_failed\n'); process.exitCode = 1; }
  finally { await pool.end(); }
}
