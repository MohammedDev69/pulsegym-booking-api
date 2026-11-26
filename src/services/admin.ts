import { withTransaction } from '../db/transaction';
import { log } from '../logger';

/**
 * Wipes every table the API owns, so the checker can start from a known state.
 *
 * TRUNCATE is transactional in PostgreSQL: a reset either fully happens or not
 * at all, and an in-flight booking cannot observe a half-empty database.
 *
 * The explicit LOCK comes first, in the same order the write paths acquire their
 * tables (idempotency key -> class -> member -> bookings). Without it, TRUNCATE
 * would grab `bookings` and then wait for `classes` while a booking transaction
 * holds `classes` and waits for `bookings` — a textbook deadlock. Taking the
 * locks up front in a compatible order makes reset safe even if it races a
 * request. (The retry in `withTransaction` covers a deadlock anyway, but being
 * deadlock-free is better than recovering from one.)
 */
export async function resetAll(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      'LOCK TABLE idempotency_keys, classes, members, bookings IN ACCESS EXCLUSIVE MODE',
    );
    await client.query(
      'TRUNCATE TABLE bookings, idempotency_keys, classes, members RESTART IDENTITY CASCADE',
    );
    // The waitlist sequence is not owned by a table, so it needs an explicit
    // reset for a truly clean slate.
    await client.query('ALTER SEQUENCE waitlist_order_seq RESTART WITH 1');
  });
  log('info', 'database reset');
}
