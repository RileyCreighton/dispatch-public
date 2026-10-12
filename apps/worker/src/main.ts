import { writeFile } from 'node:fs/promises';
import { localPool } from '../../../packages/db/src/config.js';
import { foundationReady } from '../../../packages/db/src/index.js';
import { safeLog } from '../../../packages/security/src/index.js';
const write = (line: string) => process.stdout.write(line);
let stopping = false;
try {
  const pool = localPool('worker');
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  safeLog(write, 'started');
  while (!stopping) {
    try {
      if (!await foundationReady(pool)) throw new Error('not_ready');
      await writeFile('/tmp/dispatch-worker-health', String(Date.now()), { mode: 0o600 });
    } catch { safeLog(write, 'dependency_unavailable'); }
    if (process.env.DISPATCH_WORKER_ONCE === '1') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await pool.end(); safeLog(write, 'stopped');
} catch { safeLog(write, 'dependency_unavailable'); process.exitCode = 1; }
