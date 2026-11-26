import type { PoolClient } from 'pg';
import { getPool } from './pool';
import { log } from '../logger';

/** PostgreSQL error codes that mean "the transaction lost a race, try again". */
const RETRYABLE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);

export function isRetryableDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

interface TransactionOptions {
  attempts?: number;
  /** 'read only' transactions get a stable snapshot and no write locks. */
  readOnly?: boolean;
  /** Isolation level; defaults to READ COMMITTED, which is all we need. */
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
}

/**
 * Runs `fn` inside a single transaction and guarantees all-or-nothing semantics:
 * the transaction is committed only when `fn` resolves, and rolled back on any
 * throw.
 *
 * Deadlocks and serialization failures are retried a few times. The code is
 * written to avoid them (a single, global lock order: class row -> booking rows),
 * but retrying keeps a rare conflict from surfacing as a 500 to the client.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const client = await getPool().connect();
    try {
      const iso = options.isolation ?? 'read committed';
      await client.query(
        `BEGIN ISOLATION LEVEL ${iso.toUpperCase()}${options.readOnly === true ? ' READ ONLY' : ''}`,
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      lastError = error;

      if (!isRetryableDatabaseError(error) || attempt === attempts) {
        throw error;
      }

      log('warn', 'retrying transaction after transient database conflict', {
        attempt,
        attempts,
        code: (error as { code?: string }).code,
      });
      // Small, increasing backoff to decorrelate the retrying transactions.
      await new Promise((resolve) => setTimeout(resolve, attempt * 10));
    } finally {
      client.release();
    }
  }

  throw lastError;
}
