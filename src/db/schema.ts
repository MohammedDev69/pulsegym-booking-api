/**
 * Database schema.
 *
 * The DDL is idempotent and executed on boot, which keeps `docker compose up
 * --build` reproducible from an empty volume without a separate migration tool.
 * For a larger product this would move to versioned migrations; for a single
 * service with one schema version, running the DDL under an advisory lock is
 * enough and cannot race when several replicas start at once.
 *
 * The constraints are the point of this file. They are the last line of defence
 * for every invariant the API promises, even if application code is wrong later:
 *
 *  - classes_booked_within_capacity : a class can never hold more booked seats
 *    than its capacity. A bug that increments the counter twice fails loudly
 *    instead of overselling.
 *  - bookings_active_member_per_class : a member can have at most one *active*
 *    (booked or waitlisted) row per class, enforced by a partial unique index.
 *  - bookings_waitlisted_has_seq : a waitlisted row always carries the sequence
 *    number that defines its FIFO position.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS members (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    membership_expires_at TIMESTAMPTZ NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS classes (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    capacity     INTEGER NOT NULL CHECK (capacity >= 1),
    starts_at    TIMESTAMPTZ NOT NULL,
    booked_count INTEGER NOT NULL DEFAULT 0 CHECK (booked_count >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT classes_booked_within_capacity CHECK (booked_count <= capacity)
);

-- Global, monotonically increasing ordering key for the waitlist. A sequence is
-- used instead of timestamps so ordering stays strict even when two inserts land
-- inside the same clock tick.
CREATE SEQUENCE IF NOT EXISTS waitlist_order_seq;

CREATE TABLE IF NOT EXISTS bookings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    class_id     TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('booked', 'waitlisted', 'cancelled', 'skipped')),
    waitlist_seq BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bookings_waitlisted_has_seq CHECK (status <> 'waitlisted' OR waitlist_seq IS NOT NULL)
);

-- One active participation per member per class: no double booking, no duplicate
-- waitlist entry, not even under concurrent requests from the same member.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_active_member_per_class
    ON bookings (class_id, member_id)
    WHERE status IN ('booked', 'waitlisted');

CREATE INDEX IF NOT EXISTS bookings_class_status_idx
    ON bookings (class_id, status);

CREATE INDEX IF NOT EXISTS bookings_waitlist_order_idx
    ON bookings (class_id, waitlist_seq)
    WHERE status = 'waitlisted';

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key                 TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    -- The serialised response is stored as text (not jsonb) so a replay is
    -- byte-for-byte identical to the first response: jsonb reorders object keys.
    response_status     INTEGER,
    response_body       TEXT,
    booking_id          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);
`;

/** Arbitrary constant used to serialise schema creation across replicas. */
export const SCHEMA_LOCK_ID = 771102;
