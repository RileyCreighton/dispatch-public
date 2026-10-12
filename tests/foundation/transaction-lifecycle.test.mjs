import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {localPool} from '../../dist/packages/db/src/config.js';
import {migrate} from '../../dist/packages/db/src/migrate.js';
import {transaction,digest} from '../../dist/packages/db/src/commerce.js';
const pool=localPool('api'),migrator=localPool('migrator');
const admin=new Pool({host:process.env.DISPATCH_DB_HOST,port:55442,user:'fixture_admin',database:'dispatch',password:'',max:1});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test.before(()=>migrate(migrator));
test.after(async()=>{await Promise.all([pool.end(),migrator.end(),admin.end()]);});
const insert=(c,id)=>c.query('INSERT INTO dispatch.abuse_counters(bucket_hash,window_start,count) VALUES($1,clock_timestamp(),1)',[digest(id)]);
const count=async id=>Number((await admin.query('SELECT count(*) n FROM dispatch.abuse_counters WHERE bucket_hash=$1',[digest(id)])).rows[0].n);
test('checked-out idle timeout rejects once, rolls back writes and leaves the service pool usable',async()=>{
  let calls=0;
  await assert.rejects(transaction(pool,async c=>{
    calls++;assert.equal((await c.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout,'3s');
    await insert(c,'idle');await sleep(3400);
  }),e=>e.code==='25P03');
  assert.equal(calls,1);assert.equal(await count('idle'),0);
  assert.equal(await transaction(pool,async c=>(await c.query('SELECT 42 n')).rows[0].n),42);
  assert.equal(pool.totalCount,pool.idleCount);
});
test('backend loss between statements is propagated without replay or leaked checkout',async()=>{
  let calls=0;
  await assert.rejects(transaction(pool,async c=>{
    calls++;await insert(c,'terminated');const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1)',[pid]);await sleep(100);
  }),e=>e.code==='57P01');
  assert.equal(calls,1);assert.equal(await count('terminated'),0);
  await transaction(pool,c=>c.query('SELECT 1'));assert.equal(pool.totalCount,pool.idleCount);
});
test('statement timeout remains enforced and does not retry the operation',async()=>{
  let calls=0;
  await assert.rejects(transaction(pool,async c=>{calls++;await insert(c,'statement');await c.query('SELECT pg_sleep(4)');}),e=>e.code==='57014');
  assert.equal(calls,1);assert.equal(await count('statement'),0);
});
test('only known rolled-back serialization failures retry SQL work',async()=>{
  let calls=0;
  await transaction(pool,async c=>{calls++;await insert(c,'serialization');if(calls<3)throw Object.assign(new Error('fixture serialization'),{code:'40001'});});
  assert.equal(calls,3);assert.equal(await count('serialization'),1);
});
test('lost commit acknowledgement preserves one committed effect and never replays',async()=>{
  let calls=0;
  const wrapper={async connect(){const c=await pool.connect(),query=c.query.bind(c);c.query=async(...args)=>{
    const result=await query(...args);
    if(args[0]==='COMMIT'){const error=Object.assign(new Error('fixture lost commit acknowledgement'),{code:'08006'});c.emit('error',error);throw error;}
    return result;
  };return c;}};
  await assert.rejects(transaction(wrapper,async c=>{calls++;await insert(c,'commit');}),e=>e.code==='08006');
  assert.equal(calls,1);assert.equal(await count('commit'),1);
  await transaction(pool,c=>c.query('SELECT 1'));assert.equal(pool.totalCount,pool.idleCount);
});
