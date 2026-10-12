import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {setup,teardown,logs,origin,admin} from '../operator/fixtures.mjs';
import {pool} from '../payment/helpers.mjs';
import {localBootstrap,completeLocalBootstrap} from '../../dist/packages/db/src/operator-auth.js';
import {captureDiagnostics,safeScreenshot} from '../../scripts/safe-browser-diagnostics.mjs';
const out=process.env.DISPATCH_BUYER_EVIDENCE,secret='B8CANARY'+randomBytes(24).toString('hex'),second='B8CANARY'+randomBytes(24).toString('hex');
let browser,context,page,capture;
test.before(async()=>{
 await setup();const migrator=pool('local_migrator');await completeLocalBootstrap(migrator,await localBootstrap(migrator,origin),secret);
 browser=await chromium.launch({executablePath:process.env.DISPATCH_BROWSER_PATH,headless:true,args:['--no-sandbox']});
 context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1000,height:800},recordVideo:{dir:out+'/video',size:{width:1000,height:800}}});
 page=await context.newPage();capture=captureDiagnostics(page);
});
test.after(async()=>{await context?.close();await browser?.close();await teardown();});
test('B8-S01 actual request errors and browser captures preserve metadata without canary values',async()=>{
 await page.goto(origin+'/operator');const field=page.getByLabel('Operator password',{exact:true});await field.fill(secret);
 assert.equal(await field.getAttribute('type'),'password');await safeScreenshot(page,out+'/masked-a.png');
 await field.fill(second);await safeScreenshot(page,out+'/masked-b.png');assert.deepEqual(await readFile(out+'/masked-a.png'),await readFile(out+'/masked-b.png'));
 await field.fill(secret);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Set up merchant details'}).waitFor();
 const responses=await page.evaluate(async canary=>{
  const values=[];
  for(const path of ['/health/live?secret='+canary,'/v1/missing/'+canary]){
   const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+canary},body:JSON.stringify({password:canary,signature:canary,capability:canary})});values.push({status:r.status,body:await r.text()});
  }
  setTimeout(()=>{throw new Error(canary);},0);return values;
 },secret);
 await page.waitForTimeout(100);await safeScreenshot(page,out+'/setup.png');
 const metadata=await capture.save(out);assert.ok(metadata.requests>=5);assert.equal(metadata.errors,1);
 await writeFile(out+'/http-errors.json',JSON.stringify(responses,null,2)+'\n');await writeFile(out+'/api.log',logs.join(''));
 for(const name of ['sanitized.har','browser-events.json','http-errors.json','api.log']){const content=await readFile(out+'/'+name,'utf8');assert.ok(content.length>2);assert.ok(!content.includes(secret));assert.ok(!content.includes(second));}
 for(const directory of ['dist','apps/web/dist']){for(const name of await readdir(directory,{recursive:true})){const file=directory+'/'+name;try{const content=await readFile(file);assert.ok(!content.includes(Buffer.from(secret)));assert.ok(!content.includes(Buffer.from(second)));}catch(error){if(error.code!=='EISDIR')throw error;}}}
 assert.ok(logs.some(x=>JSON.parse(x).code==='request'));
 assert.equal((await admin.query('SELECT count(*) n FROM orders')).rows[0].n,'0');
 await context.close();context=undefined;const videos=await readdir(out+'/video');assert.equal(videos.length,1);assert.ok((await readFile(out+'/video/'+videos[0])).length>1000);
 await writeFile(out+'/diagnostic-result.json',JSON.stringify({metadata,canary_values_persisted:false,masked_screenshot_pixels_equal:true,video:videos[0],video_visual_review:'required',raw_har_or_storage_state_exported:false},null,2)+'\n');
});
