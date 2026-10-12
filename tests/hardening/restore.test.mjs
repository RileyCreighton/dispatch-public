import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,cp,mkdir,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {createWalletClient,http} from 'viem';
import {setup,teardown,admin,operator,operatorPool,refunds,refundRpc,worker,origin,payee,setFixture,policy,newSigner,request,settle,support,endpoint,rpc} from '../operator/fixtures.mjs';
import {pool} from '../payment/helpers.mjs';
import {localBootstrap,completeLocalBootstrap} from '../../dist/packages/db/src/operator-auth.js';
import {importPrivateAsset} from '../../dist/packages/db/src/private-assets.js';
import {createPurchase,authorizePurchase} from '../../dist/examples/agent/src/purchase.js';
import {PrivateFiles} from '../../dist/packages/fulfillment/src/files.js';
import {PaymentWorker} from '../../dist/packages/db/src/payment-worker.js';
import {DeliveryStore} from '../../dist/packages/db/src/delivery.js';
import {deliveryTick} from '../../dist/apps/worker/src/delivery.js';
import {operationsTick} from '../../dist/apps/worker/src/operations.js';
const base=process.env.DISPATCH_DB_HOST,out=process.env.DISPATCH_BUYER_EVIDENCE,pg=process.env.DISPATCH_TEST_PG_BIN;
const password='B8-generated-'+randomBytes(24).toString('hex'),bytes=Buffer.from('B8 private restore asset\n');
let auth,product,first,pending,bound,seller,refundHash;
const snapshots={};
async function tableHashes(p){const result={};for(const {tablename} of (await p.query("SELECT tablename FROM pg_tables WHERE schemaname='dispatch' ORDER BY tablename")).rows){assert.match(tablename,/^[a-z_]+$/);if(tablename!=='merchant_control')result[tablename]=digest(await rows(p,tablename));}return result;}
const rows=async(p,t)=>(await p.query(`SELECT row_to_json(t)::text r FROM dispatch.${t} t ORDER BY row_to_json(t)::text`)).rows;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function dump(name){execFileSync(pg+'/pg_dump',['-h',base,'-p','55442','-U','fixture_admin','-d','dispatch','-Fc','-f',base+'/'+name+'.dump']);}
async function purchase(){await request('evm_mine');await support();await operationsTick(worker.pool,refundRpc,new Map());const directory=base+'/purchase-'+randomUUID();const j=await createPurchase(policy(),directory);await authorizePurchase(directory,policy(),await newSigner());return {...await j.read(),directory};}
test.before(async()=>{
 await setup();const migrator=pool('local_migrator');await completeLocalBootstrap(migrator,await localBootstrap(migrator,origin),password);
 const challenge=await operator.auth.challenge(),session=await operator.auth.login(challenge.token,challenge.csrf_token,password);auth={token:session.token,csrf:session.csrf_token};
 await operator.updateConfig(auth,randomUUID(),{expected_config_version:0,merchant_name:'Restore fixture',pay_origin:origin,payee,confirmation_payee:payee,policy_version:'policy-1',policy_urls:['https://fixture.invalid/policy/1']});
 await writeFile(base+'/assets/restore.txt',bytes,{mode:0o600});const a=await importPrivateAsset(operatorPool,base+'/assets','restore.txt','restore.txt','text/plain');
 product=(await operator.product(auth,randomUUID(),{title:'Restore fixture',description:'Generated local data',kind:'digital',asset_manifest_id:a.id,unit_atomic:'100',tax_status:'merchant_attested_zero',tax_source:'fixture',tax_version:'1',policy_version:'policy-1',enabled:true,expected_version:0})).body.id;setFixture({product,asset:a.id});
 await operationsTick(worker.pool,refundRpc,new Map());const config=await operator.config(auth);await operator.pause(auth,'payments',randomUUID(),{paused:false,expected_version:config.controls.version,reason:'disposable fixture'});
 first=await purchase();await settle(first.order);await deliveryTick(new DeliveryStore(worker.pool),new Map());
 seller=await newSigner();await request('anvil_setBalance',[seller.address,'0x56bc75e2d63100000']);
 const settlement=(await admin.query('SELECT * FROM settlements WHERE order_id=$1',[first.order])).rows[0];
 const payer=(await admin.query('SELECT authorizer FROM payment_attempts WHERE id=$1',[settlement.attempt_id])).rows[0].authorizer;
 const r=(await refunds.prepare(auth,first.order,randomUUID(),{settlement_id:settlement.id,confirmed_original_payer:payer,expected_signer:seller.address.toLowerCase()})).body;
 bound=(await refunds.start(auth,r.id,randomUUID(),{expected_version:r.version,signer:r.expected_signer,observed_account_nonce:String(await rpc.client.getTransactionCount({address:seller.address,blockTag:'pending'}))})).body;
 pending=await purchase();await mkdir(base+'/backup');await cp(base+'/assets',base+'/backup/assets',{recursive:true});await cp(base+'/fixture.key',base+'/backup/fixture.key');
});
test.after(async()=>{await teardown();});
test('RESTORE-01 backup before payment broadcast and final refund invocation cannot regain authority; chain is not rolled back',async()=>{
 snapshots.old=await tableHashes(admin);dump('old');assert.equal((await admin.query('SELECT count(*) n FROM refund_invocations')).rows[0].n,'0');
 await settle(pending.order);await refunds.invoke(auth,bound.id,{expected_version:bound.version});await refunds.authorize(auth,bound.id,{expected_version:bound.version});
 const b=bound.binding;refundHash=await createWalletClient({account:seller,transport:http(endpoint,{retryCount:0})}).sendTransaction({chain:{id:8453,name:'Local fixture',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[endpoint]}}},to:b.transaction_to,data:b.transaction_calldata,value:0n,nonce:Number(b.wallet_account_nonce)});
 await refunds.observation(auth,bound.id,randomUUID(),{expected_version:bound.version,invocation_version:bound.version,outcome:'unknown'});
 assert.equal((await rpc.client.getTransactionReceipt({hash:refundHash})).status,'success');snapshots.ambiguous=await tableHashes(admin);dump('ambiguous');
});
test('RESTORE-02 old and ambiguous backups restore repeatedly with exact retained history and durable connection fence',async()=>{
 const proof=[];
 for(const [snapshot,name] of [['old','b8_restore_old'],['old','b8_restore_again'],['ambiguous','b8_restore_ambiguous']]){
  execFileSync('python3',['scripts/restore-disposable.py',base+'/'+snapshot+'.dump',name],{env:process.env});
  const restored=new Pool({host:base,port:55442,user:'fixture_admin',database:name,options:'-c search_path=dispatch,pg_catalog'});
  try{
   const c=(await restored.query('SELECT * FROM merchant_control')).rows[0];assert.equal(c.payment_paused,true);assert.equal(c.fulfillment_paused,true);assert.equal(c.mainnet_enabled,false);assert.equal(c.physical_enabled,false);
   for(const role of ['local_api','local_worker','local_operator','local_migrator']){const denied=new Pool({host:base,port:55442,user:role,database:name,connectionTimeoutMillis:1000});try{await assert.rejects(denied.query('SELECT 1'),e=>e.code==='42501');}finally{await denied.end();}}
   const invocations=Number((await restored.query('SELECT count(*) n FROM refund_invocations')).rows[0].n);assert.equal(invocations,snapshot==='old'?0:1);
   assert.equal((await restored.query('SELECT state FROM refunds WHERE id=$1',[bound.id])).rows[0].state,snapshot==='old'?'wallet_pending':'broadcast_unknown');
   assert.ok(Number((await restored.query('SELECT count(*) n FROM budget_allocations WHERE released_at IS NULL')).rows[0].n)>0);
   const key=await readFile(base+'/backup/fixture.key'),store=new PaymentWorker(restored,key);
   for(const a of (await restored.query('SELECT id FROM payment_attempts')).rows)await store.envelope(a.id);
   const files=new PrivateFiles(base+'/backup/assets');for(const a of (await restored.query('SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM asset_versions')).rows)await files.read(a);
   const hashes=await tableHashes(restored);assert.deepEqual(hashes,snapshots[snapshot]);
   proof.push({snapshot,name,invocations,hashes,runtime_connect:'denied'});
   assert.equal((await rpc.client.getTransactionReceipt({hash:refundHash})).status,'success');
  }finally{await restored.end();}
 }
 assert.deepEqual(proof[0].hashes,proof[1].hashes);
 await writeFile(out+'/stale-restore.json',JSON.stringify({restores:proof,chain_not_rolled_back:true,automatic_unfence:false},null,2)+'\n');
});
test('RESTORE-03 missing/mismatched keys and assets fail verification while restored services remain fenced',async()=>{
 const p=new Pool({host:base,port:55442,user:'fixture_admin',database:'b8_restore_ambiguous'});
 try{
  const id=(await p.query('SELECT id FROM dispatch.payment_attempts LIMIT 1')).rows[0].id;
  await assert.rejects(new PaymentWorker(p,randomBytes(32)).envelope(id));
  await rename(base+'/backup/fixture.key',base+'/backup/key.saved');await assert.rejects(readFile(base+'/backup/fixture.key'));await rename(base+'/backup/key.saved',base+'/backup/fixture.key');
  const a=(await p.query("SELECT id,private_relative_path,file_sha256,manifest_sha256,mime_type,download_name,size_bytes FROM dispatch.asset_versions WHERE private_relative_path='restore.txt'")).rows[0],files=new PrivateFiles(base+'/backup/assets');
  await writeFile(base+'/backup/assets/restore.txt','mismatch');await assert.rejects(files.read(a));
  await rename(base+'/backup/assets/restore.txt',base+'/backup/assets/hidden.txt');await assert.rejects(files.read(a));
  await writeFile(base+'/backup/assets/restore.txt',bytes);await files.read(a);
  assert.equal((await p.query("SELECT has_database_privilege('local_operator',current_database(),'CONNECT') ok")).rows[0].ok,false);
 }finally{await p.end();}
});
test('RESTORE-04 the bootstrapped installation also completes a human purchase, private delivery and saved-file recovery',async()=>{
 const {chromium}=await import('playwright');
 await request('evm_mine');await support();await operationsTick(worker.pool,refundRpc,new Map());
 const account=await newSigner(),browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});let signs=0;
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:true}),page=await context.newPage();page.setDefaultTimeout(10000);
  await page.exposeFunction('__b8sign',async data=>{signs++;return account.signTypedData(JSON.parse(data));});
  await page.exposeFunction('__b8rpc',async(method,params)=>request(method,params));
  await page.addInitScript(address=>{
   const provider={on(){},removeListener(){},async request({method,params}){
    if(method==='eth_chainId')return '0x2105';if(method==='eth_accounts'||method==='eth_requestAccounts')return [address];
    if(method==='eth_signTypedData_v4')return window.__b8sign(params[1]);
    if(method==='eth_call')return window.__b8rpc(method,params);throw new Error('unsupported_fixture_method');
   }};
   window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{provider,info:{uuid:'88888888-8888-4888-8888-888888888888',name:'B8 local fixture',icon:'',rdns:'fixture.invalid'}}})));
  },account.address);
  await page.goto(origin+'/buy/'+product);await page.getByRole('button',{name:'Begin checkout',exact:true}).click();
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Review exact quote',exact:true}).click();
  await page.getByRole('button',{name:'Connect a wallet',exact:true}).click();await page.getByRole('button',{name:'Connect B8 local fixture',exact:true}).click();
  await page.getByRole('button',{name:/^Authorize /}).click();await page.getByRole('heading',{name:'Checking your payment',exact:true}).waitFor();
  const order=page.url().split('/').at(-1);assert.equal(signs,1);await settle(order);await deliveryTick(new DeliveryStore(worker.pool),new Map());
  await page.getByRole('button',{name:'Check payment status',exact:true}).click();await page.getByRole('link',{name:'Download file',exact:true}).waitFor();
  const downloaded=await page.evaluate(async()=>Array.from(new Uint8Array(await (await fetch(document.querySelector('a[download]').getAttribute('href'))).arrayBuffer())));assert.deepEqual(Buffer.from(downloaded),bytes);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Save recovery file',exact:true}).click();const download=await downloadPromise;
  const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);const saved=Buffer.concat(chunks);assert.ok(JSON.parse(saved).capability);
  const recovered=await browser.newContext({ignoreHTTPSErrors:true}),p=await recovered.newPage();await p.goto(origin+'/buy/'+product);
  await p.getByText('Recover a checkout',{exact:true}).click();await p.locator('input[type=file]').setInputFiles({name:'recovery.json',mimeType:'application/json',buffer:saved});
  await p.getByRole('link',{name:'Download file',exact:true}).waitFor();assert.equal(signs,1);await recovered.close();await context.close();
 }finally{await browser.close();}
});
