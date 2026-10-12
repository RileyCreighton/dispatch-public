// Diagnostic metadata capture for disposable tests. Raw Playwright HAR/trace/storage exports
// contain credentials; do not produce them and attempt retrospective string replacement.
import {writeFile} from 'node:fs/promises';
const route=raw=>{
 try{
  const path=new URL(raw).pathname;
  if(path==='/health/live'||path==='/health/ready'||path==='/operator')return path;
  if(/^\/v1\/operator\/(challenge|session|config|readiness)$/.test(path))return path;
  if(path.startsWith('/assets/'))return '/assets/[asset]';
  return '/[redacted-route]';
 }catch{return '/[redacted-route]';}
};
export function captureDiagnostics(page){
 const entries=[],events=[];
 page.on('response',response=>{
  const request=response.request(),method=request.method();
  entries.push({startedDateTime:new Date().toISOString(),time:0,
   request:{method:['GET','POST','PUT','DELETE','HEAD','OPTIONS'].includes(method)?method:'OTHER',url:'https://fixture.invalid'+route(request.url()),httpVersion:'unknown',cookies:[],headers:[],queryString:[],headersSize:-1,bodySize:-1},
   response:{status:response.status(),statusText:'',httpVersion:'unknown',cookies:[],headers:[],content:{size:0,mimeType:'application/octet-stream'},redirectURL:'',headersSize:-1,bodySize:-1},
   cache:{},timings:{send:0,wait:0,receive:0}});
 });
 page.on('pageerror',()=>events.push({code:'browser_error'}));
 page.on('requestfailed',()=>events.push({code:'request_failed'}));
 return {async save(directory){
  if(!entries.length)throw new Error('capture_missing');
  await writeFile(directory+'/sanitized.har',JSON.stringify({log:{version:'1.2',creator:{name:'Dispatch metadata-only diagnostic capture',version:'1'},entries}},null,2)+'\n');
  await writeFile(directory+'/browser-events.json',JSON.stringify(events,null,2)+'\n');
  return {requests:entries.length,errors:events.length};
 }};
}
export async function safeScreenshot(page,path){
 await page.screenshot({path,fullPage:true,animations:'disabled',mask:[page.locator('input:visible,textarea:visible,[data-private]:visible')]});
}
