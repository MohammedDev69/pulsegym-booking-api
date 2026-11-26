#!/usr/bin/env python3
"""PulseGym public check script.

Runs simple, one-at-a-time checks against your app so you know it speaks our API
before you submit. It does NOT test concurrency: the hidden test does that.

Usage:  python3 check.py [base_url]        (default http://localhost:8080)
Needs only Python 3.8+, no extra packages.
"""
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
FUTURE = "2099-12-31T23:59:59Z"
PAST = "2000-01-01T00:00:00Z"
results = []


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except ValueError:
            return e.code, None


def check(name, cond, detail=""):
    results.append(cond)
    print(("  PASS  " if cond else "  FAIL  ") + name + ("" if cond else f"   -> {detail}"))


def book(class_id, member_id, key=None):
    return call("POST", f"/classes/{class_id}/bookings", {"member_id": member_id},
                {"Idempotency-Key": key or str(uuid.uuid4())})


def main():
    print(f"Checking {BASE}\n")
    for _ in range(30):
        try:
            if call("GET", "/health")[0] == 200:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        print("  FAIL  /health did not answer within 30 seconds. Is your app running on port 8080?")
        sys.exit(1)
    check("health", True)

    s, _ = call("POST", "/admin/reset")
    check("reset returns 204", s == 204, s)

    for i in range(1, 6):
        call("POST", "/members", {"id": f"m{i}", "name": f"Member {i}", "membership_expires_at": FUTURE})
    s, _ = call("POST", "/members", {"id": "old", "name": "Expired", "membership_expires_at": PAST})
    check("create member returns 201", s == 201, s)
    s, _ = call("POST", "/classes", {"id": "c1", "name": "Spin", "capacity": 2, "starts_at": "2026-12-05T07:00:00Z"})
    check("create class returns 201", s == 201, s)

    s, b = call("POST", "/classes/c1/bookings", {"member_id": "m1"})
    check("missing Idempotency-Key returns 400", s == 400, s)

    s, b1 = book("c1", "m1", "key-1")
    check("first booking is booked", s == 201 and b1 and b1.get("status") == "booked", (s, b1))
    s, again = book("c1", "m1", "key-1")
    check("same Idempotency-Key returns 200 and the same body", s == 200 and again == b1, (s, again))
    s, b = book("c1", "m1")
    check("second active booking for same member returns 409 already_booked",
          s == 409 and b and b.get("error", {}).get("code") == "already_booked", (s, b))
    s, b = book("c1", "old")
    check("expired membership returns 403 membership_inactive",
          s == 403 and b and b.get("error", {}).get("code") == "membership_inactive", (s, b))
    s, b = book("c1", "nobody")
    check("unknown member returns 404", s == 404, s)
    s, b = book("nope", "m1")
    check("unknown class returns 404", s == 404, s)

    book("c1", "m2")
    s, w3 = book("c1", "m3")
    check("full class puts member on waitlist position 1",
          s == 201 and w3 and w3.get("status") == "waitlisted" and w3.get("waitlist_position") == 1, (s, w3))
    s, w4 = book("c1", "m4")
    check("next member is waitlist position 2", w4 and w4.get("waitlist_position") == 2, w4)

    s, c = call("GET", "/classes/c1")
    check("class shows booked_count 2 and 2 on waitlist",
          s == 200 and c and c.get("booked_count") == 2 and len(c.get("waitlist", [])) == 2, c)

    # Expire m3, then cancel m1: m3 must be skipped and m4 promoted.
    call("PATCH", "/members/m3", {"membership_expires_at": PAST})
    s, cancel = call("DELETE", f"/bookings/{b1['booking_id']}")
    check("cancel returns 200 with promoted_booking_id",
          s == 200 and cancel and cancel.get("promoted_booking_id") == w4.get("booking_id"), (s, cancel))
    s, b = call("GET", f"/bookings/{w3['booking_id']}")
    check("expired waitlisted member is marked skipped", b and b.get("status") == "skipped", b)
    s, b = call("GET", f"/bookings/{w4['booking_id']}")
    check("next eligible member is promoted to booked", b and b.get("status") == "booked", b)
    s, b = call("DELETE", f"/bookings/{b1['booking_id']}")
    check("cancelling twice returns 409 already_cancelled", s == 409, s)
    s, c = call("GET", "/classes/c1")
    check("final state: 2 booked, empty waitlist",
          c and c.get("booked_count") == 2 and c.get("waitlist") == [], c)

    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed.")
    if passed == len(results):
        print("Your app speaks our API. The hidden test will now push it with many requests at once.")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
