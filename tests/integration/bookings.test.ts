import {
  book,
  bootApi,
  call,
  cancel,
  createClass,
  createMember,
  errorCode,
  FUTURE,
  getBooking,
  getClass,
  nextKey,
  PAST,
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

describe('POST /classes/{id}/bookings — happy paths', () => {
  it('books a spot when capacity is free', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    const response = await book('c1', 'm1');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      booking_id: expect.any(String),
      class_id: 'c1',
      member_id: 'm1',
      status: 'booked',
    });
  });

  it('persists the booking and reflects it in the class view', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    const response = await book('c1', 'm1');
    const booking = await getBooking(response.body.booking_id);

    expect(booking.status).toBe(200);
    expect(booking.body).toEqual({
      booking_id: response.body.booking_id,
      class_id: 'c1',
      member_id: 'm1',
      status: 'booked',
      waitlist_position: null,
    });

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['m1']);
    expect(detail.body.waitlist).toEqual([]);
  });

  it('fills exactly to capacity and then waitlists', async () => {
    await createMember('m1');
    await createMember('m2');
    await createMember('m3');
    await createClass('c1', 2);

    const first = await book('c1', 'm1');
    const second = await book('c1', 'm2');
    const third = await book('c1', 'm3');

    expect(first.body.status).toBe('booked');
    expect(second.body.status).toBe('booked');
    expect(third.status).toBe(201);
    expect(third.body.status).toBe('waitlisted');
    expect(third.body.waitlist_position).toBe(1);

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(2);
    expect(detail.body.booked_member_ids.sort()).toEqual(['m1', 'm2']);
  });

  it('allows a member to book different classes', async () => {
    await createMember('m1');
    await createClass('c1', 1);
    await createClass('c2', 1);

    expect((await book('c1', 'm1')).status).toBe(201);
    expect((await book('c2', 'm1')).status).toBe(201);
  });

  it('accepts an academically long but valid idempotency key', async () => {
    await createMember('m1');
    await createClass('c1', 1);
    const response = await book('c1', 'm1', 'k'.repeat(255));
    expect(response.status).toBe(201);
  });
});

describe('POST /classes/{id}/bookings — rejections', () => {
  it('returns 400 when Idempotency-Key is missing', async () => {
    await createMember('m1');
    await createClass('c1', 1);

    const response = await call('POST', '/classes/c1/bookings', { member_id: 'm1' });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: expect.any(String) },
    });
    await expectNoBooking();
  });

  it('returns 400 when Idempotency-Key is blank', async () => {
    await createMember('m1');
    await createClass('c1', 1);
    const response = await book('c1', 'm1', '   ');
    expect(response.status).toBe(400);
  });

  it.each([
    ['missing member_id', {}],
    ['blank member_id', { member_id: '  ' }],
    ['numeric member_id', { member_id: 7 }],
    ['array member_id', { member_id: ['m1'] }],
  ])('returns 400 invalid_request for %s', async (_label, body) => {
    await createMember('m1');
    await createClass('c1', 1);
    const response = await call('POST', '/classes/c1/bookings', body, {
      'idempotency-key': nextKey(),
    });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: expect.any(String) },
    });
    await expectNoBooking();
  });

  it('returns 404 member_not_found', async () => {
    await createClass('c1', 1);
    const response = await book('c1', 'ghost');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'member_not_found', message: expect.any(String) },
    });
  });

  it('returns 404 class_not_found', async () => {
    await createMember('m1');
    const response = await book('missing', 'm1');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'class_not_found', message: expect.any(String) },
    });
  });

  it('returns 403 membership_inactive for an expired membership', async () => {
    await createMember('m1', PAST);
    await createClass('c1', 1);

    const response = await book('c1', 'm1');
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: 'membership_inactive', message: expect.any(String) },
    });
    await expectNoBooking();
  });

  it('treats an expiry equal to now as inactive', async () => {
    // A membership that has just expired is not "later than the current time".
    await createMember('m1', '2000-01-01T00:00:00Z');
    await createClass('c1', 1);
    const response = await book('c1', 'm1');
    expect(response.status).toBe(403);
  });

  it('returns 409 already_booked for a second booking in the same class', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    expect((await book('c1', 'm1')).status).toBe(201);
    const duplicate = await book('c1', 'm1');

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: { code: 'already_booked', message: expect.any(String) },
    });

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
  });

  it('returns 409 already_booked when the first entry is on the waitlist', async () => {
    await createMember('m1');
    await createMember('m2');
    await createClass('c1', 1);

    await book('c1', 'm1'); // booked
    const waitlisted = await book('c1', 'm2');
    expect(waitlisted.body.status).toBe('waitlisted');

    const duplicate = await book('c1', 'm2');
    expect(duplicate.status).toBe(409);
    expect(errorCode(duplicate.body)).toBe('already_booked');

    const detail = await getClass('c1');
    expect(detail.body.waitlist).toHaveLength(1);
  });

  it('exposes the conflict via the database uniqueness rule, not just the service check', async () => {
    await createMember('m1');
    await createClass('c1', 2);
    await book('c1', 'm1');

    await expect(
      sql(
        `INSERT INTO bookings (class_id, member_id, status) VALUES ('c1', 'm1', 'booked')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('GET /bookings/{id}', () => {
  it('returns 404 booking_not_found for an unknown uuid', async () => {
    const response = await call('GET', '/bookings/00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'booking_not_found', message: expect.any(String) },
    });
  });

  it('returns 404 rather than a database error for a malformed identifier', async () => {
    const response = await call('GET', '/bookings/not-a-uuid');
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('booking_not_found');
  });
});

describe('DELETE /bookings/{id}', () => {
  it('returns 404 booking_not_found for an unknown uuid', async () => {
    const response = await cancel('00000000-0000-4000-8000-000000000000');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a malformed identifier', async () => {
    const response = await call('DELETE', '/bookings/not-a-uuid');
    expect(response.status).toBe(404);
  });
});

describe('capacity is released by cancellation', () => {
  it('lets a new member take the freed spot without touching the waitlist', async () => {
    await createMember('m1');
    await createMember('m2');
    await createClass('c1', 1);

    const first = await book('c1', 'm1');
    expect(first.body.status).toBe('booked');
    expect((await book('c1', 'm2')).body.status).toBe('waitlisted');

    const cancelled = await cancel(first.body.booking_id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.promoted_booking_id).not.toBeNull();

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['m2']);
    expect(detail.body.waitlist).toEqual([]);
  });
});

async function expectNoBooking(): Promise<void> {
  const rows = await sql<{ n: number }>('SELECT count(*)::int AS n FROM bookings');
  expect(rows[0]!.n).toBe(0);
}

describe('membership expiry is evaluated with the database clock', () => {
  it('cannot book after the membership is expired through PATCH', async () => {
    await createMember('m1', FUTURE);
    await createClass('c1', 1);
    await call('PATCH', '/members/m1', { membership_expires_at: PAST });

    const response = await book('c1', 'm1');
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('membership_inactive');
  });
});
