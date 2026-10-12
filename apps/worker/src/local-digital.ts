import { writeFile } from 'node:fs/promises';
import { localPool } from '../../../packages/db/src/config.js';
import { storeSupport } from '../../../packages/db/src/index.js';
import { PaymentWorker } from '../../../packages/db/src/payment-worker.js';
import { LocalRpc } from '../../../packages/payments/src/rpc.js';
import { RefundRpc } from '../../../packages/payments/src/refund.js';
import { FacilitatorTransport } from '../../../packages/payments/src/facilitator.js';
import { WebhookTransport } from '../../../packages/fulfillment/src/transport.js';
import { safeLog } from '../../../packages/security/src/index.js';
import { localRuntime, requireLocalRuntime, runtimeMaterial, recoveryFence } from '../../../packages/security/src/local-runtime.js';
import { paymentTick, reconcileKnown } from './payments.js';
import { operationsTick } from './operations.js';

requireLocalRuntime();
const pool = localPool('worker'), write = (line: string) => process.stdout.write(line);
let stopping = false;
process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
try {
  const key = await runtimeMaterial('encryption.key'), ca = (await runtimeMaterial('tls.crt')).toString();
  const chain = new LocalRpc(localRuntime.rpc), store = new PaymentWorker(pool, key);
  const provider = new FacilitatorTransport({ url: localRuntime.provider, loopbackFixture: true, fixtureCA: ca });
  const target = new WebhookTransport({ id: 'local-receiver', url: 'https://127.0.0.1:18444/dispatch/v1/events', keyId: 'local-fixture',
    key: await runtimeMaterial('webhook.key'), bearer: (await runtimeMaterial('webhook.bearer')).toString(),
    demo: { network: 'dispatch-build005-disposable-loopback', address: '127.0.0.1', ca } });
  const targets = new Map([[target.id, target]]);
  let supportedAt = 0;
  safeLog(write, 'started');
  while (!stopping) {
    try {
      if (Date.now() - supportedAt > 15000) {
        const supported = await provider.getSupported(), fetched = Date.now();
        await storeSupport(pool, { provider_origin: localRuntime.provider, fetched_at: fetched, expires_at: fetched + 60000,
          supported_kinds: supported.kinds }, localRuntime.provider, fetched);
        supportedAt = fetched;
      }
      if (recoveryFence()) {
        // Existing known references may be checked. No claim of initial verify or
        // settle, expiry release, signature recreation or automatic un-fencing.
        const jobs = (await pool.query(`SELECT attempt_id FROM dispatch.outbox_jobs WHERE effect_type='reconcile'
          AND available_at<=clock_timestamp() AND (state IN ('queued','retry') OR (state='leased' AND lease_until<=clock_timestamp()))
          ORDER BY available_at,id LIMIT 20`)).rows;
        for (const job of jobs) try { await reconcileKnown(store, job.attempt_id, chain); } catch { /* retain uncertainty */ }
      } else await paymentTick(store, chain, provider);
      await operationsTick(pool, new RefundRpc(chain), targets);
      await writeFile('/tmp/dispatch-worker-health', String(Date.now()), { mode: 0o600 });
    } catch { safeLog(write, 'dependency_unavailable'); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} catch { safeLog(write, 'dependency_unavailable'); process.exitCode = 1; }
finally { await pool.end(); }
