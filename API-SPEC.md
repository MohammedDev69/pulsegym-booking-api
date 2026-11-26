# PulseGym Booking API: specification

Your app **must** follow this spec exactly. Our tests talk to your app only through these endpoints.

- Base URL: `http://localhost:8080`
- All bodies are JSON. All timestamps are ISO 8601 in UTC, for example `2026-12-01T18:00:00Z`.
- Every error uses the same shape:

```json
{ "error": { "code": "class_not_found", "message": "Class 42 does not exist" } }
```

---

## Setup endpoints (used by the tests to prepare data)

### `POST /admin/reset`
Deletes all data. Returns `204 No Content`.

### `POST /members`
```json
{ "id": "m-001", "name": "Sara", "membership_expires_at": "2027-01-31T23:59:59Z" }
```
- `201` returns the member.
- `409 member_exists` if the id is already used.
- `400 invalid_request` if a field is missing or invalid.

A membership is **active** when `membership_expires_at` is later than the current time.

### `PATCH /members/{id}`
```json
{ "membership_expires_at": "2026-01-01T00:00:00Z" }
```
Changes a membership end date (the tests use this to expire someone). `200` returns the member, `404 member_not_found`.

### `POST /classes`
```json
{ "id": "c-yoga-1", "name": "Morning Yoga", "capacity": 20, "starts_at": "2026-12-05T07:00:00Z" }
```
- `201` returns the class.
- `409 class_exists`, `400 invalid_request` (capacity must be 1 or more).

---

## Booking endpoints

### `POST /classes/{class_id}/bookings`
Headers: `Idempotency-Key: <any unique string from the client>` (**required**)

```json
{ "member_id": "m-001" }
```

Responses:

| Status | When | Body |
| --- | --- | --- |
| `201` | A spot was free | `{ "booking_id": "...", "class_id": "...", "member_id": "...", "status": "booked" }` |
| `201` | Class is full, member joined the waitlist | `{ ..., "status": "waitlisted", "waitlist_position": 3 }` |
| `200` | Same `Idempotency-Key` was already used | The **exact same body** as the first response. Nothing new is created. |
| `400` | Missing `Idempotency-Key` or bad body | `invalid_request` |
| `403` | Membership not active | `membership_inactive` |
| `404` | Class or member not found | `class_not_found` / `member_not_found` |
| `409` | Member already has an active booking or waitlist entry in this class | `already_booked` |

### `DELETE /bookings/{booking_id}`
Cancels a booking or a waitlist entry.

- `200` returns `{ "booking_id": "...", "status": "cancelled", "promoted_booking_id": "..." | null }`
- If a **booked** spot is cancelled, the first **eligible** member on the waitlist is promoted to `booked` in the same operation. `promoted_booking_id` is their booking id, or `null` if nobody was promoted.
- `404 booking_not_found`, `409 already_cancelled`.

### `GET /classes/{class_id}`
```json
{
  "id": "c-yoga-1", "name": "Morning Yoga", "capacity": 20,
  "booked_count": 20,
  "booked_member_ids": ["m-001", "m-007"],
  "waitlist": [ { "booking_id": "b-91", "member_id": "m-033", "position": 1 } ]
}
```
`waitlist` is ordered by position, starting at 1, with no gaps.

### `GET /bookings/{booking_id}`
Returns `{ "booking_id", "class_id", "member_id", "status", "waitlist_position" }`.
`status` is one of `booked`, `waitlisted`, `cancelled`, `skipped`. `waitlist_position` is `null` unless waitlisted.

### `GET /health`
Returns `200 { "status": "ok" }`. Our tests wait for this before starting.

---

## Rules your app must follow

1. **Never overbook.** `booked_count` must never go above `capacity`, even when hundreds of requests arrive at the same moment.
2. **Waitlist is first come, first served.** The order is the order in which your app accepted the requests.
3. **Skip ineligible members.** When a spot opens, if the first waitlisted member's membership is no longer active, mark that entry `skipped` and give the spot to the next one. Repeat until someone eligible gets it or the waitlist is empty.
4. **Idempotency.** The same `Idempotency-Key` sent twice, even at the same moment, creates at most one booking and returns the same body.
5. **All or nothing.** A booking, a cancellation, or a promotion either completes fully or not at all. No half-done states.
6. **Positions stay clean.** After any change, waitlist positions are 1, 2, 3, … with no gaps or duplicates.
