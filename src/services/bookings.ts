import type { PoolClient } from 'pg';
import {
  alreadyBooked,
  alreadyCancelled,
  ApiError,
  bookingNotFound,
  classNotFound,
  memberNotFound,
  membershipInactive,
} from '../errors';
import { withTransaction } from '../db/transaction';
import { log } from '../logger';
import { claimIdempotencyKey, storeIdempotentResponse } from './idempotency';

export type BookingStatus = 'booked' | 'waitlisted' | 'cancelled' | 'skipped';

export interface CreateBookingResult {
  statusCode: number;
  body: BookingResponse;
}

export interface BookingResponse {
  booking_id: string;
  class_id: string;
  member_id: string;
  status: BookingStatus;
  waitlist_position?: number;
}

interface BookingRow {
  id: string;
  class_id: string;
  member_id: string;
  status: BookingStatus;
}

/** Identity of the logical operation a key was used for; stored for diagnostics. */
function fingerprintOfRequest(classId: string, memberId: string): string {
  return `POST /classes/${classId}/bookings|${memberId}`;
}

/**
 * Creates a booking or a waitlist entry.
 *
 * Everything happens in one transaction:
 *
 *   1. claim the Idempotency-Key (also blocks concurrent duplicates)
 *   2. lock the class row  -> serialises every seat decision for that class
 *   3. validate member + membership + duplicate participation
 *   4. atomically claim a seat, or append to the waitlist
 *   5. store the response against the key
 *
 * Lock order is always class -> booking, which is also the order the cancel path
 * uses, so two transactions can never wait on each other in opposite directions.
 */
export async function createBooking(input: {
  classId: string;
  memberId: string;
  idempotencyKey: string;
}): Promise<CreateBookingResult> {
  const { classId, memberId, idempotencyKey } = input;
  const fingerprint = fingerprintOfRequest(classId, memberId);

  return withTransaction(async (client) => {
    const claim = await claimIdempotencyKey(client, idempotencyKey, fingerprint);
    if (claim.replay) {
      // The exact body of the first response, including its status code.
      if (claim.storedFingerprint !== null && claim.storedFingerprint !== fingerprint) {
        log('warn', 'idempotency key reused with a different payload; replaying the first response', {
          idempotencyKey,
          originalFingerprint: claim.storedFingerprint,
          requestFingerprint: fingerprint,
        });
      }
      log('info', 'idempotent replay', { idempotencyKey, classId, memberId });
      return {
        statusCode: 200,
        body: claim.responseBody as BookingResponse,
      };
    }

    // Step 2: the class row is the mutex for this class's seats.
    const classResult = await client.query<{ id: string }>(
      'SELECT id FROM classes WHERE id = $1 FOR UPDATE',
      [classId],
    );
    if (classResult.rows[0] === undefined) throw classNotFound(classId);

    // The database clock decides membership validity, so a skewed application
    // clock can never admit an expired member.
    const memberResult = await client.query<{ id: string; is_active: boolean }>(
      'SELECT id, (membership_expires_at > now()) AS is_active FROM members WHERE id = $1',
      [memberId],
    );
    const member = memberResult.rows[0];
    if (member === undefined) throw memberNotFound(memberId);
    if (!member.is_active) throw membershipInactive(memberId);

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM bookings
        WHERE class_id = $1 AND member_id = $2 AND status IN ('booked', 'waitlisted')`,
      [classId, memberId],
    );
    if (existing.rows.length > 0) throw alreadyBooked(memberId, classId);

    // Step 4a: claim a seat. The WHERE clause is re-evaluated against the locked
    // row, so this cannot succeed once the class is full. The CHECK constraint
    // on classes.booked_count is the last-resort guarantee behind it.
    const seat = await client.query<{ booked_count: number }>(
      `UPDATE classes
          SET booked_count = booked_count + 1
        WHERE id = $1 AND booked_count < capacity
        RETURNING booked_count`,
      [classId],
    );

    let body: BookingResponse;

    if (seat.rows.length === 1) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bookings (class_id, member_id, status)
         VALUES ($1, $2, 'booked')
         RETURNING id`,
        [classId, memberId],
      );
      body = {
        booking_id: inserted.rows[0]!.id,
        class_id: classId,
        member_id: memberId,
        status: 'booked',
      };
    } else {
      // Step 4b: the class is full, append to the FIFO waitlist. The sequence is
      // assigned inside the class lock, so accepted order == waiting order.
      const inserted = await client.query<{ id: string; waitlist_seq: string }>(
        `INSERT INTO bookings (class_id, member_id, status, waitlist_seq)
         VALUES ($1, $2, 'waitlisted', nextval('waitlist_order_seq'))
         RETURNING id, waitlist_seq`,
        [classId, memberId],
      );
      const booking = inserted.rows[0]!;

      const positionResult = await client.query<{ position: number }>(
        `SELECT count(*)::int AS position
           FROM bookings
          WHERE class_id = $1 AND status = 'waitlisted' AND waitlist_seq <= $2`,
        [classId, booking.waitlist_seq],
      );

      body = {
        booking_id: booking.id,
        class_id: classId,
        member_id: memberId,
        status: 'waitlisted',
        waitlist_position: positionResult.rows[0]!.position,
      };
    }

    await storeIdempotentResponse(client, idempotencyKey, 201, body, body.booking_id);

    log('info', 'booking created', {
      bookingId: body.booking_id,
      classId,
      memberId,
      status: body.status,
      waitlistPosition: body.waitlist_position ?? null,
    });

    return { statusCode: 201, body };
  }).catch((error: unknown) => {
    // Safety net: if the partial unique index ever rejects a write, report the
    // domain conflict (409) instead of surfacing a raw database error.
    throw translateConflict(error, memberId, classId);
  });
}

