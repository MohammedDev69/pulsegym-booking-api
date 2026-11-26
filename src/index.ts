import { buildApp } from './app';
import { config } from './config';
import { closePool, ensureSchema, waitForDatabase } from './db/pool';
import { log } from './logger';

/**
 * Process entry point.
 *
 * Startup is deliberately sequential: wait for PostgreSQL, make sure the schema
 * exists, and only then listen. That way `/health` returning 200 is a real
 * readiness signal for `docker compose up` and for the official checker.
 */
async function main(): Promise<void> {
  await waitForDatabase();
  await ensureSchema();

  const app = buildApp();
  // Bind every interface on both stacks (IPv6 with dual-stack, falling back to
  // IPv4). Clients that resolve `localhost` to `::1` then connect immediately
  // instead of paying a multi-second IPv6 fallback on every request.
  // The backlog is generous because the hidden test opens hundreds of sockets at
  // once, and a full accept queue surfaces as "connection refused".
  const server = app.listen({ port: config.port, backlog: 4096 }, () => {
    log('info', 'pulsegym api listening', { port: config.port });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutdown requested', { signal });

    const forceExit = setTimeout(() => {
      log('error', 'graceful shutdown timed out, exiting');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref();

    server.close(() => {
      void closePool().then(() => {
        log('info', 'shutdown complete');
        process.exit(0);
      });
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (error) => {
    log('error', 'uncaught exception', { error: error.message, stack: error.stack });
  });
}

main().catch((error: unknown) => {
  log('error', 'startup failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
