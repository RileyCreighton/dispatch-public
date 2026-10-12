import { localPool } from '../../../packages/db/src/config.js';
import { operationsReady } from '../../../packages/db/src/index.js';
import { Commerce } from '../../../packages/db/src/commerce.js';
import { OperatorStore } from '../../../packages/db/src/operator.js';
import { RefundStore } from '../../../packages/db/src/refunds.js';
import { LocalRpc } from '../../../packages/payments/src/rpc.js';
import { RefundRpc } from '../../../packages/payments/src/refund.js';
import { PrivateFiles } from '../../../packages/fulfillment/src/files.js';
import { safeLog } from '../../../packages/security/src/index.js';
import { localRuntime, requireLocalRuntime, runtimeMaterial, recoveryFence } from '../../../packages/security/src/local-runtime.js';
import { apiServer } from './app.js';

const write = (line: string) => process.stdout.write(line);
requireLocalRuntime();
const api = localPool('api'), operatorPool = localPool('operator');
try {
  const chain = new LocalRpc(localRuntime.rpc), key = await runtimeMaterial('encryption.key');
  const files = new PrivateFiles(localRuntime.assets);
  const commerce = new Commerce(api, key, chain, localRuntime.origin, localRuntime.provider, () => operationsReady(api));
  const operator = new OperatorStore(operatorPool, commerce, files);
  const server = apiServer(api, localRuntime.origin, write, commerce, {
    tls: { key: await runtimeMaterial('tls.key'), cert: await runtimeMaterial('tls.crt') },
    webDirectory: '/app/apps/web/dist', files, operator, refunds: new RefundStore(operator, new RefundRpc(chain)), recoveryFence: recoveryFence(),
  });
  server.listen(18443, '0.0.0.0', () => safeLog(write, 'started'));
  const stop = () => server.close(() => { void Promise.all([api.end(), operatorPool.end()]); });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  server.on('error', () => { safeLog(write, 'dependency_unavailable'); stop(); process.exitCode = 1; });
} catch { safeLog(write, 'dependency_unavailable'); await Promise.all([api.end(), operatorPool.end()]); process.exitCode = 1; }
