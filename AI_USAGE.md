# AI usage disclosure

The challenge allows AI tools as long as their use is disclosed honestly. This
file records what was and was not done with them.

## Tools used

* **OpenCode** (agentic coding assistant) running a large language model, driven
  from this repository. It read the starter pack, proposed the design, wrote the
  first drafts of the code, the tests and the documentation, and ran the build,
  the test suite, the official checker and the Docker stack.

## What the AI helped with

| Area | Contribution |
| --- | --- |
| Requirement extraction | Read `BRIEF.md`, `API-SPEC.md` and `check.py`, and turned them into the endpoint/status-code checklist that the tests assert. |
| Architecture | Proposed PostgreSQL row-level locking plus a conditional counter update as the primary mechanism, and the partial unique index for "one active entry per member per class". |
| Implementation | Wrote `src/**` — routing, validation, the booking/cancellation/promotion transactions, and the idempotency upsert. |
| Tests | Wrote the Jest suites (unit, integration, concurrency) including the 200-request and 300-request storms, plus `scripts/stress.py`. |
| Debugging | Diagnosed four real bugs found while running the tests: JSONB reordering replayed bodies, an IPv6 `localhost` fallback adding ~2 s per request, a listen-backlog/accept failure under a 600-connection burst, and a test helper that wrongly tried to put already-expired members on the waitlist. |
| Review | Self-review pass for lock ordering, transaction boundaries, error leakage and dead code before submission. |
| Documentation | Drafted this file, `README.md` and `docs/INTERVIEW.md`. |
| Audit | In a separate pass, re-read the official spec, found three defects the first pass missed (an invented capacity ceiling, silently rolled-over invalid calendar dates, and a lock-order inversion in `/admin/reset`), fixed them and added regression tests. |

## What was reviewed and decided by a human

The AI did not work unattended: every design decision below was reviewed, and the
implementation was re-explained line by line so it can be defended in an interview.

* The lock order (**class row → booking rows**) and the decision to keep the
  class row as the per-class mutex.
* Using the conditional `UPDATE … WHERE booked_count < capacity` **and** a
  `CHECK (booked_count <= capacity)` instead of relying on one mechanism.
* Treating a reused `Idempotency-Key` as global (first successful response wins),
  because that is the only behaviour the specification defines.
* Storing the idempotent response as `TEXT` so a replay is byte-identical.
* Returning `409 already_cancelled` for cancelling a `skipped` entry, since it is
  already terminal.
* Not weakening or modifying `check.py`; it is the official file, copied as-is.
* Removing an arbitrary `capacity <= 1_000_000` rule: the specification only says
  "capacity must be 1 or more", so the only remaining bound is the storage limit
  of the `INTEGER` column.

## What is *not* true

The code was mostly AI-generated. Any claim that it was typed by hand would be
false. What is true is that it runs, the tests and the official checker pass, and
the reasoning in `docs/INTERVIEW.md` is the reasoning the author can explain and
defend.

## Verification performed (not claimed, actually run)

* `python3 check.py` → **19/19** against both the local process and the Docker stack.
* `npm test` → **155/155** passing (8 suites: unit, integration, DB constraints, concurrency).
* `python3 scripts/stress.py http://localhost:8080 20 200` → **PASS** (20 booked, 180 waitlisted, positions contiguous, duplicate keys collapse to one body).
* `python3 scripts/stress.py http://localhost:8080 1 300` → **PASS** (1 booked, 299 waitlisted).
* `docker compose up --build` → both containers healthy, API on port 8080; data intact across `docker compose restart`.
