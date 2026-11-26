import type { PoolClient } from 'pg';

/**
 * Idempotency storage.
 *
 * A key is claimed inside the same transaction that performs the booking, so
 * "the booking happened" and "the key is recorded" are committed atomically:
 * either both are durable or neither is.
 *
 * The claim uses a single upsert rather than SELECT-then-INSERT. That is what
 * makes concurrent duplicates safe:
 *
 *   - The first request inserts the row and owns it.
 *   - Any concurrent request with the same key hits the unique index and its
 *     `ON CONFLICT DO UPDATE` waits until the first transaction commits (or
 *     rolls back). PostgreSQL then returns the *committed* row, so the second
 *     request reads the stored response instead of booking again.
 *   - If the first transaction rolled back, the conflicting index entry vanishes
 *     and the waiting request inserts its own row and becomes the owner.
 *
 * Both branches are plain SQL executed inside the request transaction, so no
 * in-process state is involved and behaviour is identical across restarts and
 * across multiple application instances.
 */
export interface IdempotencyClaim {
  /** True when this key already produced a committed response. */
  replay: boolean;
  responseStatus: number | null;
  responseBody: unknown;
  /** Payload the key was first used with, for mismatch diagnostics. */
  storedFingerprint: string | null;
}

export async function claimIdempotencyKey(
  client: PoolClient,
  key: string,
  fingerprint: string,
): Promise<IdempotencyClaim> {
  const { rows } = await client.query<{
    request_fingerprint: string;
    response_status: number | null;
    response_body: string | null;
    completed_at: Date | null;
  }>(
    `INSERT INTO idempotency_keys (key, request_fingerprint)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET key = idempotency_keys.key
     RETURNING request_fingerprint, response_status, response_body, completed_at`,
    [key, fingerprint],
  );

  const row = rows[0];
  if (row === undefined) {
    // Unreachable in practice: an upsert always returns the row.
    return { replay: false, responseStatus: null, responseBody: null, storedFingerprint: null };
  }

  const replay = row.completed_at !== null && row.response_body !== null;
  return {
    replay,
    responseStatus: row.response_status,
    responseBody: row.response_body === null ? null : (JSON.parse(row.response_body) as unknown),
    storedFingerprint: row.request_fingerprint,
  };
}

export async function storeIdempotentResponse(
  client: PoolClient,
  key: string,
  statusCode: number,
  body: unknown,
  bookingId: string,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
        SET response_status = $2,
            response_body   = $3,
            booking_id      = $4,
            completed_at    = now()
      WHERE key = $1`,
    [key, statusCode, JSON.stringify(body), bookingId],
  );
}
