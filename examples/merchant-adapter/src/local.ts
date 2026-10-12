import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { merchantServer, MerchantReceiver } from './server.js';
import { merchantSite } from '../../merchant-site/src/server.js';
import { requireLocalRuntime, runtimeMaterial } from '../../../packages/security/src/local-runtime.js';
requireLocalRuntime();
const pool = new Pool({ host: 'postgres', database: 'merchant', user: 'local_receiver', password: 'fixture-only-receiver',
  connectionTimeoutMillis: 2000, statement_timeout: 3000, max: 3 });
const server = merchantServer(new MerchantReceiver(pool), { origin: 'https://127.0.0.1:18444',
  keys: new Map([['local-fixture', await runtimeMaterial('webhook.key')]]),
  bearer: (await runtimeMaterial('webhook.bearer')).toString(),
  tls: { key: await runtimeMaterial('tls.key'), cert: await runtimeMaterial('tls.crt') } });
const product = (await readFile('/journal/product', 'utf8')).trim();
const site = merchantSite({ port: 18085, ...(product ? { product, dispatchOrigin: 'https://127.0.0.1:18443' } : {}) });
server.listen(18444, '127.0.0.1');
const stop = () => { site.close(); server.close(() => { void pool.end(); }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
