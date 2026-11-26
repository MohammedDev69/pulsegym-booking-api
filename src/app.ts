import express, { type Express } from 'express';
import { buildRouter } from './http/routes';
import { errorMiddleware, notFoundMiddleware } from './http/error-middleware';
import { log } from './logger';

/**
 * Builds the HTTP application. Kept separate from server start-up so tests can
 * mount it on an ephemeral port without touching process-level concerns.
 */
export function buildApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Parse JSON regardless of the declared Content-Type: some clients forget the
  // header, and rejecting an otherwise valid body would be a needless failure.
  app.use(express.json({ limit: '256kb', type: () => true }));

  // Only failures are logged per request; successful booking/cancellation events
  // are logged at the domain level, which keeps logs useful without flooding
  // stdout during a burst of concurrent traffic.
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      if (res.statusCode >= 400 && req.path !== '/health') {
        log('warn', 'request failed', {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        });
      }
    });
    next();
  });

  app.use(buildRouter());

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
