import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../../src/app';
import { closePool, ensureSchema, getPool, waitForDatabase } from '../../src/db/pool';

export const FUTURE = '2099-12-31T23:59:59Z';
export const PAST = '2000-01-01T00:00:00Z';

export interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export interface ErrorEnvelope {
  error: { code: string; message: string };
}

/**
 * Reads the error code out of any response body. Responses are typed by their
 * success shape, so error assertions go through this narrow helper.
 */
export function errorCode(body: unknown): string {
  const envelope = body as Partial<ErrorEnvelope> | null;
  return envelope?.error?.code ?? '';
}

let server: Server | null = null;
let port = 0;

/**
 * Many tests issue hundreds of parallel requests. The socket cap keeps the
 * in-process server able to accept them: client and server share one event loop
 * here, and an oversized accept queue shows up as ECONNREFUSED on Windows.
 */
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });

export async function bootApi(): Promise<void> {
  if (server !== null) return;
  await waitForDatabase();
  await ensureSchema();
  server = buildApp().listen({ port: 0, host: '127.0.0.1', backlog: 4096 });
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
}

export async function shutdownApi(): Promise<void> {
  agent.destroy();
  if (server !== null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await closePool();
}

export function baseUrl(): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Minimal HTTP client built on node:http so the concurrency tests control the
 * socket pool themselves. `fetch`/undici keeps a bounded connection pool, which
 * would silently serialise the very requests these tests need in parallel.
 */
export function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  return new Promise<ApiResponse<T>>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const requestHeaders: Record<string, string> = { ...headers };
    if (payload !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = String(payload.length);
    }

    const req = http.request(
      { host: '127.0.0.1', port, path, method, agent, headers: requestHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          if (text.length > 0) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export async function resetDb(): Promise<void> {
  const response = await call('POST', '/admin/reset');
  if (response.status !== 204) throw new Error(`reset failed: ${response.status}`);
}

export interface MemberBody {
  id: string;
  name: string;
  membership_expires_at: string;
}

export function createMember(
  id: string,
  expiresAt: string = FUTURE,
  name = `Member ${id}`,
): Promise<ApiResponse<MemberBody>> {
  return call<MemberBody>('POST', '/members', {
    id,
    name,
    membership_expires_at: expiresAt,
  });
}

export function createClass(
  id: string,
  capacity: number,
  startsAt = '2026-12-05T07:00:00Z',
): Promise<ApiResponse<Record<string, unknown>>> {
  return call('POST', '/classes', { id, name: `Class ${id}`, capacity, starts_at: startsAt });
}

let keyCounter = 0;
export function nextKey(prefix = 'key'): string {
  keyCounter += 1;
  return `${prefix}-${keyCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface BookingBody {
  booking_id: string;
  class_id: string;
  member_id: string;
  status: 'booked' | 'waitlisted';
  waitlist_position?: number;
}

export function book(
  classId: string,
  memberId: string,
  key: string = nextKey(),
): Promise<ApiResponse<BookingBody>> {
  return call<BookingBody>('POST', `/classes/${classId}/bookings`, { member_id: memberId }, {
    'idempotency-key': key,
  });
}

export function cancel(bookingId: string): Promise<
  ApiResponse<{ booking_id: string; status: string; promoted_booking_id: string | null }>
> {
  return call('DELETE', `/bookings/${bookingId}`);
}

export function getBooking(bookingId: string): Promise<
  ApiResponse<{
    booking_id: string;
    class_id: string;
    member_id: string;
    status: string;
    waitlist_position: number | null;
  }>
> {
  return call('GET', `/bookings/${bookingId}`);
}

export function getClass(classId: string): Promise<
  ApiResponse<{
    id: string;
    name: string;
    capacity: number;
    booked_count: number;
    booked_member_ids: string[];
    waitlist: Array<{ booking_id: string; member_id: string; position: number }>;
  }>
> {
  return call('GET', `/classes/${classId}`);
}

// ---------------------------------------------------------------------------
// Direct database helpers (fast seeding + persisted-state assertions)
// ---------------------------------------------------------------------------

export async function sql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query(text, values as unknown[]);
  return result.rows as T[];
}

export async function seedMembers(
  ids: string[],
  expiresAt: string = FUTURE,
): Promise<void> {
  const expiries = ids.map(() => expiresAt);
  await sql(
    `INSERT INTO members (id, name, membership_expires_at)
     SELECT m.id, 'Member ' || m.id, m.expires_at
       FROM unnest($1::text[], $2::timestamptz[]) AS m(id, expires_at)`,
    [ids, expiries],
  );
}

export async function seedClass(id: string, capacity: number): Promise<void> {
  await sql(
    `INSERT INTO classes (id, name, capacity, starts_at)
     VALUES ($1, $2, $3, $4)`,
    [id, `Class ${id}`, capacity, '2026-12-05T07:00:00Z'],
  );
}

/**
 * Asserts the database invariants that must hold after *any* sequence of
 * requests. Every concurrency test ends with this.
 */
export async function assertConsistent(classId: string): Promise<void> {
  const [cls] = await sql<{ capacity: number; booked_count: number }>(
    'SELECT capacity, booked_count FROM classes WHERE id = $1',
    [classId],
  );
  expect(cls).toBeDefined();

  const [booked] = await sql<{ active: number; total: number }>(
    `SELECT count(*) FILTER (WHERE status = 'booked')::int     AS active,
            count(*)::int                                      AS total
       FROM bookings WHERE class_id = $1`,
    [classId],
  );

  const [waitlisted] = await sql<{ active: number }>(
    `SELECT count(*)::int AS active FROM bookings
      WHERE class_id = $1 AND status = 'waitlisted'`,
    [classId],
  );

  // The stored counter, the CHECK constraint and the rows must all agree.
  expect(cls!.booked_count).toBe(booked!.active);
  expect(cls!.booked_count).toBeLessThanOrEqual(cls!.capacity);

  // No member may hold two active rows in the same class.
  const duplicates = await sql<{ member_id: string; n: number }>(
    `SELECT member_id, count(*)::int AS n
       FROM bookings
      WHERE class_id = $1 AND status IN ('booked', 'waitlisted')
      GROUP BY member_id HAVING count(*) > 1`,
    [classId],
  );
  expect(duplicates).toEqual([]);

  // A member cannot be booked and waitlisted at the same time.
  const overlap = await sql<{ member_id: string }>(
    `SELECT b.member_id
       FROM bookings b
      WHERE b.class_id = $1 AND b.status = 'booked'
        AND EXISTS (
          SELECT 1 FROM bookings w
           WHERE w.class_id = b.class_id AND w.member_id = b.member_id
             AND w.status = 'waitlisted'
        )`,
    [classId],
  );
  expect(overlap).toEqual([]);

  // Waitlisted rows always carry an ordering key, and ordering keys are unique.
  const [seq] = await sql<{ missing: number; distinct_count: number; rows: number }>(
    `SELECT count(*) FILTER (WHERE waitlist_seq IS NULL)::int   AS missing,
            count(DISTINCT waitlist_seq)::int                    AS distinct_count,
            count(*)::int                                        AS rows
       FROM bookings WHERE class_id = $1 AND status = 'waitlisted'`,
    [classId],
  );
  expect(seq!.missing).toBe(0);
  expect(seq!.distinct_count).toBe(seq!.rows);

  // The API view must match the stored state exactly.
  const view = await getClass(classId);
  expect(view.status).toBe(200);
  expect(view.body.booked_count).toBe(booked!.active);
  expect(view.body.booked_member_ids).toHaveLength(booked!.active);
  expect(new Set(view.body.booked_member_ids).size).toBe(booked!.active);
  expect(view.body.waitlist).toHaveLength(waitlisted!.active);
  view.body.waitlist.forEach((entry, index) => {
    expect(entry.position).toBe(index + 1);
  });
}
