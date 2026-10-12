import {createHash} from 'node:crypto';
import { request } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { operationReceipt, signBody, WEBHOOK_LIMIT, type OperationReceipt } from './webhook.js';
import { uuid } from '../../domain/src/payment.js';
const forbidden=new BlockList();
for(const [base,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)forbidden.addSubnet(base,prefix,'ipv4');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
for(const [base,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)forbidden.addSubnet(base,prefix,'ipv6');
export function publicAddress(address:string):boolean {
 const family=isIP(address);return family===4?!forbidden.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!forbidden.check(address,'ipv6');
}
export type Target={id:string;url:string;keyId:string;key:Buffer;bearer:string;
 demo?:{network:'dispatch-build005-disposable-loopback';address:'127.0.0.1'|'::1';ca:string}};
export type WebhookResponse={status:number;receipt?:OperationReceipt;retryAfterSeconds?:number};
export type Resolver=(host:string)=>Promise<{address:string;family:number}[]>;
export class WebhookTransport {
 readonly #target:Target;readonly #url:URL;
 constructor(target:Target,readonly resolver:Resolver=host=>lookup(host,{all:true,verbatim:true})) {
  this.#target=structuredClone(target);this.#url=new URL(target.url);
  if(this.#url.href!==target.url||this.#url.protocol!=='https:'||this.#url.pathname!=='/dispatch/v1/events'||this.#url.search||this.#url.hash||this.#url.username||this.#url.password
   ||!/^[A-Za-z0-9_-]{1,64}$/.test(target.id)||!/^[A-Za-z0-9_-]{1,64}$/.test(target.keyId)||target.key.length<32||! /^[A-Za-z0-9_-]{43,128}$/.test(target.bearer))throw new Error('invalid_target');
  this.#target.key=Buffer.from(target.key);
  if(target.demo&&(target.demo.network!=='dispatch-build005-disposable-loopback'||![target.demo.address,'adapter.dispatch-demo.invalid'].includes(this.#url.hostname.replace(/^\[|\]$/g,''))
    ||!['127.0.0.1','::1'].includes(target.demo.address)||!target.demo.ca))throw new Error('invalid_demo_target');
 }
 get binding(){return '0x'+createHash('sha256').update(this.#target.url).digest('hex');}
 get id(){return this.#target.id;}get keyId(){return this.#target.keyId;}
 async send(body:Buffer,timestamp:string){return this.call('/dispatch/v1/events','POST',body,{'Dispatch-Key-Id':this.keyId,'Dispatch-Timestamp':timestamp,'Dispatch-Signature':signBody(body,timestamp,this.#target.key)});}
 async status(event:string){return this.call('/dispatch/v1/operations/'+uuid(event),'GET',undefined,{Authorization:'Bearer '+this.#target.bearer});}
 private async call(path:string,method:'GET'|'POST',body:Buffer|undefined,headers:Record<string,string>):Promise<WebhookResponse> {
  if(body&&body.length>WEBHOOK_LIMIT)throw new Error('request_limit');
  const host=this.#url.hostname.replace(/^\[|\]$/g,''),ip=isIP(host);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const addresses=await Promise.race([ip?Promise.resolve([{address:host,family:ip}]):this.resolver(host),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('dns_timeout')),3000);})]).finally(()=>clearTimeout(timer));
  if(!addresses.length||addresses.length>32||addresses.some(a=>a.family!==isIP(a.address)||!(this.#target.demo?a.address===this.#target.demo.address:publicAddress(a.address))))throw new Error('forbidden_destination');
  const chosen=addresses[0]!;
  return new Promise((resolve,reject)=>{
   let done=false;const finish=(error:Error|undefined,value?:WebhookResponse)=>{if(done)return;done=true;clearTimeout(deadline);if(error)reject(error);else resolve(value!);};
   const deadline=setTimeout(()=>{finish(new Error('receiver_timeout'));req.destroy();},5000);
   const req=request({protocol:'https:',hostname:host,port:this.#url.port||443,path,method,agent:false,family:chosen.family,rejectUnauthorized:true,
    ...(this.#target.demo?{ca:this.#target.demo.ca}:{}),servername:ip?undefined:host,maxHeaderSize:8192,
    lookup:(_hostname,_options,callback)=>callback(null,chosen.address,chosen.family),
    headers:{...headers,Accept:'application/json',Connection:'close',...(body?{'Content-Type':'application/json','Content-Length':String(body.length)}:{})}},res=>{
     const status=res.statusCode??0;
     const retry=res.headers['retry-after'];
     const retrySeconds=typeof retry==='string'?(/^\d{1,6}$/.test(retry)?Number(retry):Math.ceil((Date.parse(retry)-Date.now())/1000)):0;
     const retryAfter=status===429&&Number.isFinite(retrySeconds)&&retrySeconds>0?{retryAfterSeconds:Math.min(3600,retrySeconds)}:{};
     if(status>=300&&status<400){res.destroy();finish(new Error('redirect_denied'));return;}
     if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();finish(new Error('encoding_denied'));return;}
     const chunks:Buffer[]=[];let size=0;
     res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>WEBHOOK_LIMIT){res.destroy();finish(new Error('response_limit'));}else chunks.push(chunk);});
     res.on('error',()=>finish(new Error('receiver_unknown')));res.on('aborted',()=>finish(new Error('receiver_unknown')));
     res.on('end',()=>{try{const receipt=operationReceipt(JSON.parse(Buffer.concat(chunks).toString()) as unknown);finish(undefined,{status,receipt,...retryAfter});}catch{finish(undefined,{status,...retryAfter});}});
    });
   req.on('error',()=>finish(new Error('receiver_unknown')));
   // Do not send headers/body until the actual TLS peer matches the checked, pinned address.
   req.on('socket',socket=>{(socket as TLSSocket).once('secureConnect',()=>{
    const actual=socket.remoteAddress?.replace(/^::ffff:/,'');
    const match=new BlockList();match.addAddress(chosen.address,chosen.family===4?'ipv4':'ipv6');
    if(!actual||!match.check(actual,chosen.family===4?'ipv4':'ipv6')){req.destroy();finish(new Error('peer_denied'));return;}
    req.end(body);
   });});
  });
 }
}
