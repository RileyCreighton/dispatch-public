import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { foundationReady, rateLimit } from '../../../packages/db/src/index.js';
import { safeError } from '../../../packages/contracts/src/index.js';
import { safeLog } from '../../../packages/security/src/index.js';
import { operatorRoutes, privateOperatorPeer } from './operator.js';
import type { OperatorStore } from '../../../packages/db/src/operator.js';
import type { RefundStore } from '../../../packages/db/src/refunds.js';
import { commerceRoutes } from './commerce.js';
import type { PrivateFiles } from '../../../packages/fulfillment/src/files.js';
import type { Commerce } from '../../../packages/db/src/commerce.js';
export function apiServer(pool: Pool, origin: string, write: (line: string) => void, commerce?: Commerce,
  options?: { tls: { key: Buffer; cert: Buffer }; webDirectory?: string; files?: PrivateFiles; operator?: OperatorStore; refunds?: RefundStore; recoveryFence?: boolean }) {
  const configured = new URL(origin);
  if (configured.origin !== origin || !['http:', 'https:'].includes(configured.protocol) || configured.hostname !== '127.0.0.1'
    || (configured.protocol === 'https:') !== !!options?.tls)
    throw new Error('loopback_origin_required');
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', false);
  app.use((req, res, next) => {
    const id = randomUUID(); res.locals.requestId = id;
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer', 'X-Request-ID': id });
    res.on('finish', () => safeLog(write, 'request', res.statusCode));
    if (req.headers.host !== configured.host || (req.headers.origin && req.headers.origin !== origin) ||
      req.url.includes('?') || !req.url.startsWith('/') || req.headers['transfer-encoding'] ||
      Number(req.headers['content-length'] ?? 0) > 16384) {
      res.status(400).json(safeError('INVALID_INPUT', id)); return;
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) {
      res.status(403).json(safeError('FORBIDDEN', id)); return;
    }
    if (commerce && req.path.startsWith('/v1/') && !['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
      res.status(415).json(safeError('INVALID_INPUT', id)); return;
    }
    if (req.path.startsWith('/v1/') && req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))) {
      res.status(403).json(safeError('FORBIDDEN', id)); return;
    }
    // Isolated restore mode permits authentication and existing private recovery,
    // never a new purchase, signature/submission path or refund wallet authority.
    if (options?.recoveryFence && !['GET', 'HEAD'].includes(req.method)
      && !(req.method === 'POST' && ['/v1/operator/session', '/v1/operator/session/reauth', '/v1/recovery/import'].includes(req.path))
      && !(req.method === 'DELETE' && req.path === '/v1/operator/session')) {
      res.status(503).json(safeError('NOT_READY', id)); return;
    }
    next();
  });
  app.get('/health/live', (_req, res) => res.json({ alive: true }));
  app.use(async (req, res, next) => {
    try {
      if (!await rateLimit(pool, ((req.path.startsWith('/v1/operator/') || req.path.startsWith('/operator') || req.path.startsWith('/assets/')) ? 'operator-and-web:' : '') + (req.socket.remoteAddress ?? 'unknown'), (req.path.startsWith('/v1/operator/') || req.path.startsWith('/operator') || req.path.startsWith('/assets/')) ? 180 : 60)) {
        res.set('Retry-After', '60').status(429).json(safeError('RATE_LIMITED', res.locals.requestId)); return;
      }
      next();
    } catch { res.status(503).json(safeError('NOT_READY', res.locals.requestId)); }
  });
  app.get('/health/ready', async (_req, res) => {
    // The local foundation can be healthy; payment dependencies and later builds are unverified.
    try { await foundationReady(pool); } catch { /* Coarse response deliberately omits details. */ }
    res.status(503).json(safeError('NOT_READY', res.locals.requestId));
  });
  app.use(express.json({ limit: '16kb', strict: true, inflate: false }));
  // Commerce is dependency-injected only by the isolated local runner. Default boot stays unavailable.
  if (options?.operator && options.refunds) operatorRoutes(app, options.operator, options.refunds);
  if (commerce) commerceRoutes(app, commerce, options?.files);
  if (commerce && options?.webDirectory) {
    const directory = resolve(options.webDirectory);
    app.use(['/buy', '/checkout', '/operator', '/assets'], (_req, res, next) => {
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"); next();
    });
    app.use('/assets', express.static(resolve(directory, 'assets'), { fallthrough: false, index: false, dotfiles: 'deny' }));
    app.use('/operator', (req,res,next) => { if (!privateOperatorPeer(req) || !options.operator) { res.sendStatus(404); return; } next(); });
    app.get(['/operator', '/operator/:page', '/buy/:product', '/checkout/:id'], (_req, res) => res.sendFile(resolve(directory, 'index.html')));
  }
  app.use((_req, res) => res.status(404).json(safeError('NOT_FOUND', res.locals.requestId)));
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json(safeError('INVALID_INPUT', res.locals.requestId));
  };
  app.use(errors);
  const limits = { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 };
  const server = options?.tls ? createSecureServer({ ...limits, ...options.tls }, app) : createServer(limits, app);
  server.maxConnections = 64; server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}
