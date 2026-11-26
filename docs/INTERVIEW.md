# Interview study notes

Everything here is implemented in this repository. Each section says *what* the
concept is, *where* it lives, and how to explain it out loud.

---

## 1. The core problem

A gym class has `capacity = 20`. One hundred people tap "Book" in the same second.
The naive implementation is:

```python
if count_bookings(class) < capacity:      # both requests read 19
    insert_booking(...)                   # both insert -> 21 bookings
```

The gap between *reading* a fact and *acting on it* is the race condition. Any
correct solution makes "check and write" one indivisible step.

---

## 2. Transactions and atomicity

A **transaction** groups statements so the database applies all of them or none.
`BEGIN … COMMIT` is the boundary; a crash, an error, or an explicit `ROLLBACK`
leaves the data exactly as it was before.

Everything that changes state here runs inside one transaction
(`src/db/transaction.ts`, `withTransaction`). For a booking that means the seat
counter, the booking row and the idempotency record all land together:

```ts
const client = await getPool().connect();
await client.query('BEGIN');
try {
  const result = await fn(client);   // all the work
  await client.query('COMMIT');      // one atomic step
  return result;
} catch (error) {
  await client.query('ROLLBACK');    // nothing half-done
  throw error;
}
```

Why it matters here: if the counter were incremented but the booking insert
failed, the class would permanently lose a seat. Atomicity is what makes
`promoted_booking_id` trustworthy too — the cancellation, the freed seat and the
promotion are one unit.

---

## 3. Row locks: making a decision exclusive

`SELECT … FOR UPDATE` (`src/services/bookings.ts:84`) takes a row lock until the
transaction ends:

```sql
SELECT id FROM classes WHERE id = $1 FOR UPDATE;
```

From that line until `COMMIT`, any other transaction that tries the same
`FOR UPDATE` on the same class **waits**. That turns the class row into a mutex:

* request A locks the class, sees 19/20, inserts booking #20, commits;
* request B was blocked the whole time, then reads 20/20, so it joins the waitlist.

No two requests can ever see the same "free seat" state. This is called
*pessimistic locking*, and it is the simplest mechanism that is obviously correct.

**Interview question:** "Isn't a lock slow?" — Only for the *same* class. Two
different classes lock different rows and run in parallel. For this workload the
critical section is a few milliseconds, and correctness beats theoretical
throughput.

---

## 4. Two more layers, so a bug cannot oversell

Locks depend on every future code path remembering to take them. So the database
also enforces the invariant directly.

**Layer 2 — conditional update** (`bookings.ts:109`):

```sql
UPDATE classes
   SET booked_count = booked_count + 1
 WHERE id = $1 AND booked_count < capacity
RETURNING booked_count;
```

If no row comes back, the class is full. Even without the lock this is safe:
PostgreSQL re-evaluates the `WHERE` clause against the freshly locked row version.

**Layer 3 — a CHECK constraint** (`src/db/schema.ts:36`):

```sql
CONSTRAINT classes_booked_within_capacity CHECK (booked_count <= capacity)
```

A counter that tries to exceed capacity makes the whole transaction fail. An
overbooked class is not merely "unlikely" — it is unrepresentable in the schema.
That is what "database-backed guarantee" means.

---

## 5. Unique constraints for "only one active entry"

The spec says a member cannot have two active bookings or waitlist entries in the
same class. Instead of trusting an application `SELECT`, the schema says it:

```sql
CREATE UNIQUE INDEX bookings_active_member_per_class
    ON bookings (class_id, member_id)
    WHERE status IN ('booked', 'waitlisted');   -- partial index
```

A **partial** unique index only covers rows matching the predicate, so cancelled
and skipped rows are excluded and a member can book again later. Two concurrent
duplicates now fail at the index, not just in the service check. The 409 response
is produced by the service, and the unique violation is mapped to the same 409 as
a safety net (`translateConflict` in `bookings.ts`).

---

## 6. Lock ordering and deadlocks

A **deadlock** is two transactions each holding a lock the other wants:

```
T1: lock class c1  ...  wants booking b1
T2: lock booking b1  ...  wants class c1     -> neither can proceed
```

The fix is a global order. This codebase always locks **class first, booking
second**, on every path — booking creation (`bookings.ts:84`) and cancellation
(`bookings.ts:202` then `:208`). Cancellation even reads the class id *without* a
lock first, purely to know which class lock to take before touching the booking
row.

As a belt-and-braces measure, transient failures (`40001` serialization failure,
`40P01` deadlock detected) are retried up to five times with backoff
(`transaction.ts:12`). The retry is not the strategy; it is insurance.

---

## 7. Isolation levels (short version)

* **READ COMMITTED** (default, used here): each statement sees the latest
  committed data. `FOR UPDATE` blocks and then re-reads, which is exactly what we
  need.
* **REPEATABLE READ**: one snapshot for the whole transaction. Used `READ ONLY`
  for `GET /classes/{id}` so `booked_count` and `booked_member_ids` describe the
  same instant.
* **SERIALIZABLE**: strongest, and would also be correct, but it aborts more
  transactions and needs retries everywhere. Explicit row locks are easier to
  reason about and to explain.

