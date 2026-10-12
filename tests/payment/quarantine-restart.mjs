// Fresh worker process after actual PostgreSQL stop/start; other-order quarantine persists.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pools,admin,worker,evidence } from './helpers.mjs';
try {
 const {order,attempt,source}=JSON.parse(await readFile(process.env.DISPATCH_DB_HOST+'/quarantine-restart.json','utf8'));
 assert.equal((await admin.query("SELECT count(*) n FROM payment_incidents WHERE settlement_id=$1 AND kind='reorg' AND resolved_at IS NULL",[source])).rows[0].n,'1');
 const proof=evidence(await worker.binding(attempt));
 // The saved lease is still live after process death; fixture advances its deadline to exercise takeover.
 await admin.query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second',available_at=now() WHERE attempt_id=$1 AND effect_type='reconcile'",[attempt]);
 const lease=await worker.claimReconcile(attempt),sid=await worker.apply(lease,proof);
 await admin.query("UPDATE outbox_jobs SET available_at=now() WHERE id=$1",[lease.job]);
 const repeated=await worker.claimReconcile(attempt);
 assert.equal(await worker.apply(repeated,proof),sid);
 await worker.apply(repeated,evidence(await worker.binding(attempt)));
 const r=(await admin.query(`SELECT o.state,o.fulfillment_state,
  (SELECT count(*) FROM settlements WHERE order_id=o.id AND disposition='review') reviews,
  (SELECT count(*) FROM settlements WHERE order_id=o.id AND disposition='credited') credits,
  (SELECT count(*) FROM outbox_jobs WHERE order_id=o.id AND effect_type='entitlement') jobs,
  (SELECT count(*) FROM budget_allocations WHERE attempt_id=$2 AND released_at IS NOT NULL) released
  FROM orders o WHERE o.id=$1`,[order,attempt])).rows[0];
 assert.deepEqual(r,{state:'review_required',fulfillment_state:'blocked',reviews:'2',credits:'0',jobs:'0',released:'0'});
 assert.equal(await worker.recover(),0);
 console.log(JSON.stringify({process_restart:'passed',postgres_restart:'passed',other_order_quarantine:'passed',repeated_observations:'passed',...r}));
}finally{for(const p of pools)await p.end();}
