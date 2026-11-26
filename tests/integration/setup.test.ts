import http from 'node:http';
import {
  baseUrl,
  bootApi,
  call,
  createClass,
  createMember,
  errorCode,
  FUTURE,
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

describe('health', () => {
  it('reports ok with the documented body', async () => {
    const response = await call('GET', '/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('POST /admin/reset', () => {
  it('returns 204 with no body and deletes all data', async () => {
    await createMember('m1');
    await createClass('c1', 1);

    const response = await call('POST', '/admin/reset');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();

    const members = await sql<{ n: number }>('SELECT count(*)::int AS n FROM members');
    const classes = await sql<{ n: number }>('SELECT count(*)::int AS n FROM classes');
    expect(members[0]!.n).toBe(0);
    expect(classes[0]!.n).toBe(0);
  });

  it('clears idempotency records so keys can be reused after a reset', async () => {
    await createMember('m1');
    await createClass('c1', 1);

    const first = await call(
      'POST',
      '/classes/c1/bookings',
      { member_id: 'm1' },
      { 'idempotency-key': 'reused-key' },
    );
    expect(first.status).toBe(201);

    await resetDb();
    await createMember('m1');
    await createClass('c1', 1);

    const second = await call(
      'POST',
      '/classes/c1/bookings',
      { member_id: 'm1' },
      { 'idempotency-key': 'reused-key' },
    );
    expect(second.status).toBe(201);
  });
});

describe('POST /members', () => {
  it('creates a member and echoes the payload', async () => {
    const response = await createMember('m-001', FUTURE, 'Sara');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: 'm-001',
      name: 'Sara',
      membership_expires_at: FUTURE,
    });
  });

  it('normalises the timestamp to UTC without changing whole seconds', async () => {
    const response = await createMember('m-002', '2026-06-01T09:00:00+02:00');
    expect(response.status).toBe(201);
    expect(response.body.membership_expires_at).toBe('2026-06-01T07:00:00Z');
  });

  it('returns 409 member_exists for a duplicate id', async () => {
    await createMember('dup');
    const response = await createMember('dup');
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'member_exists', message: expect.any(String) },
    });
  });

  it.each([
    ['missing id', { name: 'x', membership_expires_at: FUTURE }],
    ['missing name', { id: 'x', membership_expires_at: FUTURE }],
    ['missing expiry', { id: 'x', name: 'x' }],
    ['blank id', { id: '  ', name: 'x', membership_expires_at: FUTURE }],
    ['bad expiry', { id: 'x', name: 'x', membership_expires_at: 'soon' }],
    ['numeric id', { id: 12, name: 'x', membership_expires_at: FUTURE }],
  ])('returns 400 invalid_request for %s', async (_label, body) => {
    const response = await call('POST', '/members', body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: expect.any(String) },
    });
  });

  it('rejects a non-object body', async () => {
    const response = await call('POST', '/members', [1, 2, 3]);
    expect(response.status).toBe(400);
  });

  it('rejects malformed JSON without leaking parser details', async () => {
    const response = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: Number(new URL(baseUrl()).port),
          path: '/members',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
          });
        },
      );
      req.on('error', reject);
      req.write('{"id": "x", ');
      req.end();
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: expect.any(String) },
    });
  });
});

describe('PATCH /members/{id}', () => {
  it('updates the membership end date', async () => {
    await createMember('m1', FUTURE);
    const response = await call('PATCH', '/members/m1', { membership_expires_at: PAST });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 'm1',
      name: 'Member m1',
      membership_expires_at: '2000-01-01T00:00:00Z',
    });
  });

  it('can extend and shorten a membership repeatedly', async () => {
    await createMember('m1', PAST);
    await call('PATCH', '/members/m1', { membership_expires_at: FUTURE });
    const response = await call('PATCH', '/members/m1', {
      membership_expires_at: '2026-01-01T00:00:00Z',
    });
    expect(response.status).toBe(200);
    expect(response.body.membership_expires_at).toBe('2026-01-01T00:00:00Z');
  });

  it('returns 404 member_not_found', async () => {
    const response = await call('PATCH', '/members/ghost', { membership_expires_at: FUTURE });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'member_not_found', message: expect.any(String) },
    });
  });

  it('returns 400 when the body is empty or the date is invalid', async () => {
    await createMember('m1');
    expect((await call('PATCH', '/members/m1', {})).status).toBe(400);
    expect((await call('PATCH', '/members/m1', { membership_expires_at: 'nope' })).status).toBe(400);
  });
});

describe('POST /classes', () => {
  it('creates a class and returns it', async () => {
    const response = await createClass('c-yoga-1', 20);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: 'c-yoga-1',
      name: 'Class c-yoga-1',
      capacity: 20,
      starts_at: '2026-12-05T07:00:00Z',
    });
  });

  it('returns 409 class_exists for a duplicate id', async () => {
    await createClass('c1', 2);
    const response = await createClass('c1', 5);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'class_exists', message: expect.any(String) },
    });
  });

  it.each([
    ['capacity 0', { id: 'x', name: 'x', capacity: 0, starts_at: '2026-12-05T07:00:00Z' }],
    ['negative capacity', { id: 'x', name: 'x', capacity: -3, starts_at: '2026-12-05T07:00:00Z' }],
    ['fractional capacity', { id: 'x', name: 'x', capacity: 2.5, starts_at: '2026-12-05T07:00:00Z' }],
    ['string capacity', { id: 'x', name: 'x', capacity: '20', starts_at: '2026-12-05T07:00:00Z' }],
    ['missing capacity', { id: 'x', name: 'x', starts_at: '2026-12-05T07:00:00Z' }],
    ['missing starts_at', { id: 'x', name: 'x', capacity: 1 }],
    ['bad starts_at', { id: 'x', name: 'x', capacity: 1, starts_at: 'later' }],
    ['missing id', { name: 'x', capacity: 1, starts_at: '2026-12-05T07:00:00Z' }],
  ])('returns 400 invalid_request for %s', async (_label, body) => {
    const response = await call('POST', '/classes', body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: expect.any(String) },
    });
  });
});

describe('GET /classes/{id}', () => {
  it('returns an empty class', async () => {
    await createClass('c1', 3);
    const response = await call('GET', '/classes/c1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: 'c1',
      name: 'Class c1',
      capacity: 3,
      booked_count: 0,
      booked_member_ids: [],
      waitlist: [],
    });
  });

  it('returns 404 class_not_found', async () => {
    const response = await call('GET', '/classes/missing');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'class_not_found', message: expect.any(String) },
    });
  });
});

describe('unknown routes', () => {
  it('returns the standard error envelope with 404', async () => {
    const response = await call('GET', '/nope');
    expect(response.status).toBe(404);
    expect(errorCode(response.body)).toBe('not_found');
  });
});
