// Disposable inspection runtime. No production configuration, funded key or live provider.
import {setup,teardown,origin,worker,refundRpc,support,request,payee} from '../tests/operator/fixtures.mjs';
import {operationsTick} from '../dist/apps/worker/src/operations.js';
let running=true;
process.once('SIGINT',()=>{running=false;});process.once('SIGTERM',()=>{running=false;});
try {
 await setup();await operationsTick(worker.pool,refundRpc,new Map());
 const base=process.env.DISPATCH_DB_HOST;
 console.log(JSON.stringify({classification:'disposable local operator inspection; generated token, no live wallet',url:origin+'/operator',
  local_environment:{DISPATCH_MODE:'local',DISPATCH_DB_HOST:base,DISPATCH_DB_PORT:'55442'},private_asset_root:base+'/assets',
  suggested_fixture_payee:payee,policy_example:'https://fixture.invalid/policy/1',
  setup:'Use docs/configuration.md owner-local CLI; choose your own password. No default operator credentials.',
  complete_wallet_demonstration:'npm run test:operator uses a synthetic wallet and genuine disposable local transfer.'}));
 if(process.argv.includes('--smoke')) {
  const response=await fetch(origin+'/operator');if(response.status!==200)throw new Error('operator_page_unavailable');
  const denied=await fetch(origin+'/v1/operator/config');if(denied.status!==401)throw new Error('operator_not_protected');
  console.log(JSON.stringify({empty_operator_inspection:'passed',private_config_unauthenticated:denied.status}));
 }else {
  const deadline=Date.now()+580000;
  while(running&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1000));await request('evm_mine');await support();await operationsTick(worker.pool,refundRpc,new Map());}
 }
}finally{await teardown();}
