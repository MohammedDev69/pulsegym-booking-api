import {
  assertConsistent,
  book,
  bootApi,
  cancel,
  errorCode,
  getClass,
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

describe('capacity under concurrent load', () => {
  it('never sells more than 20 seats for 200 simultaneous bookings', async () => {
    const members = memberIds(200);
    await seedMembers(members);
    await seedClass('c1', 20);

    const responses = await Promise.all(members.map((member) => book('c1', member)));

    const booked = responses.filter((r) => r.status === 201 && r.body.status === 'booked');
    const waitlisted = responses.filter((r) => r.status === 201 && r.body.status === 'waitlisted');
    const unexpected = responses.filter((r) => r.status !== 201);

    expect(unexpected).toEqual([]);
    expect(booked).toHaveLength(20);
    expect(waitlisted).toHaveLength(180);

    // Positions handed out in the responses must be exactly 1..180, once each.
    const positions = waitlisted.map((r) => r.body.waitlist_position).sort((a, b) => a! - b!);
    expect(positions).toEqual(Array.from({ length: 180 }, (_unused, index) => index + 1));

    await assertConsistent('c1');

    const [row] = await sql<{ booked: number }>(
      `SELECT count(*)::int AS booked FROM bookings WHERE class_id = 'c1' AND status = 'booked'`,
    );
    expect(row!.booked).toBe(20);
  });

  it('sells exactly one seat when 150 members fight for the last spot', async () => {
    const members = memberIds(150);
    await seedMembers(members);
    await seedClass('last-seat', 1);

    const responses = await Promise.all(members.map((member) => book('last-seat', member)));

    expect(responses.filter((r) => r.body.status === 'booked')).toHaveLength(1);
    expect(responses.filter((r) => r.body.status === 'waitlisted')).toHaveLength(149);

    await assertConsistent('last-seat');
  });

  it('keeps separate classes independent under a parallel storm', async () => {
    const classIds = ['a', 'b', 'c', 'd', 'e'];
    const members = memberIds(40);

    await seedMembers(members);
    await Promise.all(classIds.map((id) => seedClass(id, 3)));

    const responses = await Promise.all(
      classIds.flatMap((classId) => members.map((member) => book(classId, member))),
    );

    for (const classId of classIds) {
      const booked = responses.filter(
        (r) => r.body.class_id === classId && r.body.status === 'booked',
      );
      expect(booked).toHaveLength(3);
      await assertConsistent(classId);
    }
  });

  it('stays correct across repeated storms', async () => {
    for (let round = 1; round <= 3; round += 1) {
      const classId = `storm-${round}`;
      const members = memberIds(60, `r${round}-m`);
      await seedMembers(members);
      await seedClass(classId, 7);

      const responses = await Promise.all(members.map((member) => book(classId, member)));
      expect(responses.filter((r) => r.body.status === 'booked')).toHaveLength(7);
      await assertConsistent(classId);
    }
  });
});

describe('duplicate requests under concurrent load', () => {
  it('creates one active entry per member even with several parallel keys', async () => {
    const members = memberIds(50);
    await seedMembers(members);
    await seedClass('c1', 10);

    // 150 simultaneous requests: every member tries three times.
    const responses = await Promise.all(
      members.flatMap((member) => [
        book('c1', member),
        book('c1', member),
        book('c1', member),
      ]),
    );

    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(50);
    expect(conflicts).toHaveLength(100);
    expect(conflicts.every((r) => errorCode(r.body) === 'already_booked')).toBe(true);

    await assertConsistent('c1');

    const [row] = await sql<{ members: number; waitlisted: number }>(
      `SELECT count(DISTINCT member_id)::int AS members,
              count(*) FILTER (WHERE status = 'waitlisted')::int AS waitlisted
         FROM bookings WHERE class_id = 'c1' AND status IN ('booked', 'waitlisted')`,
    );
    expect(row!.members).toBe(50);
    expect(row!.waitlisted).toBe(40);
  });

  it('runs a single logical booking for many identical concurrent keys', async () => {
    const members = memberIds(50);
    await seedMembers(members);
    await seedClass('c1', 3);

    const responses = await Promise.all(
      members.map((member) => book('c1', member, 'the-same-key')),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(49);

    const bodies = new Set(responses.map((r) => JSON.stringify(r.body)));
    expect(bodies.size).toBe(1);

    await assertConsistent('c1');

    const [keys] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'the-same-key'`,
    );
    expect(keys!.n).toBe(1);
  });

  it('collapses concurrent duplicates onto a single waitlist entry when the class is full', async () => {
    await seedMembers(['holder', 'waiter']);
    await seedClass('c1', 1);
    await book('c1', 'holder');

    const responses = await Promise.all(
      Array.from({ length: 40 }, () => book('c1', 'waiter', 'waitlist-storm')),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(39);
    expect(new Set(responses.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(responses[0]!.body.status).toBe('waitlisted');
    expect(responses[0]!.body.waitlist_position).toBe(1);

    await assertConsistent('c1');

    const detail = await getClass('c1');
    expect(detail.body.waitlist).toHaveLength(1);
    expect(detail.body.waitlist[0]!.member_id).toBe('waiter');

    const [rows] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings
        WHERE class_id = 'c1' AND member_id = 'waiter'`,
    );
    expect(rows!.n).toBe(1);
  });

  it('leaves no trace when many concurrent requests share a key that fails', async () => {
    await seedMembers(['expired'], '2000-01-01T00:00:00Z');
    await seedClass('c1', 3);

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => book('c1', 'expired', 'failing-key')),
    );

    // Every attempt is rejected and every rollback removed its idempotency row,
    // so the key is neither consumed nor half-written.
    expect(responses.every((r) => r.status === 403)).toBe(true);

    const [counts] = await sql<{ bookings: number; keys: number }>(
      `SELECT (SELECT count(*)::int FROM bookings)         AS bookings,
              (SELECT count(*)::int FROM idempotency_keys) AS keys`,
    );
    expect(counts!.bookings).toBe(0);
    expect(counts!.keys).toBe(0);

    // The same key still works once the member is eligible again.
    await sql(`UPDATE members SET membership_expires_at = '2099-12-31T23:59:59Z'
               WHERE id = 'expired'`);
    const recovered = await book('c1', 'expired', 'failing-key');
    expect(recovered.status).toBe(201);
    expect(recovered.body.status).toBe('booked');
  });
});

