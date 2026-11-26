import {
  assertConsistent,
  book,
  bootApi,
  call,
  cancel,
  getClass,
  PAST,
  resetDb,
  seedClass,
  seedMembers,
  shutdownApi,
  sql,
} from '../support/harness';

jest.setTimeout(180_000);

beforeAll(async () => {
  await bootApi();
});

afterAll(async () => {
  await shutdownApi();
});

beforeEach(async () => {
  await resetDb();
});

function memberIds(count: number, prefix = 'm'): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}${index + 1}`);
}

describe('concurrent cancellations', () => {
  it('promotes exactly the first eligible waiters, once each, with no oversell', async () => {
    const members = memberIds(25);
    await seedMembers(members);
    await seedClass('c1', 5);

    const initial = await Promise.all(members.map((member) => book('c1', member)));
    const booked = initial.filter((r) => r.body.status === 'booked');
    const waitlisted = initial
      .filter((r) => r.body.status === 'waitlisted')
      .sort((a, b) => a.body.waitlist_position! - b.body.waitlist_position!);

    expect(booked).toHaveLength(5);
    expect(waitlisted).toHaveLength(20);

    // All five seats are released at the same instant.
    const cancellations = await Promise.all(booked.map((r) => cancel(r.body.booking_id)));

    expect(cancellations.every((r) => r.status === 200)).toBe(true);
    const promoted = cancellations.map((r) => r.body.promoted_booking_id);
    expect(promoted.every((id) => id !== null)).toBe(true);
    expect(new Set(promoted).size).toBe(5);

    const expectedPromotions = new Set(waitlisted.slice(0, 5).map((r) => r.body.booking_id));
    expect(new Set(promoted)).toEqual(expectedPromotions);

    await assertConsistent('c1');

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(5);

    // The five cancelled seats are gone; the five promoted members hold them.
    const expectedBooked = waitlisted
      .slice(0, 5)
      .map((r) => r.body.member_id)
      .sort();
    expect([...detail.body.booked_member_ids].sort()).toEqual(expectedBooked);

    // The tail of the queue keeps its order and positions restart at 1.
    expect(detail.body.waitlist.map((entry) => entry.member_id)).toEqual(
      waitlisted.slice(5).map((r) => r.body.member_id),
    );
    expect(detail.body.waitlist.map((entry) => entry.position)).toEqual(
      Array.from({ length: 15 }, (_unused, index) => index + 1),
    );
  });

  it('skips expired waiters while several cancellations run in parallel', async () => {
    const bookedMembers = ['b1', 'b2', 'b3'];
    const waiters = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];

    await seedMembers(bookedMembers);
    // Everyone is active when they queue; the first two expire while waiting,
    // exactly like the official checker's scenario.
    await seedMembers(waiters);
    await seedClass('c1', 3);

    const initial = await Promise.all(bookedMembers.map((member) => book('c1', member)));
    expect(initial.filter((r) => r.body.status === 'booked')).toHaveLength(3);

    // Enqueued one at a time so the FIFO order (and therefore which entries are
    // expired) is deterministic.
    const queued: Array<Awaited<ReturnType<typeof book>>> = [];
    for (const member of waiters) {
      queued.push(await book('c1', member));
    }
    expect(queued.filter((r) => r.body.status === 'waitlisted')).toHaveLength(6);

    for (const member of ['w1', 'w2']) {
      const patched = await call('PATCH', `/members/${member}`, { membership_expires_at: PAST });
      expect(patched.status).toBe(200);
    }

    const cancellations = await Promise.all(initial.map((r) => cancel(r.body.booking_id)));
    const promoted = cancellations.map((r) => r.body.promoted_booking_id);

    // Three seats, three eligible waiters, both expired entries skipped.
    expect(new Set(promoted)).toEqual(
      new Set(queued.slice(2, 5).map((r) => r.body.booking_id)),
    );

    await assertConsistent('c1');

    const statuses = await sql<{ member_id: string; status: string }>(
      `SELECT member_id, status FROM bookings WHERE class_id = 'c1' ORDER BY member_id`,
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        { member_id: 'w1', status: 'skipped' },
        { member_id: 'w2', status: 'skipped' },
        { member_id: 'w3', status: 'booked' },
        { member_id: 'w4', status: 'booked' },
        { member_id: 'w5', status: 'booked' },
        { member_id: 'w6', status: 'waitlisted' },
      ]),
    );
  });

  it('never promotes twice when the same booking is cancelled in parallel', async () => {
    await seedMembers(['b1', 'w1', 'w2']);
    await seedClass('c1', 1);

    const booked = await book('c1', 'b1');
    const first = await book('c1', 'w1');
    await book('c1', 'w2');

    const attempts = await Promise.all(
      Array.from({ length: 50 }, () => cancel(booked.body.booking_id)),
    );

    const ok = attempts.filter((r) => r.status === 200);
    const conflicts = attempts.filter((r) => r.status === 409);

    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(49);
    expect(ok[0]!.body.promoted_booking_id).toBe(first.body.booking_id);

    await assertConsistent('c1');

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['w1']);
    expect(detail.body.waitlist.map((entry) => entry.member_id)).toEqual(['w2']);
  });
});
