import { localPool } from '../../../packages/db/src/config.js';
import { safeLog } from '../../../packages/security/src/index.js';
import { apiServer } from './app.js';
const write = (line: string) => process.stdout.write(line);
try {
  const pool = localPool('api');
  const port = Number(process.env.DISPATCH_PORT ?? '3000');
  const host = process.env.DISPATCH_BIND === 'container' ? '0.0.0.0' : '127.0.0.1';
  const server = apiServer(pool, process.env.DISPATCH_ORIGIN ?? 'http://127.0.0.1:3000', write);
  server.listen(port, host, () => safeLog(write, 'started'));
  server.on('error', async () => { safeLog(write, 'dependency_unavailable'); await pool.end(); process.exitCode = 1; });
  const stop = () => server.close(() => { void pool.end().then(() => safeLog(write, 'stopped')); });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch { safeLog(write, 'dependency_unavailable'); process.exitCode = 1; }