describe('booking and cancellation interleaved', () => {
  it('never oversells when bookings and cancellations run at the same time', async () => {
    const members = memberIds(40);
    await seedMembers(members);
    await seedClass('c1', 5);

    const initial = await Promise.all(members.map((member) => book('c1', member)));
    const bookedIds = initial
      .filter((r) => r.body.status === 'booked')
      .map((r) => r.body.booking_id);
    expect(bookedIds).toHaveLength(5);

    // Cancel two seats while ten new members try to book, all at once.
    const extra = memberIds(10, 'x');
    await seedMembers(extra);

    const [cancelResults] = await Promise.all([
      Promise.all(bookedIds.slice(0, 2).map((id) => cancel(id))),
      Promise.all(extra.map((member) => book('c1', member))),
    ]);

    expect(cancelResults.every((r) => r.status === 200)).toBe(true);
    await assertConsistent('c1');
  });

  it('hands the freed last seat to exactly one member when cancel and book race', async () => {
    await seedMembers(['m1', 'm2']);
    await seedClass('c1', 1);
    const first = await book('c1', 'm1');

    // Either the cancellation wins (m2 takes the free seat directly) or the
    // booking wins (m2 is waitlisted and promoted by the cancellation). Both
    // orderings must end with the same state.
    const [cancelled, booked] = await Promise.all([
      cancel(first.body.booking_id),
      book('c1', 'm2'),
    ]);

    expect(cancelled.status).toBe(200);
    expect(booked.status).toBe(201);

    await assertConsistent('c1');
    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['m2']);
    expect(detail.body.waitlist).toEqual([]);
  });

  it('keeps every invariant when five cancellations overlap ten new bookings', async () => {
    const members = memberIds(60);
    await seedMembers(members);
    await seedClass('c1', 5);

    const initial = await Promise.all(members.map((member) => book('c1', member)));
    const bookedIds = initial
      .filter((r) => r.body.status === 'booked')
      .map((r) => r.body.booking_id);
    expect(bookedIds).toHaveLength(5);
    expect(initial.filter((r) => r.body.status === 'waitlisted')).toHaveLength(55);

    const newcomers = memberIds(10, 'n');
    await seedMembers(newcomers);

    await Promise.all([
      ...bookedIds.map((id) => cancel(id)),
      ...newcomers.map((member) => book('c1', member)),
    ]);

    await assertConsistent('c1');

    // Five seats stay full, and the queue size is invariant: 55 original waiters
    // minus the promotions plus the 10 newcomers, regardless of interleaving.
    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(5);
    expect(detail.body.waitlist).toHaveLength(60);

    const [rows] = await sql<{ cancelled: number; total: number }>(
      `SELECT count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*)::int                                    AS total
         FROM bookings WHERE class_id = 'c1'`,
    );
    expect(rows!.cancelled).toBe(5);
    expect(rows!.total).toBe(70);
  });
});
