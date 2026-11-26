# CS track: The booking engine

**PulseGym** is a busy gym. Popular classes fill up in seconds, and members tap "Book" at the same moment. Your job: build the booking backend that never breaks under that pressure.

## What you build
An HTTP API (any language, any framework, any database) that follows **API-SPEC.md** exactly.

It must handle:
- Classes with a fixed capacity.
- Booking and cancelling. Only members with an active membership can book.
- **Race conditions:** hundreds of members booking the last spots at the same moment must never overbook a class.
- **A waitlist:** when a class is full, members join a first-come, first-served waitlist. When someone cancels, the first eligible member gets the spot automatically. Members whose membership has expired are skipped.
- **Double taps:** the same request sent twice (same `Idempotency-Key`) books only once.
- **All or nothing:** a booking, cancellation or promotion either completes fully or not at all.

## How we run it
1. Your repo has a `Dockerfile` and a `docker-compose.yml` (start from `templates/` and `docker-compose.example.yml`).
2. We run `docker compose up --build` and expect the API on `http://localhost:8080`.
3. Before you submit, run our check script: `python3 check.py`. If all checks pass, your app speaks our API.

Our hidden test then sends many requests at the same moment (bookings, cancellations, repeated requests) and checks the final state of every class.

## What you submit
- A GitHub link (public, or shared with us) or a zip of your code.
- A `README.md` (one page) explaining: your design, **how you prevented race conditions**, what you would improve with more time, and how you used AI tools.
- Your own tests.

## How you are scored (out of 100, same sheet for all tracks)
| Criteria | Points |
| --- | --- |
| Passes the hidden test | 35 |
| Quality of the approach | 25 |
| Edge cases and thinking ahead | 15 |
| Clear explanation (README) | 15 |
| Presentation (easy to run and read) | 10 |

## Tips
- Think about where two requests can read the same "free spots" number before either writes.
- Your database can help you: transactions, row locks, unique constraints.
- Test your own app with many requests at once before you submit.
