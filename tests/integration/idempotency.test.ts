import {
  book,
  bootApi,
  call,
  cancel,
  createClass,
  createMember,
  errorCode,
  FUTURE,
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

describe('Idempotency-Key semantics', () => {
  it('returns 200 and the exact first body when the key is reused', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    const first = await book('c1', 'm1', 'key-1');
    const second = await book('c1', 'm1', 'key-1');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['m1']);
  });

  it('records exactly one idempotency row per key', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    await book('c1', 'm1', 'key-1');
    await book('c1', 'm1', 'key-1');
    await book('c1', 'm1', 'key-1');

    const rows = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'key-1'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('replays the original body even after the membership expires', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    const first = await book('c1', 'm1', 'key-1');
    await call('PATCH', '/members/m1', { membership_expires_at: PAST });

    const second = await book('c1', 'm1', 'key-1');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // A *new* key with the now-expired membership must be rejected.
    const third = await book('c1', 'm1', nextKey());
    expect(third.status).toBe(403);
    expect(errorCode(third.body)).toBe('membership_inactive');
  });

  it('replays a waitlisted response with its original position', async () => {
    await createMember('m1');
    await createMember('w1');
    await createClass('c1', 1);
    await book('c1', 'm1');

    const first = await book('c1', 'w1', 'wait-key');
    expect(first.body.status).toBe('waitlisted');
    expect(first.body.waitlist_position).toBe(1);

    // A second waiter joins, then the first replays: the stored position wins.
    await createMember('w2');
    await book('c1', 'w2');

    const replay = await book('c1', 'w1', 'wait-key');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.waitlist_position).toBe(1);
  });

  it('does not consume a key when the request failed', async () => {
    await createMember('expired', PAST);
    await createClass('c1', 1);

    const failed = await book('c1', 'expired', 'recover-key');
    expect(failed.status).toBe(403);

    // Same key, now a valid member: the key is still free because the failed
    // attempt was rolled back in full.
    await createMember('valid');
    const recovered = await book('c1', 'valid', 'recover-key');
    expect(recovered.status).toBe(201);
    expect(recovered.body.member_id).toBe('valid');
  });

  it('treats a key as global: the first successful response is replayed', async () => {
    await createMember('m1');
    await createMember('m2');
    await createClass('c1', 5);

    const first = await book('c1', 'm1', 'shared-key');
    const second = await book('c1', 'm2', 'shared-key');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(1);
    expect(detail.body.booked_member_ids).toEqual(['m1']);
  });

  it('requires a different key for a genuinely new booking attempt', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    await book('c1', 'm1', 'key-1');
    const differentKey = await book('c1', 'm1', 'key-2');
    expect(differentKey.status).toBe(409);
    expect(errorCode(differentKey.body)).toBe('already_booked');
  });

  it('keeps keys independent between classes', async () => {
    await createMember('m1');
    await createClass('c1', 1);
    await createClass('c2', 1);

    const first = await book('c1', 'm1', 'key-a');
    const second = await book('c2', 'm1', 'key-b');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.class_id).toBe('c2');
  });

  it('persists the stored response body so a replay survives a process restart', async () => {
    await createMember('m1');
    await createClass('c1', 1);

    const first = await book('c1', 'm1', 'durable-key');
    const stored = await sql<{ body: string; status: number }>(
      `SELECT response_body AS body, response_status AS status
         FROM idempotency_keys WHERE key = 'durable-key'`,
    );

    expect(stored[0]!.status).toBe(201);
    expect(JSON.parse(stored[0]!.body)).toEqual(first.body);
  });

  it('replays the original booking even after that booking was cancelled', async () => {
    await createMember('m1');
    await createClass('c1', 2);

    const first = await book('c1', 'm1', 'cancel-then-replay');
    expect((await cancel(first.body.booking_id)).status).toBe(200);

    const replay = await book('c1', 'm1', 'cancel-then-replay');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    // Nothing was re-created: the seat is still free and the queue is empty.
    const detail = await getClass('c1');
    expect(detail.body.booked_count).toBe(0);
    expect(detail.body.booked_member_ids).toEqual([]);
    expect(detail.body.waitlist).toEqual([]);

    const [rows] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings WHERE class_id = 'c1'`,
    );
    expect(rows!.n).toBe(1); // only the cancelled row
  });

  it('does not treat an unexpired key as consumed when the class is full', async () => {
    await createMember('m1');
    await createMember('m2');
    await createClass('c1', 1);
    await book('c1', 'm1');

    const waitlisted = await book('c1', 'm2', 'full-key');
    expect(waitlisted.status).toBe(201);
    expect(waitlisted.body.status).toBe('waitlisted');

    const replay = await book('c1', 'm2', 'full-key');
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(waitlisted.body);

    const detail = await getClass('c1');
    expect(detail.body.waitlist).toHaveLength(1);
    expect(detail.body.waitlist[0]!.position).toBe(1);
  });
});
