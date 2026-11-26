import {
  book,
  bootApi,
  call,
  cancel,
  createClass,
  createMember,
  FUTURE,
  getClass,
  resetDb,
  shutdownApi,
  sql,
} from '../support/harness';

jest.setTimeout(60_000);

beforeAll(async () => {
  await bootApi();
});

afterAll(async () => {
  await shutdownApi();
});

beforeEach(async () => {
  await resetDb();
});

/**
 * These tests bypass the HTTP layer on purpose: they assert that the *database*
 * refuses states the API promises never to create. If the service logic were
 * ever wrong, these constraints are what stop it from corrupting data.
 */
describe('database constraints', () => {
  beforeEach(async () => {
    await createMember('m1');
    await createClass('c1', 2);
  });

  it('refuses a booked_count above capacity', async () => {
    await expect(
      sql(`UPDATE classes SET booked_count = capacity + 1 WHERE id = 'c1'`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a negative booked_count', async () => {
    await expect(
      sql(`UPDATE classes SET booked_count = -1 WHERE id = 'c1'`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a class with capacity below 1', async () => {
    await expect(
      sql(
        `INSERT INTO classes (id, name, capacity, starts_at)
         VALUES ('bad', 'Bad', 0, now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses two active rows for the same member and class', async () => {
    await book('c1', 'm1');
    await expect(
      sql(`INSERT INTO bookings (class_id, member_id, status) VALUES ('c1', 'm1', 'booked')`),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      sql(
        `INSERT INTO bookings (class_id, member_id, status, waitlist_seq)
         VALUES ('c1', 'm1', 'waitlisted', nextval('waitlist_order_seq'))`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('still allows a new booking after the previous one was cancelled', async () => {
    const first = await book('c1', 'm1');
    const cancelled = await cancel(first.body.booking_id);
    expect(cancelled.status).toBe(200);

    const again = await book('c1', 'm1');
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('booked');
    expect(again.body.booking_id).not.toBe(first.body.booking_id);
  });

  it('refuses a waitlisted row without an ordering key', async () => {
    await expect(
      sql(`INSERT INTO bookings (class_id, member_id, status) VALUES ('c1', 'm1', 'waitlisted')`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an unknown status', async () => {
    await expect(
      sql(`INSERT INTO bookings (class_id, member_id, status) VALUES ('c1', 'm1', 'maybe')`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses bookings for unknown classes or members (foreign keys)', async () => {
    await expect(
      sql(
        `INSERT INTO bookings (class_id, member_id, status) VALUES ('ghost-class', 'm1', 'booked')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      sql(
        `INSERT INTO bookings (class_id, member_id, status) VALUES ('c1', 'ghost-member', 'booked')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps the counter equal to the number of booked rows through a full lifecycle', async () => {
    await createMember('m2');
    await createMember('m3');

    const first = await book('c1', 'm1');
    expect((await book('c1', 'm2')).body.status).toBe('booked');
    expect((await book('c1', 'm3')).body.status).toBe('waitlisted');

    await cancel(first.body.booking_id); // m3 is promoted

    const [row] = await sql<{ booked_count: number; booked_rows: number }>(
      `SELECT c.booked_count,
              (SELECT count(*)::int FROM bookings b
                WHERE b.class_id = c.id AND b.status = 'booked') AS booked_rows
         FROM classes c WHERE c.id = 'c1'`,
    );
    expect(row!.booked_count).toBe(2);
    expect(row!.booked_rows).toBe(2);

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(2);
    expect(detail.body.booked_member_ids.sort()).toEqual(['m2', 'm3']);
    expect(detail.body.waitlist).toEqual([]);
  });

  it('never decrements twice when the same cancellation is repeated', async () => {
    const booking = await book('c1', 'm1');
    expect((await cancel(booking.body.booking_id)).status).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const repeated = await cancel(booking.body.booking_id);
      expect(repeated.status).toBe(409);
    }

    const [row] = await sql<{ booked_count: number }>(
      `SELECT booked_count FROM classes WHERE id = 'c1'`,
    );
    expect(row!.booked_count).toBe(0);
  });
});

describe('capacity validation boundaries', () => {
  it('accepts a capacity well beyond one million (no invented product limit)', async () => {
    const response = await createClass('big', 1_000_001);
    expect(response.status).toBe(201);
    expect(response.body.capacity).toBe(1_000_001);
  });

  it('accepts the largest capacity the column can store', async () => {
    const response = await createClass('max', 2_147_483_647);
    expect(response.status).toBe(201);
    expect(response.body.capacity).toBe(2_147_483_647);

    const detail = await getClass('max');
    expect(detail.status).toBe(200);
    expect(detail.body.capacity).toBe(2_147_483_647);
    expect(detail.body.booked_count).toBe(0);
  });

  it('rejects a capacity the column cannot store with 400, not 500', async () => {
    const tooBig = await createClass('x1', 2_147_483_648);
    expect(tooBig.status).toBe(400);
    expect((tooBig.body as { error: { code: string } }).error.code).toBe('invalid_request');

    const absurd = await createClass('x2', 1e15);
    expect(absurd.status).toBe(400);
  });

  it('accepts capacity 1 and rejects 0 and negatives', async () => {
    expect((await createClass('one', 1)).status).toBe(201);
    expect((await createClass('zero', 0)).status).toBe(400);
    expect((await createClass('negative', -5)).status).toBe(400);
  });
});

describe('POST /admin/reset under concurrent traffic', () => {
  it('never fails with a server error and leaves the database empty', async () => {
    const members = Array.from({ length: 20 }, (_unused, index) => `r${index + 1}`);
    for (const member of members) await createMember(member, FUTURE);
    await createClass('c1', 5);

    // Reset races 20 in-flight bookings. Either the booking wins (and is then
    // wiped) or the class is already gone (404) — never a 5xx, never a
    // half-truncated database.
    const [bookings, reset] = await Promise.all([
      Promise.all(members.map((member) => book('c1', member))),
      call('POST', '/admin/reset'),
    ]);

    expect(reset.status).toBe(204);
    const serverErrors = bookings.filter((response) => response.status >= 500);
    expect(serverErrors).toEqual([]);

    const [counts] = await sql<{ bookings: number; classes: number; members: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM bookings)         AS bookings,
              (SELECT count(*)::int FROM classes)          AS classes,
              (SELECT count(*)::int FROM members)          AS members,
              (SELECT count(*)::int FROM idempotency_keys) AS keys`,
    );
    expect(counts).toEqual({ bookings: 0, classes: 0, members: 0, keys: 0 });
  });
});
