/**
 * Runtime configuration.
 *
 * Everything is read from environment variables so the exact same image can run
 * in Docker, in CI and locally without code changes.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, received "${raw}"`);
  }
  return value;
}

export const config = {
  /** Port the HTTP API listens on. The challenge expects 8080. */
  port: readPositiveInt('PORT', 8080),
  /** PostgreSQL connection string. */
  databaseUrl:
    process.env.DATABASE_URL?.trim() || 'postgres://pulse:pulse@localhost:5432/pulsegym',
  /** Upper bound on pooled connections. */
  poolMax: readPositiveInt('PG_POOL_MAX', 20),
  /** How long to keep retrying the first database connection at boot. */
  dbConnectAttempts: readPositiveInt('DB_CONNECT_ATTEMPTS', 60),
  dbConnectRetryDelayMs: readPositiveInt('DB_CONNECT_RETRY_DELAY_MS', 1000),
  /** Grace period for in-flight requests during shutdown. */
  shutdownTimeoutMs: readPositiveInt('SHUTDOWN_TIMEOUT_MS', 10000),
} as const;
