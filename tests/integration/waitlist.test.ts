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
  PAST,
  resetDb,
  shutdownApi,
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
 * Creates a class of `capacity` booked members plus a queue of waitlisted ones.
 *
 * Waiters always join while active — a member with an expired membership cannot
 * join a waitlist — and are expired *after* queueing when the test needs a
 * member whose eligibility lapses while waiting.
 */
async function buildQueue(
  capacity: number,
  waiters: Array<{ id: string; expiresAt?: string }>,
): Promise<{ booked: string[]; waitlisted: Array<{ memberId: string; bookingId: string }> }> {
  await createClass('c1', capacity);

  const booked: string[] = [];
  for (let index = 0; index < capacity; index += 1) {
    const memberId = `b${index + 1}`;
    await createMember(memberId, FUTURE);
    const response = await book('c1', memberId);
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('booked');
    booked.push(response.body.booking_id);
  }

  const waitlisted: Array<{ memberId: string; bookingId: string }> = [];
  for (const waiter of waiters) {
    await createMember(waiter.id, FUTURE);
    const response = await book('c1', waiter.id);
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('waitlisted');
    waitlisted.push({ memberId: waiter.id, bookingId: response.body.booking_id });
  }

  for (const [index, waiter] of waiters.entries()) {
    if (waiter.expiresAt !== undefined) {
      const patched = await call('PATCH', `/members/${waiter.id}`, {
        membership_expires_at: waiter.expiresAt,
      });
      expect(patched.status).toBe(200);
      expect(waitlisted[index]!.memberId).toBe(waiter.id);
    }
  }

  return { booked, waitlisted };
}

describe('waitlist ordering', () => {
  it('numbers positions 1..n in acceptance order', async () => {
    await createClass('c1', 1);
    await createMember('m1');
    await book('c1', 'm1');

    for (const id of ['w1', 'w2', 'w3', 'w4']) {
      await createMember(id);
      const response = await book('c1', id);
      expect(response.body.waitlist_position).toBe(Number(id.slice(1)));
    }

    const detail = await getClass('c1');
    expect(detail.body.waitlist.map((entry) => entry.member_id)).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
    ]);
    expect(detail.body.waitlist.map((entry) => entry.position)).toEqual([1, 2, 3, 4]);
  });

  it('reports the position of a waitlisted booking on GET /bookings/{id}', async () => {
    await createClass('c1', 1);
    await createMember('m1');
    await book('c1', 'm1');
    await createMember('w1');
    await book('c1', 'w1');
    await createMember('w2');
    const second = await book('c1', 'w2');

    const booking = await getBooking(second.body.booking_id);
    expect(booking.body.status).toBe('waitlisted');
    expect(booking.body.waitlist_position).toBe(2);
  });
});

