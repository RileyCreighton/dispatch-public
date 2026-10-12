import type { Express,Request,Response } from 'express';
import type { OperatorStore,CommandResult } from '../../../packages/db/src/operator.js';
import type { RefundStore } from '../../../packages/db/src/refunds.js';
import { object,key,uuid } from '../../../packages/domain/src/payment.js';
const sessionName='__Host-dispatch_operator',preauthName='__Host-dispatch_operator_challenge';
function cookie(req:Request,name:string) {
  const values=(req.headers.cookie??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  if(values.length!==1 || !new RegExp('^'+name+'=[A-Za-z0-9_-]{43}$').test(values[0]!))throw new Error('unauthorized');
  return values[0]!.slice(name.length+1);
}
function setCookie(res:Response,name:string,token:string,expires:string) {
  res.set('Set-Cookie',`${name}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expires).toUTCString()}`);
}
export function privateOperatorPeer(req:Request) {
  return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'');
}
export function operatorRoutes(app:Express,store:OperatorStore,refunds:RefundStore) {
  app.use('/v1/operator',(req,res,next)=>{
    if(!privateOperatorPeer(req)||!req.secure||req.headers.authorization) {res.status(403).json({code:'FORBIDDEN'});return;}
    if(!['GET','HEAD'].includes(req.method)&&!req.is('application/json')){res.status(415).json({code:'INVALID_INPUT'});return;}next();
  });
  const auth=(req:Request)=>({token:cookie(req,sessionName),...(typeof req.headers['x-csrf-token']==='string'?{csrf:req.headers['x-csrf-token']}:{})});
  const fail=(res:Response,error:unknown)=>{
    const reason=error instanceof Error?error.message:'';
    const status=reason==='unauthorized'?401:reason==='forbidden'?403:reason==='rate_limited'?429:reason==='not_found'?404:reason==='not_ready'?503:409;
    const code=['stale_config','idempotency_conflict','refund_conflict','refund_review_required'].includes(reason)?reason.toUpperCase():status===401?'UNAUTHENTICATED':status===403?'FORBIDDEN':status===429?'RATE_LIMITED':status===503?'NOT_READY':'INVALID_INPUT';
    res.status(status).json({code,message:'Action could not be completed. Refresh current status before another command.',request_id:res.locals.requestId,
      next_action:reason==='stale_config'?'review_config':status===401?'reauthenticate':'poll_status',retryable:false});
  };
  const command=(res:Response,r:CommandResult)=>res.set('Idempotency-Replayed',String(r.replayed)).status(r.status).json(r.body);
  app.get('/v1/operator/session/challenge',async(_req,res)=>{try{const {token,...body}=await store.auth.challenge();setCookie(res,preauthName,token,body.expires_at);res.json(body);}catch(e){fail(res,e);}});
  app.post('/v1/operator/session',async(req,res)=>{try{const v=object(req.body,['password']);
    const {token,...body}=await store.auth.login(cookie(req,preauthName),String(req.headers['x-csrf-token']??''),v.password);
    setCookie(res,sessionName,token,body.expires_at);res.json(body);}catch(e){fail(res,e);}});
  app.get('/v1/operator/session',async(req,res)=>{try{res.json(await store.auth.session(auth(req)));}catch(e){fail(res,e);}});
  app.delete('/v1/operator/session',async(req,res)=>{try{object(req.body,[]);await store.auth.logout(auth(req));setCookie(res,sessionName,'',new Date(0).toISOString());res.status(204).end();}catch(e){fail(res,e);}});
  app.post('/v1/operator/session/reauth',async(req,res)=>{try{const v=object(req.body,['password']);res.json(await store.auth.reauth(auth(req),v.password));}catch(e){fail(res,e);}});
  app.get('/v1/operator/config',async(req,res)=>{try{res.json(await store.config(auth(req)));}catch(e){fail(res,e);}});
  app.put('/v1/operator/config',async(req,res)=>{try{command(res,await store.updateConfig(auth(req),key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
  for(const kind of ['payments','fulfillment'] as const)app.post('/v1/operator/pause/'+kind,async(req,res)=>{try{command(res,await store.pause(auth(req),kind,key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
  app.get('/v1/operator/readiness',async(req,res)=>{try{res.json(await store.readiness(auth(req)));}catch(e){fail(res,e);}});
  app.get('/v1/operator/products',async(req,res)=>{try{res.json(await store.products(auth(req)));}catch(e){fail(res,e);}});
  app.post('/v1/operator/products',async(req,res)=>{try{command(res,await store.product(auth(req),key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
  app.put('/v1/operator/products/:id',async(req,res)=>{try{command(res,await store.product(auth(req),key(req.headers['idempotency-key']),req.body,uuid(req.params.id)));}catch(e){fail(res,e);}});
  app.get('/v1/operator/orders{/:id}',async(req,res)=>{try{res.json(await store.orders(auth(req),req.params.id));}catch(e){fail(res,e);}});
  app.get('/v1/operator/orders/:id/receipt',async(req,res)=>{try{res.set('Content-Disposition','attachment; filename=dispatch-purchase.json').json(await store.receipt(auth(req),uuid(req.params.id)));}catch(e){fail(res,e);}});
  app.post('/v1/operator/orders/:id/delivery/retry',async(req,res)=>{try{command(res,await store.retryDelivery(auth(req),uuid(req.params.id),key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
  app.post('/v1/operator/orders/:id/refunds',async(req,res)=>{try{command(res,await refunds.prepare(auth(req),uuid(req.params.id),key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
  app.get('/v1/operator/refunds/:id',async(req,res)=>{try{res.json(await refunds.get(auth(req),uuid(req.params.id)));}catch(e){fail(res,e);}});
  app.post('/v1/operator/refunds/:id/wallet-start',async(req,res)=>{try{command(res,await refunds.start(auth(req),uuid(req.params.id),key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
  app.post('/v1/operator/refunds/:id/invocation',async(req,res)=>{try{res.json(await refunds.invoke(auth(req),uuid(req.params.id),req.body));}catch(e){fail(res,e);}});
  app.post('/v1/operator/refunds/:id/authorization',async(req,res)=>{try{res.json(await refunds.authorize(auth(req),uuid(req.params.id),req.body));}catch(e){fail(res,e);}});
  app.post('/v1/operator/refunds/:id/observation',async(req,res)=>{try{command(res,await refunds.observation(auth(req),uuid(req.params.id),key(req.headers['idempotency-key']),req.body));}catch(e){fail(res,e);}});
}
