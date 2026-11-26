import type { PoolClient } from 'pg';
import { classExists, classNotFound } from '../errors';
import { formatTimestamp } from '../http/validation';
import { query } from '../db/pool';

export interface ClassRow {
  id: string;
  name: string;
  capacity: number;
  starts_at: Date;
  booked_count: number;
}

export interface ClassResponse {
  id: string;
  name: string;
  capacity: number;
  starts_at: string;
}

export interface ClassDetailResponse {
  id: string;
  name: string;
  capacity: number;
  booked_count: number;
  booked_member_ids: string[];
  waitlist: Array<{ booking_id: string; member_id: string; position: number }>;
}

export async function createClass(input: {
  id: string;
  name: string;
  capacity: number;
  startsAt: Date;
}): Promise<ClassResponse> {
  const { rows } = await query<ClassRow>(
    `INSERT INTO classes (id, name, capacity, starts_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, capacity, starts_at`,
    [input.id, input.name, input.capacity, input.startsAt],
  );

  const row = rows[0];
  if (row === undefined) throw classExists(input.id);

  return {
    id: row.id,
    name: row.name,
    capacity: row.capacity,
    starts_at: formatTimestamp(row.starts_at),
  };
}

/**
 * Class detail.
 *
 * All three reads run in one READ ONLY, REPEATABLE READ transaction so the
 * counter and the member list always describe the same instant: `booked_count`
 * can never disagree with `booked_member_ids.length` in a single response.
 */
export async function getClassDetail(
  client: PoolClient,
  classId: string,
): Promise<ClassDetailResponse> {
  const classResult = await client.query<
    Pick<ClassRow, 'id' | 'name' | 'capacity' | 'booked_count'>
  >('SELECT id, name, capacity, booked_count FROM classes WHERE id = $1', [classId]);

  const row = classResult.rows[0];
  if (row === undefined) throw classNotFound(classId);

  const booked = await client.query<{ member_id: string }>(
    `SELECT member_id
       FROM bookings
      WHERE class_id = $1 AND status = 'booked'
      ORDER BY created_at, id`,
    [classId],
  );

  // Position is derived, never stored: it is simply the FIFO rank of the row.
  // Deriving it is what guarantees "1, 2, 3, … with no gaps or duplicates"
  // after every cancellation, promotion and skip.
  const waitlist = await client.query<{
    booking_id: string;
    member_id: string;
    position: number;
  }>(
    `SELECT id AS booking_id,
            member_id,
            row_number() OVER (ORDER BY waitlist_seq)::int AS position
       FROM bookings
      WHERE class_id = $1 AND status = 'waitlisted'
      ORDER BY waitlist_seq`,
    [classId],
  );

  return {
    id: row.id,
    name: row.name,
    capacity: row.capacity,
    booked_count: row.booked_count,
    booked_member_ids: booked.rows.map((entry) => entry.member_id),
    waitlist: waitlist.rows,
  };
}