describe('cancellation and promotion', () => {
  it('promotes the first waitlisted member when a booked spot is cancelled', async () => {
    const { booked, waitlisted } = await buildQueue(1, [{ id: 'w1' }, { id: 'w2' }]);

    const response = await cancel(booked[0]!);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      booking_id: booked[0],
      status: 'cancelled',
      promoted_booking_id: waitlisted[0]!.bookingId,
    });

    const promoted = await getBooking(waitlisted[0]!.bookingId);
    expect(promoted.body.status).toBe('booked');
    expect(promoted.body.waitlist_position).toBeNull();

    // The remaining waiter moves up to position 1 with no gap.
    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['w1']);
    expect(detail.body.waitlist).toEqual([
      { booking_id: waitlisted[1]!.bookingId, member_id: 'w2', position: 1 },
    ]);
  });

  it('skips an expired member and promotes the next one', async () => {
    const { booked, waitlisted } = await buildQueue(1, [
      { id: 'w1', expiresAt: PAST },
      { id: 'w2' },
    ]);

    const response = await cancel(booked[0]!);
    expect(response.body.promoted_booking_id).toBe(waitlisted[1]!.bookingId);

    const skipped = await getBooking(waitlisted[0]!.bookingId);
    expect(skipped.body.status).toBe('skipped');
    expect(skipped.body.waitlist_position).toBeNull();

    const promoted = await getBooking(waitlisted[1]!.bookingId);
    expect(promoted.body.status).toBe('booked');
  });

  it('skips several expired members in one pass', async () => {
    const { booked, waitlisted } = await buildQueue(1, [
      { id: 'w1', expiresAt: PAST },
      { id: 'w2', expiresAt: PAST },
      { id: 'w3', expiresAt: PAST },
      { id: 'w4' },
      { id: 'w5' },
    ]);

    const response = await cancel(booked[0]!);
    expect(response.body.promoted_booking_id).toBe(waitlisted[3]!.bookingId);

    for (const index of [0, 1, 2]) {
      const skipped = await getBooking(waitlisted[index]!.bookingId);
      expect(skipped.body.status).toBe('skipped');
    }

    const detail = await getClass('c1');
    expect(detail.body.waitlist).toHaveLength(1);
    expect(detail.body.waitlist[0]).toEqual({
      booking_id: waitlisted[4]!.bookingId,
      member_id: 'w5',
      position: 1,
    });
  });

  it('returns promoted_booking_id null when the waitlist is empty', async () => {
    const { booked } = await buildQueue(1, []);
    const response = await cancel(booked[0]!);
    expect(response.status).toBe(200);
    expect(response.body.promoted_booking_id).toBeNull();

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(0);
    expect(detail.body.waitlist).toEqual([]);
  });

  it('returns promoted_booking_id null when every waiter is ineligible', async () => {
    const { booked, waitlisted } = await buildQueue(1, [
      { id: 'w1', expiresAt: PAST },
      { id: 'w2', expiresAt: PAST },
    ]);

    const response = await cancel(booked[0]!);
    expect(response.status).toBe(200);
    expect(response.body.promoted_booking_id).toBeNull();

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(0);
    expect(detail.body.waitlist).toEqual([]);

    // Both entries are terminal, so the seat stays free for a new booking.
    await createMember('late');
    const late = await book('c1', 'late');
    expect(late.body.status).toBe('booked');
    void waitlisted;
  });

  it('does not promote when a waitlist entry is cancelled', async () => {
    const { booked, waitlisted } = await buildQueue(1, [{ id: 'w1' }, { id: 'w2' }]);

    const response = await cancel(waitlisted[0]!.bookingId);
    expect(response.status).toBe(200);
    expect(response.body.promoted_booking_id).toBeNull();

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['b1']);
    expect(detail.body.waitlist).toEqual([
      { booking_id: waitlisted[1]!.bookingId, member_id: 'w2', position: 1 },
    ]);
    void booked;
  });

  it('keeps positions contiguous after several cancellations', async () => {
    await buildQueue(1, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }]);
    const before = await getClass('c1');

    await cancel(before.body.waitlist[1]!.booking_id); // cancel position 2
    await cancel(before.body.waitlist[2]!.booking_id); // cancel position 3

    const after = await getClass('c1');
    expect(after.body.waitlist).toEqual([
      { booking_id: before.body.waitlist[0]!.booking_id, member_id: 'w1', position: 1 },
      { booking_id: before.body.waitlist[3]!.booking_id, member_id: 'w4', position: 2 },
    ]);
  });
});

describe('cancellation errors', () => {
  it('returns 409 already_cancelled when cancelling twice', async () => {
    const { booked } = await buildQueue(1, [{ id: 'w1' }]);

    expect((await cancel(booked[0]!)).status).toBe(200);
    const second = await cancel(booked[0]!);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: { code: 'already_cancelled', message: expect.any(String) },
    });
  });

  it('returns 409 for cancelling an already skipped entry', async () => {
    const { booked, waitlisted } = await buildQueue(1, [{ id: 'w1', expiresAt: PAST }, { id: 'w2' }]);
    await cancel(booked[0]!);

    const response = await cancel(waitlisted[0]!.bookingId);
    expect(response.status).toBe(409);
    expect(errorCode(response.body)).toBe('already_cancelled');
  });

  it('reports a cancelled booking as cancelled on GET', async () => {
    const { booked } = await buildQueue(1, []);
    await cancel(booked[0]!);

    const booking = await getBooking(booked[0]!);
    expect(booking.body.status).toBe('cancelled');
    expect(booking.body.waitlist_position).toBeNull();
  });
});