export interface CancelBookingResult {
  statusCode: number;
  body: {
    booking_id: string;
    status: 'cancelled';
    promoted_booking_id: string | null;
  };
}

/**
 * Cancels a booking or a waitlist entry and, when a *booked* seat is released,
 * promotes the first eligible waitlisted member in the same transaction.
 */
export async function cancelBooking(bookingId: string): Promise<CancelBookingResult> {
  return withTransaction(async (client) => {
    // Read the class id without a lock first: a plain SELECT never blocks, and we
    // need it to acquire the class lock before touching the booking row. This
    // preserves the global class -> booking lock order.
    const lookup = await client.query<{ class_id: string }>(
      'SELECT class_id FROM bookings WHERE id = $1',
      [bookingId],
    );
    const classId = lookup.rows[0]?.class_id;
    if (classId === undefined) throw bookingNotFound(bookingId);

    const classLock = await client.query('SELECT id FROM classes WHERE id = $1 FOR UPDATE', [
      classId,
    ]);
    if (classLock.rows.length === 0) throw bookingNotFound(bookingId);

    const locked = await client.query<BookingRow>(
      'SELECT id, class_id, member_id, status FROM bookings WHERE id = $1 FOR UPDATE',
      [bookingId],
    );
    const booking = locked.rows[0];
    if (booking === undefined) throw bookingNotFound(bookingId);

    // Terminal states cannot be cancelled again. `skipped` is terminal too: the
    // member already lost that waitlist slot.
    if (booking.status === 'cancelled' || booking.status === 'skipped') {
      throw alreadyCancelled(bookingId);
    }

    const wasBooked = booking.status === 'booked';

    await client.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = now() WHERE id = $1`,
      [bookingId],
    );

    let promotedBookingId: string | null = null;

    if (wasBooked) {
      // Release exactly one seat, then immediately try to hand it to the first
      // eligible waiter. Both happen under the same class lock, so the seat can
      // neither be lost nor double-awarded.
      await client.query('UPDATE classes SET booked_count = booked_count - 1 WHERE id = $1', [
        classId,
      ]);
      promotedBookingId = await promoteFirstEligible(client, classId);
    }

    log('info', 'booking cancelled', {
      bookingId,
      classId,
      wasBooked,
      promotedBookingId,
    });

    return {
      statusCode: 200,
      body: {
        booking_id: bookingId,
        status: 'cancelled',
        promoted_booking_id: promotedBookingId,
      },
    };
  });
}

/**
 * Walks the waitlist in FIFO order and promotes the first member whose
 * membership is still active. Every ineligible entry on the way is marked
 * `skipped`, exactly as the specification requires.
 *
 * The caller must already hold the class row lock, which is what makes
 * "no duplicate promotion" and "no missing promotion" true: promotions for one
 * class are strictly serialised, and the waitlist cannot change underneath us.
 */
async function promoteFirstEligible(
  client: PoolClient,
  classId: string,
): Promise<string | null> {
  // Bounded defensive loop: each iteration either returns or removes one entry.
  for (;;) {
    const next = await client.query<{
      id: string;
      member_id: string;
      is_active: boolean;
    }>(
      `SELECT b.id,
              b.member_id,
              (m.membership_expires_at > now()) AS is_active
         FROM bookings b
         JOIN members m ON m.id = b.member_id
        WHERE b.class_id = $1 AND b.status = 'waitlisted'
        ORDER BY b.waitlist_seq
        LIMIT 1
        FOR UPDATE OF b`,
      [classId],
    );

    const candidate = next.rows[0];
    if (candidate === undefined) return null;

    if (candidate.is_active) {
      await client.query(
        `UPDATE bookings SET status = 'booked', updated_at = now() WHERE id = $1`,
        [candidate.id],
      );
      await client.query('UPDATE classes SET booked_count = booked_count + 1 WHERE id = $1', [
        classId,
      ]);
      log('info', 'waitlist member promoted', {
        classId,
        bookingId: candidate.id,
        memberId: candidate.member_id,
      });
      return candidate.id;
    }

    await client.query(
      `UPDATE bookings SET status = 'skipped', updated_at = now() WHERE id = $1`,
      [candidate.id],
    );
    log('info', 'waitlist member skipped (membership inactive)', {
      classId,
      bookingId: candidate.id,
      memberId: candidate.member_id,
    });
  }
}

export interface BookingDetailResponse {
  booking_id: string;
  class_id: string;
  member_id: string;
  status: BookingStatus;
  waitlist_position: number | null;
}

export async function getBooking(
  client: PoolClient,
  bookingId: string,
): Promise<BookingDetailResponse> {
  const { rows } = await client.query<BookingDetailResponse>(
    `SELECT b.id AS booking_id,
            b.class_id,
            b.member_id,
            b.status,
            CASE
              WHEN b.status = 'waitlisted' THEN (
                SELECT count(*)::int
                  FROM bookings w
                 WHERE w.class_id = b.class_id
                   AND w.status = 'waitlisted'
                   AND w.waitlist_seq <= b.waitlist_seq
              )
              ELSE NULL
            END AS waitlist_position
       FROM bookings b
      WHERE b.id = $1`,
    [bookingId],
  );

  const row = rows[0];
  if (row === undefined) throw bookingNotFound(bookingId);
  return row;
}

/** Turns a raw unique-violation into the domain error it represents. */
export function translateConflict(error: unknown, memberId: string, classId: string): ApiError {
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;
  if (code === '23505' && constraint === 'bookings_active_member_per_class') {
    return alreadyBooked(memberId, classId);
  }
  throw error;
}
