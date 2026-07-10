import * as http from 'node:http';
import { jsonResponse } from '../api/routes/helpers.js';
import { handleNotifyRoutes } from '../api/routes/notify-routes.js';
import { rateLimiterFromEnv, resolveClientIp } from '../api/request-rate-limiter.js';
import type { Logger } from '../utils/logger.js';
import { timingSafeStrEqual } from '../web/ws-server.js';
import type { NotifyOnlyRegistry } from './notify-only-registry.js';

export interface NotifyOnlyServerOptions {
  port: number;
  secret: string;
  registry: NotifyOnlyRegistry;
  logger: Logger;
}

export function startNotifyOnlyServer(options: NotifyOnlyServerOptions): http.Server {
  const { port, secret, registry, logger } = options;
  if (!secret.trim()) {
    throw new Error('Notify-only API secret is required');
  }

  const startedAt = Date.now();
  const rateLimiter = rateLimiterFromEnv();
  rateLimiter.startSweep();
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';
    if (method === 'GET' && url === '/api/health') {
      jsonResponse(res, 200, {
        status: 'ok',
        mode: 'notify-only',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }

    const clientIp = resolveClientIp(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
    );
    const decision = rateLimiter.check(clientIp);
    if (decision) {
      res.setHeader('Retry-After', String(decision.retryAfterSec));
      jsonResponse(res, 429, { error: 'Too Many Requests', reason: decision.reason });
      return;
    }

    const authorization = req.headers.authorization;
    const match = typeof authorization === 'string'
      ? authorization.match(/^Bearer\s+([^\s]+)$/i)
      : null;
    const bearer = match?.[1];
    if (!timingSafeStrEqual(bearer, secret)) {
      rateLimiter.recordAuthFailure(clientIp);
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }
    rateLimiter.recordAuthSuccess(clientIp);

    try {
      const handled = await handleNotifyRoutes(
        { registry, logger },
        req,
        res,
        method,
        url,
      );
      if (!handled) {
        jsonResponse(res, 404, { error: 'Not Found' });
      }
    } catch (error: any) {
      const status = Number(error?.statusCode) || 500;
      logger.error({ error: error?.message, status }, 'Notify-only request failed');
      jsonResponse(res, status, {
        error: status === 500 ? 'Internal Server Error' : error?.message,
      });
    }
  });

  server.once('close', () => rateLimiter.stopSweep());
  server.listen(port, '0.0.0.0', () => {
    logger.info({ port, mode: 'notify-only' }, 'Notify-only API listening');
  });
  return server;
}