---

## 8. The waitlist: FIFO without timestamps

Order is defined by a sequence (`src/db/schema.ts`):

```sql
CREATE SEQUENCE waitlist_order_seq;
...
VALUES ($1, $2, 'waitlisted', nextval('waitlist_order_seq'))
```

Why not `created_at`? Two requests can land in the same millisecond and tie.
A sequence never ties, and it is assigned while the class lock is held, so the
number reflects the order in which the application *accepted* requests.

Positions are **computed, never stored** (`src/services/classes.ts:91`):

```sql
SELECT id AS booking_id, member_id,
       row_number() OVER (ORDER BY waitlist_seq)::int AS position
  FROM bookings
 WHERE class_id = $1 AND status = 'waitlisted'
 ORDER BY waitlist_seq
```

If positions were a column, every cancellation would need a `UPDATE … position =
position - 1` over the remaining rows — a classic source of gaps and duplicates
under concurrency. Deriving them makes "1, 2, 3 … no gaps" true by construction.
The immediate `waitlist_position` in the booking response uses the same idea
(`count(*) … AND waitlist_seq <= mine`).

---

## 9. Promotion: skipping ineligible members

`promoteFirstEligible` (`bookings.ts:270`) runs inside the cancellation
transaction, while the class lock is still held:

```sql
SELECT b.id, b.member_id, (m.membership_expires_at > now()) AS is_active
  FROM bookings b JOIN members m ON m.id = b.member_id
 WHERE b.class_id = $1 AND b.status = 'waitlisted'
 ORDER BY b.waitlist_seq
 LIMIT 1
 FOR UPDATE OF b;
```

* active → `UPDATE … SET status = 'booked'`, increment `booked_count`, return the id;
* inactive → `UPDATE … SET status = 'skipped'`, loop to the next candidate;
* queue empty → return `null`, and the freed seat simply stays free.

The database clock (`now()`) decides eligibility, not the application clock, so a
skewed app server cannot admit an expired member.

**Why no double promotion?** The class lock is held for the whole operation, so a
second cancellation for the same class cannot start its promotion until the first
commits. Two seats released → two sequential promotions, never the same member.

---

## 10. Idempotency: the same request twice

The client sends `Idempotency-Key`. The requirement: the second request must not
create anything and must return the first response body.

The claim is one statement (`src/services/idempotency.ts:47`):

```sql
INSERT INTO idempotency_keys (key, request_fingerprint)
VALUES ($1, $2)
ON CONFLICT (key) DO UPDATE SET key = idempotency_keys.key
RETURNING response_status, response_body, completed_at;
```

How each case behaves:

| Case | What happens |
| --- | --- |
| First request | inserts the row, does the booking, stores the response, commits |
| Same key later | `ON CONFLICT` returns the stored row → `200` + identical body |
| Same key **at the same moment** | the second insert waits on the unique index until the first commits, then returns the stored row |
| First request failed | it rolled back, taking its key with it → the retry runs normally |
| Key reused with another payload | the original response is replayed (the only behaviour the spec defines) and a warning is logged |

Two details worth explaining:

* The response body is stored as **TEXT**, not `JSONB`, because `jsonb` reorders
  object keys and a replay would not be byte-identical.
* The claim happens **before** the eligibility checks. A booking that succeeded
  must still replay after the member's membership expires.

Because the state is a table, it survives a restart and works with several
instances — unlike an in-memory `Map`, which would fail both tests.

---

## 11. Capacity invariant under mixed traffic

Scenario: 200 members, capacity 20, cancellations interleaved. The invariant is
`count(status='booked') == classes.booked_count <= capacity` at every commit.
Tests verify it directly with SQL after every storm
(`assertConsistent` in `tests/support/harness.ts`), not just through the API.

Run it yourself:

```bash
python3 scripts/stress.py http://localhost:8080 20 200
python3 scripts/stress.py http://localhost:8080 1 300
```

---

## 12. Likely questions and short answers

**"What happens if the process crashes mid-request?"**
The transaction never commits, PostgreSQL rolls it back on connection loss, so
neither the seat nor the booking exists. There is no half-state to clean up.

**"Why not an in-memory lock (`Mutex`, `synchronized`, Redis)?"**
It only protects one process. Two containers, or a restart, break it. The lock
must live where the data lives.

**"Why not `SERIALIZABLE`?"**
Correct, but it turns ordinary conflicts into aborts that must all be retried.
Explicit `FOR UPDATE` on one row is predictable and cheap here.

**"Why is `booked_count` stored if you can `COUNT(*)`?"**
Counting is fine once, but the counter makes the capacity check a single atomic
`UPDATE … WHERE booked_count < capacity`, and it lets a CHECK constraint enforce
the invariant. `COUNT(*)` cannot express a constraint. Tests assert the counter
always equals the real row count.

**"Why return 409 for a second booking instead of updating it?"**
The spec says `already_booked`; silently merging would hide a client bug.

**"How do you know it works?"**
155 automated tests, including eight concurrency scenarios that check the persisted
state, plus the official 19-check script and a separate-process stress tool — all
run, all passing.
