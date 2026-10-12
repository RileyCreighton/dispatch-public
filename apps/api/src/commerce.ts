import type { Express, Request, Response } from 'express';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { StalePolicyError, type Commerce } from '../../../packages/db/src/commerce.js';
import { object, uuid, key } from '../../../packages/domain/src/payment.js';
import { DeliveryStore } from '../../../packages/db/src/delivery.js';
import { PrivateFiles, assetMetadata, byteRange } from '../../../packages/fulfillment/src/files.js';
const cookieName = '__Host-dispatch_buyer';
function cookie(req: Request): string | undefined {
  if (!req.headers.cookie) return undefined;
  const values = req.headers.cookie.split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName+'='));
  if (values.length !== 1 || !new RegExp('^'+cookieName+'=[A-Za-z0-9_-]{43}$').test(values[0]!)) throw new Error('unauthorized');
  return values[0]!.slice(cookieName.length+1);
}
function setCookie(res: Response, credential: string, expires: string) {
  res.set('Set-Cookie', `${cookieName}=${credential}; Secure; HttpOnly; SameSite=Lax; Path=/; Expires=${new Date(expires).toUTCString()}`);
}
export function commerceRoutes(app: Express, commerce: Commerce, files?: PrivateFiles) {
  const delivery = new DeliveryStore(commerce.pool); let activeDownloads = 0;
  const failure = (res: Response, error: unknown) => {
    const reason = error instanceof Error ? error.message : '';
    const status = reason === 'unauthorized' ? 401 : reason === 'forbidden' ? 403 : ['not_ready','https_required'].includes(reason) ? 503 : 409;
    res.status(status).json({ code: status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 503 ? 'NOT_READY'
      : error instanceof StalePolicyError ? 'STALE_POLICY' : 'PAYMENT_CONFLICT', message: status === 503 ? 'New payments are unavailable.' : 'Request could not be completed.',
      request_id: res.locals.requestId, next_action: status === 401 ? 'import_recovery' : error instanceof StalePolicyError ? error.nextAction : 'poll_status', retryable: false });
  };
  const authenticate = async (req: Request) => {
    const browser = cookie(req), auth = req.headers.authorization;
    if (browser) {
      if (auth || !commerce.origin.startsWith('https:')) throw new Error('unauthorized');
      await commerce.buyers.session(browser, 'browser');
      if (!['GET','HEAD'].includes(req.method)) commerce.buyers.checkCsrf(browser, req.headers['x-csrf-token']);
      return browser;
    }
    if (req.headers.cookie || typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new Error('unauthorized');
    const credential = auth.slice(7); await commerce.buyers.session(credential, 'agent'); return credential;
  };
  app.get('/v1/catalog{/:product}', async (req, res) => {
    try {
      const catalog = await commerce.buyers.catalog(req.params.product);
      if (req.params.product && !catalog.products.length) { res.status(404).json({code:'NOT_FOUND',message:'Product unavailable.',request_id:res.locals.requestId,next_action:'none',retryable:false}); return; }
      res.json(req.params.product ? catalog.products[0] : catalog);
    } catch (error) { failure(res, error); }
  });
  app.get('/v1/session', async (req, res) => {
    try { const credential = cookie(req); if (!credential || req.headers.authorization) throw new Error('unauthorized');
      res.json(await commerce.buyers.session(credential, 'browser')); } catch (error) { failure(res, error); }
  });
  app.post('/v1/checkouts', async (req, res) => {
    try {
      const input = object(req.body, ['product_id', 'product_version', 'quantity', 'client_kind']);
      let browser: string | undefined;
      if (input.client_kind === 'browser') {
        if (req.headers.authorization || req.headers['x-dispatch-intent'] !== 'checkout') throw new Error('forbidden');
        browser = cookie(req); if (browser) { await commerce.buyers.session(browser, 'browser'); commerce.buyers.checkCsrf(browser, req.headers['x-csrf-token']); }
      } else if (req.headers.cookie || req.headers.authorization) throw new Error('unauthorized');
      const created = await commerce.create(input, browser);
      if (input.client_kind === 'browser') {
        const { agent_capability: credential, ...body } = created;
        setCookie(res, credential, body.expires_at); res.status(201).json(body);
      } else res.status(201).json(created);
    } catch (error) { failure(res, error); }
  });
  app.post('/v1/orders/:id/recovery', async (req, res) => {
    try {
      object(req.body, []); const credential = await authenticate(req);
      const result = await commerce.buyers.export(uuid(req.params.id), credential, key(req.headers['idempotency-key']));
      res.set('Content-Disposition', 'attachment; filename="dispatch-recovery.json"').json(result);
    } catch (error) { failure(res, error); }
  });
  app.post('/v1/recovery/import', async (req, res) => {
    try {
      if (!commerce.origin.startsWith('https:') || req.headers.authorization || req.headers['x-dispatch-intent'] !== 'recovery') throw new Error('forbidden');
      const v = object(req.body, ['capability']); let existing = cookie(req);
      if (existing) {
        try { await commerce.buyers.session(existing, 'browser'); } catch { existing = undefined; }
        if (existing) commerce.buyers.checkCsrf(existing, req.headers['x-csrf-token']);
      }
      const { credential, ...session } = await commerce.buyers.import(key(v.capability), existing);
      setCookie(res, credential, session.expires_at); res.json(session);
    } catch (error) { failure(res, error); }
  });
  app.all('/v1/orders/:id/download', async (req, res) => {
    let admitted = false;
    try {
      const credential = await authenticate(req), order = uuid(req.params.id);
      if (!['GET','HEAD'].includes(req.method)) { res.sendStatus(405); return; }
      const asset = await delivery.authorize(order, credential);
      if (!files || activeDownloads >= 4) throw new Error('not_ready');
      activeDownloads++; admitted = true;
      const bytes = await files.read(asset), meta = assetMetadata(asset);
      const current = await delivery.authorize(order, credential);
      if (current.id !== asset.id || current.manifest_sha256 !== asset.manifest_sha256) throw new Error('delivery_blocked');
      const range = byteRange(req.headers.range, bytes.length);
      res.set({'Content-Type':meta.mime_type,'Content-Disposition':`attachment; filename="${meta.file_name}"`,
        'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Vary':'Cookie, Authorization'});
      // Conditional requests deliberately return a freshly authorized full/range response, never 304.
      if (range) res.status(206).set('Content-Range',`bytes ${range.start}-${range.end}/${bytes.length}`);
      const output = range ? bytes.subarray(range.start,range.end+1) : bytes;
      res.set('Content-Length',String(output.length)); res.end(req.method === 'HEAD' ? undefined : output);
    } catch (error) {
      if (error instanceof Error && error.message === 'range_invalid') {
        res.status(416).json({code:'RANGE_INVALID',message:'Only one satisfiable byte range is supported.',request_id:res.locals.requestId,next_action:'download',retryable:false});
      } else if(error instanceof Error && ['delivery_blocked','asset_changed','asset_invalid','manifest_invalid','private_root_invalid'].includes(error.message)) {
        res.status(409).json({code:'REVIEW_REQUIRED',message:'File access is unavailable. Payment is unchanged.',request_id:res.locals.requestId,next_action:'contact_support',retryable:false});
      } else failure(res,error);
    } finally { if (admitted) activeDownloads--; }
  });
  app.all('/v1/checkouts/:id{/:operation}', async (req, res) => {
    try {
      const credential = await authenticate(req), id = uuid(req.params.id), op = req.params.operation;
      if (req.method === 'GET' && !op) {
        let result=await commerce.status(id,credential,res.locals.requestId);
        if(result.delivery.state==='available') {
          if(!files||activeDownloads>=4) {result={...result,delivery:{state:'blocked'}};}
          else {activeDownloads++;try {
            const a=await delivery.authorize(id,credential);await files.read(a);
            result=await commerce.status(id,credential,res.locals.requestId);
          }catch {result={...result,delivery:{state:'blocked'}};}finally {activeDownloads--;}}
        }
        res.json(result);return;
      }
      if (req.method !== 'POST') { res.sendStatus(405); return; }
      const k = key(req.headers['idempotency-key']);
      if (op === 'quote') { res.json(await commerce.quote(id, credential, k, req.body)); return; }
      if (op === 'cancel') { object(req.body, []); await commerce.cancel(id, credential, k); res.json(await commerce.status(id, credential, res.locals.requestId)); return; }
      if (op !== 'pay') { res.sendStatus(404); return; }
      const v = object(req.body, ['quote_id', 'quote_hash']), quote = uuid(v.quote_id);
      if (typeof v.quote_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(v.quote_hash)) throw new Error('invalid_input');
      const signature = req.headers['payment-signature'];
      if (signature === undefined) {
        const required = await commerce.paymentChallenge(id, credential, quote, v.quote_hash);
        if (required) { res.set('PAYMENT-REQUIRED', encodePaymentRequiredHeader(required)).status(402).json(required); return; }
      } else {
        if (typeof signature !== 'string' || signature.length > 8192) throw new Error('invalid_input');
        await commerce.bind(id, credential, k, quote, v.quote_hash, decodePaymentSignatureHeader(signature));
      }
      res.set('Retry-After', '3').status(202).json(await commerce.status(id, credential, res.locals.requestId));
    } catch (error) { failure(res, error); }
  });
}
