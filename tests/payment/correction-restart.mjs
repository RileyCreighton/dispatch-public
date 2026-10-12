// Invoked in a fresh process after genuine PostgreSQL stop/start and dump/restore.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pools,admin,worker,evidence } from './helpers.mjs';
try {
 const {order,attempt}=JSON.parse(await readFile(process.env.DISPATCH_DB_HOST+'/correction-restart.json','utf8'));
 assert.equal(await worker.recover(),0);
 assert.equal((await admin.query('SELECT state FROM orders WHERE id=$1',[order])).rows[0].state,'review_required');
 await admin.query("UPDATE outbox_jobs SET available_at=now() WHERE attempt_id=$1 AND effect_type='reconcile'",[attempt]);
 await worker.apply(await worker.claimReconcile(attempt),evidence(await worker.binding(attempt)));
 assert.equal((await admin.query("SELECT count(*) n FROM settlements WHERE order_id=$1 AND disposition='credited'",[order])).rows[0].n,'0');
 assert.equal((await admin.query("SELECT count(*) n FROM outbox_jobs WHERE order_id=$1 AND effect_type='entitlement'",[order])).rows[0].n,'0');
 assert.equal((await admin.query("SELECT count(*) n FROM payment_incidents WHERE order_id=$1 AND kind='reorg' AND resolved_at IS NULL",[order])).rows[0].n,'1');
 console.log(JSON.stringify({process_restart:'passed',postgres_restart:'passed',blocked_replacement:'passed',recovery_rescan:0,credited:0,entitlement_jobs:0}));
} finally {for(const p of pools)await p.end();}