describe('eligibility changes after joining the waitlist', () => {
  it('skips a member whose membership expired while waiting', async () => {
    const { booked, waitlisted } = await buildQueue(1, [{ id: 'w1' }, { id: 'w2' }]);

    // The checker does exactly this: expire the first waiter, then cancel.
    await call('PATCH', '/members/w1', { membership_expires_at: PAST });

    const response = await cancel(booked[0]!);
    expect(response.body.promoted_booking_id).toBe(waitlisted[1]!.bookingId);
    expect((await getBooking(waitlisted[0]!.bookingId)).body.status).toBe('skipped');
  });

  it('lets a skipped member rejoin the waitlist later', async () => {
    const { booked, waitlisted } = await buildQueue(1, [
      { id: 'w1', expiresAt: PAST },
      { id: 'w2' },
      { id: 'w3' },
    ]);
    await cancel(booked[0]!);
    expect((await getBooking(waitlisted[0]!.bookingId)).body.status).toBe('skipped');

    // w1 restores their membership and queues again: a new entry, at the back.
    await call('PATCH', '/members/w1', { membership_expires_at: FUTURE });
    const rejoin = await book('c1', 'w1');
    expect(rejoin.status).toBe(201);
    expect(rejoin.body.status).toBe('waitlisted');
    expect(rejoin.body.waitlist_position).toBe(2);
    expect(rejoin.body.booking_id).not.toBe(waitlisted[0]!.bookingId);
  });

  it('promotes at most one member per released seat', async () => {
    const { booked } = await buildQueue(1, [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }]);

    const response = await cancel(booked[0]!);
    expect(response.body.promoted_booking_id).not.toBeNull();

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['w1']);
    expect(detail.body.waitlist.map((entry) => entry.member_id)).toEqual(['w2', 'w3', 'w4']);
    expect(detail.body.waitlist.map((entry) => entry.position)).toEqual([1, 2, 3]);
  });

  it('promotes a waiter whose membership was extended again before the seat opened', async () => {
    const { booked, waitlisted } = await buildQueue(1, [{ id: 'w1' }, { id: 'w2' }]);

    // Expire, then restore before the cancellation: eligibility is decided when
    // the seat opens, not when the member joined the queue.
    await call('PATCH', '/members/w1', { membership_expires_at: PAST });
    await call('PATCH', '/members/w1', { membership_expires_at: FUTURE });

    const response = await cancel(booked[0]!);
    expect(response.body.promoted_booking_id).toBe(waitlisted[0]!.bookingId);
    expect((await getBooking(waitlisted[0]!.bookingId)).body.status).toBe('booked');
    expect((await getBooking(waitlisted[1]!.bookingId)).body.status).toBe('waitlisted');
  });

  it('lets a member rejoin at the back after cancelling their own booked seat', async () => {
    const { booked, waitlisted } = await buildQueue(1, [{ id: 'w1' }]);

    // b1 cancels, w1 is promoted, then b1 books again: the class is full again,
    // so b1 goes to the back of the queue with a brand-new booking.
    await cancel(booked[0]!);
    const rebook = await book('c1', 'b1');
    expect(rebook.status).toBe(201);
    expect(rebook.body.status).toBe('waitlisted');
    expect(rebook.body.waitlist_position).toBe(1);
    expect(rebook.body.booking_id).not.toBe(booked[0]);

    const detail = await getClass('c1');
    expect(detail.body.booked_member_ids).toEqual(['w1']);
    expect(detail.body.waitlist).toEqual([
      { booking_id: rebook.body.booking_id, member_id: 'b1', position: 1 },
    ]);
    void waitlisted;
  });
});
