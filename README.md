# PulseGym Booking API

[![CI](https://github.com/MohammedDev69/pulsegym-booking-api/actions/workflows/ci.yml/badge.svg)](https://github.com/MohammedDev69/pulsegym-booking-api/actions/workflows/ci.yml)
![official checker](https://img.shields.io/badge/check.py-19%2F19%20passing-brightgreen)
![tests](https://img.shields.io/badge/tests-155%20passing-brightgreen)
![node](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![postgresql](https://img.shields.io/badge/postgresql-16-4169E1?logo=postgresql&logoColor=white)
![docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)

Booking backend for the **Creiden Tech Challenge (CS track)**. It implements
[`API-SPEC.md`](API-SPEC.md) exactly — capacity-safe bookings, a fair FIFO waitlist
with automatic promotion, and idempotent requests — and stays correct when
hundreds of members hit the last seat at the same instant.

**Stack:** Node.js 22 · TypeScript · Express 5 · PostgreSQL 16 · `pg` (raw SQL) · Jest.
No cache, queue or extra service: the database is the source of truth *and* the
mechanism that makes concurrent writes safe.

> **Verified:** `python3 check.py` → 19/19 · `npm test` → 155/155 · 200 simultaneous
> bookings for 20 seats → exactly 20 booked, 180 queued, positions 1…180 with no
> gaps · `docker compose up --build` → healthy on `:8080`, data survives restarts.

## Run it

```bash
docker compose up --build        # API on http://localhost:8080
python3 check.py                 # the official checker, unmodified from the starter pack
```

```bash
docker compose down              # stop (keeps data)
docker compose down -v           # stop and wipe the database volume
```

## Test it

The suite needs a reachable PostgreSQL — any empty database works, because the
schema is created on the fly and tables are truncated between tests.

```bash
createdb pulsegym
npm install
export DATABASE_URL=postgres://pulse:pulse@localhost:5432/pulsegym   # PowerShell: $env:DATABASE_URL='...'
npm test                         # 155 tests: unit · integration · DB constraints · concurrency
```

```bash
python3 scripts/stress.py http://localhost:8080 20 200   # 200 parallel bookings, verified end state
```

## Architecture

```text
                    ┌────────────────────────────────────────────────────┐
   HTTP request ───▶│ Express · validation · single error envelope       │
                    └───────────────────────┬────────────────────────────┘
                                            │
                    ┌───────────────────────▼────────────────────────────┐
                    │ ONE PostgreSQL transaction                         │
                    │                                                    │
                    │ 1. claim Idempotency-Key   (upsert acts as a lock) │
                    │ 2. SELECT class … FOR UPDATE  (per-class mutex)    │
                    │ 3. validate member + membership   (database clock) │
                    │ 4. UPDATE booked_count … WHERE < capacity          │
                    │ 5. INSERT booking | waitlisted (sequence = FIFO)   │
                    │ 6. store the response body against the key         │
                    │ COMMIT ── all of it, or none of it                 │
                    └────────────────────────────────────────────────────┘
```

| Table | Purpose |
| --- | --- |
| `members` | `id`, `name`, `membership_expires_at` |
| `classes` | `id`, `name`, `capacity`, `starts_at`, `booked_count` |
| `bookings` | `id`, `class_id`, `member_id`, `status` (`booked`/`waitlisted`/`cancelled`/`skipped`), `waitlist_seq` |
| `idempotency_keys` | `key` (PK), request fingerprint, stored status + body |

Three constraints carry the invariants, so a future bug fails loudly instead of
corrupting data:

```sql
CHECK (booked_count <= capacity)                                      -- overbooking is unrepresentable
UNIQUE (class_id, member_id) WHERE status IN ('booked','waitlisted')  -- no double booking
CHECK (status <> 'waitlisted' OR waitlist_seq IS NOT NULL)            -- every waiter is ordered
```

Positions are **derived** (`row_number() OVER (ORDER BY waitlist_seq)`), never
stored, which is why they cannot drift, duplicate or leave gaps.

## Booking flow

1. Claim the `Idempotency-Key` — replays return the stored `200` body, nothing else happens.
2. `SELECT … FROM classes WHERE id = $1 FOR UPDATE` — the per-class mutex.
3. Validate class, member, membership (`membership_expires_at > now()`, database clock).
4. Reject an existing active booking/waitlist entry with `409 already_booked`.
5. `UPDATE classes SET booked_count = booked_count + 1 WHERE id = $1 AND booked_count < capacity`
   — if a row comes back, insert `booked`; otherwise insert `waitlisted` with the
   next `waitlist_seq` and return its position.
6. Store the response body against the key, then commit.

## How overbooking is prevented

Three independent layers, all inside the database:

1. **Row lock.** Every seat decision for a class is serialised by
   `SELECT … FOR UPDATE` on that class row, so "count then write" cannot interleave.
2. **Conditional update.** The increment only applies `WHERE booked_count < capacity`;
   PostgreSQL re-evaluates that predicate on the locked row version.
3. **CHECK constraint.** `booked_count <= capacity` is enforced by the table itself —
   an over-increment aborts the transaction instead of overselling.

Cancellations run under the same class lock, so a released seat is re-filled in the
same transaction and can never be awarded twice or lost. The lock order is always
**class → booking** on every path, which removes deadlocks; transient serialization
errors are retried anyway.

## Waitlist and promotion

* `waitlist_seq` comes from a sequence, assigned while holding the class lock, so
  acceptance order *is* queue order (no timestamp ties, no ties at all).
* Cancelling a **booked** seat decrements the counter and walks the queue: the first
  member with an active membership is promoted to `booked`; every ineligible member
  before them is marked `skipped`; if nobody qualifies the seat stays free and
  `promoted_booking_id` is `null`.
* Cancelling a **waitlisted** entry promotes nobody; the queue simply closes up.
* The walk happens under the class lock, so two simultaneous cancellations cannot
  promote the same member twice, nor skip one.

## Idempotency

The key is claimed with an upsert inside the booking transaction:

```sql
INSERT INTO idempotency_keys (key, request_fingerprint) VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET key = idempotency_keys.key
RETURNING response_status, response_body, completed_at;
```

A concurrent duplicate **blocks on the unique index** until the first transaction
commits, then reads the committed response and returns `200` with the identical
body (stored as text, so the bytes match too). If the first attempt failed, it
rolled back with its key — the key is free again. A key reused with a different
payload replays the original response, the only behaviour the specification
defines, and logs a warning. State lives in PostgreSQL, so it survives restarts
and works across instances.

## Edge cases handled

Unknown/invalid ids · expired and just-expired memberships · second booking while
already waitlisted · duplicate waitlist entries · repeated cancellation (`409`) ·
cancelling a skipped entry · empty or fully ineligible waitlist · member expiring
while queued · membership restored while queued · re-joining after being skipped ·
malformed JSON · missing headers · wrong field types · non-UUID booking ids ·
impossible calendar dates (2026-02-30) · unknown routes.

## Known limitations

* Seats for a single class are serialised, so throughput per class is one
  transaction at a time (~70–230 bookings/s depending on commit latency). That is
  the price of the simplest correct design; different classes proceed in parallel.
* Idempotency records and cancelled bookings are kept forever. Production would
  add a retention job (e.g. 24 h for keys).
* A key is global, not scoped per endpoint (documented above).
* Single region, single primary database; no read replicas.

## What I would improve with more time

Metrics and tracing · rate limiting per member · an audit-log table · an
outbox/notification when someone is promoted · property-based tests generating
random booking/cancel sequences · a versioned migration tool instead of
idempotent DDL.

## AI usage

Disclosed in [`AI_USAGE.md`](AI_USAGE.md). Interview study notes are in
[`docs/INTERVIEW.md`](docs/INTERVIEW.md).

`cs-starter-pack/` contains the official starter pack, untouched.
