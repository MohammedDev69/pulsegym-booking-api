import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config';
import { log } from '../logger';
import { SCHEMA_LOCK_ID, SCHEMA_SQL } from './schema';

let pool: Pool | null = null;

/**
 * A single process-wide pool. PostgreSQL connections are expensive and the
 * database — not the application — is what actually serialises concurrent
 * writers, so one modest pool is enough.
 */
export function getPool(): Pool {
  if (pool === null) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.poolMax,
      idleTimeoutMillis: 30_000,
      // A burst of hundreds of requests queues for a connection while the class
      // lock serialises the actual seat decisions. The wait must be long enough
      // that the tail of the burst succeeds instead of failing with a pool
      // timeout; the per-request work itself takes milliseconds.
      connectionTimeoutMillis: 30_000,
      // Timestamps are rendered in UTC so responses never depend on the host TZ.
      options: '-c timezone=UTC',
      application_name: 'pulsegym-api',
    });

    pool.on('error', (error: Error) => {
      // An idle client died (network blip, database restart). The pool discards
      // it; the next request simply gets a fresh connection.
      log('error', 'idle postgres client error', { error: error.message });
    });
  }
  return pool;
}

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values as unknown[]);
}

/** Waits for the database to accept connections (Docker start-up ordering). */
export async function waitForDatabase(): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= config.dbConnectAttempts; attempt += 1) {
    const client = await getPool()
      .connect()
      .catch((error: unknown) => {
        lastError = error;
        return null;
      });

    if (client !== null) {
      client.release();
      log('info', 'database connection established', { attempt });
      return;
    }

    log('warn', 'database not ready yet, retrying', {
      attempt,
      maxAttempts: config.dbConnectAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });

    await new Promise((resolve) => setTimeout(resolve, config.dbConnectRetryDelayMs));
  }

  throw new Error(
    `Could not connect to PostgreSQL after ${config.dbConnectAttempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Creates the schema if it is missing. Wrapped in a transaction-level advisory
 * lock so that several containers booting simultaneously cannot race on DDL.
 */
export async function ensureSchema(client?: PoolClient): Promise<void> {
  if (client !== undefined) {
    await applySchema(client);
    return;
  }

  const dedicated = await getPool().connect();
  try {
    await applySchema(dedicated);
  } finally {
    dedicated.release();
  }
}

async function applySchema(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    await client.query(SCHEMA_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    const current = pool;
    pool = null;
    await current.end().catch(() => undefined);
  }
}
