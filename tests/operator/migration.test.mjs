import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../dist/packages/db/src/migrate.js';
const options={host:process.env.DISPATCH_DB_HOST,port:55442,database:'upgrade',options:'-c search_path=dispatch,pg_catalog'};
const migrator=new Pool({...options,user:'local_migrator'}),admin=new Pool({...options,user:'fixture_admin'}),api=new Pool({...options,user:'local_api'}),operator=new Pool({...options,user:'local_operator'});
test.after(async()=>{await Promise.all([migrator.end(),admin.end(),api.end(),operator.end()]);});
test('B6-M1 forward 007 to 009 retains prior config/control bytes and grants no public bootstrap authority',async()=>{
 await migrate(migrator,'db/migrations','007_private_delivery.sql');const id=randomUUID();
 await operator.query(`INSERT INTO merchant_config_versions(id,version,merchant_id,pay_origin,merchant_name,payee,chain_id,network,token,decimals,policy_version,policy_urls,finality_policy)
 VALUES($1,1,'single','https://127.0.0.1:18443','Upgrade fixture',$2,8453,'eip155:8453',$3,6,'policy-1','["https://fixture.invalid/policy/1"]','safe')`,[id,'0x'+'22'.repeat(20),'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
 await operator.query('UPDATE merchant_control SET config_id=$1,fulfillment_paused=true',[id]);
 const before=await admin.query('SELECT row_to_json(c) value FROM merchant_control c UNION ALL SELECT row_to_json(v) FROM merchant_config_versions v');
 const history=(await admin.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;assert.equal(history.length,7);
 await migrate(migrator);await migrate(migrator);
 assert.deepEqual((await admin.query('SELECT row_to_json(c) value FROM merchant_control c UNION ALL SELECT row_to_json(v) FROM merchant_config_versions v')).rows,before.rows);
 const after=(await admin.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;assert.equal(after.length,9);assert.deepEqual(after.slice(0,7),history);
 await assert.rejects(api.query('SELECT * FROM operator_identity'),{code:'42501'});await assert.rejects(operator.query("INSERT INTO operator_identity(merchant_id,trusted_origin,bootstrap_hash,bootstrap_expires_at) VALUES('single','https://127.0.0.1:18443',$1,clock_timestamp())",['0x'+'11'.repeat(32)]),{code:'42501'});
 assert.equal((await operator.query('SELECT count(*) n FROM operator_identity')).rows[0].n,'0');
});
test('B6-M2 actual local CLI completes bootstrap once across competing processes without logging credentials',async()=>{
 const {execFileSync,spawn}=await import('node:child_process'),{randomBytes}=await import('node:crypto');
 const env={PATH:process.env.PATH,DISPATCH_MODE:'local',DISPATCH_DB_HOST:options.host,DISPATCH_DB_PORT:'55442',DISPATCH_DB_NAME:'upgrade'};
 const path=options.host+'/operator-bootstrap',password=randomBytes(24).toString('base64url');
 const issued=execFileSync(process.execPath,['scripts/operator-local.mjs','begin','https://127.0.0.1:18443',path],{env,encoding:'utf8'});assert.match(issued,/private file/);
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/operator-local.mjs','complete',path],{env,stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>resolve({code,output}));child.stdin.end(password+'\n');});
 const results=await Promise.all([run(),run()]);assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(results.filter(r=>r.code===1).length,1);assert.ok(results.every(r=>!r.output.includes(password)));
 assert.equal((await operator.query('SELECT initialized_at IS NOT NULL initialized FROM operator_identity')).rows[0].initialized,true);assert.equal((await run()).code,1);
});
