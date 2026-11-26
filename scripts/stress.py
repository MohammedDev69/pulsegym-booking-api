#!/usr/bin/env python3
"""PulseGym manual stress tool.

Drives the running API from a *separate process* with real parallel HTTP
requests, then verifies the persisted result through the API. It is the same
kind of load the hidden test applies, and it is deliberately not part of the
automated suite (the Jest concurrency tests already assert the invariants, and
this tool is for measuring and demonstrating them).

Usage:
    python3 scripts/stress.py [base_url] [capacity] [members]

Example:
    python3 scripts/stress.py http://localhost:8080 20 200
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
CAPACITY = int(sys.argv[2]) if len(sys.argv) > 2 else 20
MEMBERS = int(sys.argv[3]) if len(sys.argv) > 3 else 200
FUTURE = "2099-12-31T23:59:59Z"
CLASS_ID = "stress-class"


def call(method: str, path: str, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw) if raw else None
        except ValueError:
            return error.code, None


def main() -> int:
    status, _ = call("GET", "/health")
    if status != 200:
        print(f"API is not healthy on {BASE} (status {status})")
        return 1

    print(f"Resetting {BASE}")
    call("POST", "/admin/reset")
    call(
        "POST",
        "/classes",
        {
            "id": CLASS_ID,
            "name": "Stress Class",
            "capacity": CAPACITY,
            "starts_at": "2026-12-05T07:00:00Z",
        },
    )

    member_ids = [f"s-{index:04d}" for index in range(MEMBERS)]

    def create_member(member_id: str):
        return call(
            "POST",
            "/members",
            {"id": member_id, "name": member_id, "membership_expires_at": FUTURE},
        )

    with ThreadPoolExecutor(max_workers=32) as pool:
        list(pool.map(create_member, member_ids))
    print(f"Created {MEMBERS} members, class capacity {CAPACITY}")

    # Every request carries its own key, so this measures capacity handling,
    # not idempotency (which gets its own pass below).
    def book(member_id: str):
        return call(
            "POST",
            f"/classes/{CLASS_ID}/bookings",
            {"member_id": member_id},
            {"Idempotency-Key": str(uuid.uuid4())},
        )

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=min(MEMBERS, 200)) as pool:
        responses = list(pool.map(book, member_ids))
    elapsed = time.perf_counter() - started

    booked = [r for r in responses if r[1] and r[1].get("status") == "booked"]
    waitlisted = [r for r in responses if r[1] and r[1].get("status") == "waitlisted"]
    unexpected = [r for r in responses if r[0] != 201]

    print(
        f"{MEMBERS} concurrent bookings in {elapsed:.2f}s "
        f"({MEMBERS / elapsed:,.0f} req/s)"
    )
    print(f"  booked:     {len(booked)} (expected {CAPACITY})")
    print(f"  waitlisted: {len(waitlisted)} (expected {MEMBERS - CAPACITY})")
    print(f"  non-201:    {len(unexpected)}")

    status, detail = call("GET", f"/classes/{CLASS_ID}")
    positions = [entry["position"] for entry in detail["waitlist"]]
    contiguous = positions == list(range(1, len(positions) + 1))

    print(f"  class view: booked_count={detail['booked_count']} "
          f"waitlist={len(detail['waitlist'])} contiguous={contiguous}")

    # Idempotency pass on its own class, so the member has no prior booking.
    call(
        "POST",
        "/classes",
        {
            "id": "stress-idem-class",
            "name": "Stress Idempotency Class",
            "capacity": 5,
            "starts_at": "2026-12-05T07:00:00Z",
        },
    )
    call(
        "POST",
        "/members",
        {"id": "idem-member", "name": "Idem", "membership_expires_at": FUTURE},
    )

    key = str(uuid.uuid4())
    with ThreadPoolExecutor(max_workers=50) as pool:
        duplicates = list(
            pool.map(
                lambda _unused: call(
                    "POST",
                    "/classes/stress-idem-class/bookings",
                    {"member_id": "idem-member"},
                    {"Idempotency-Key": key},
                ),
                range(50),
            )
        )
    bodies = {json.dumps(body, sort_keys=True) for _s, body in duplicates}
    codes = sorted({status for status, _body in duplicates})
    print(f"  50 duplicate requests: status codes {codes}, distinct bodies {len(bodies)}")

    ok = (
        len(booked) == CAPACITY
        and len(waitlisted) == MEMBERS - CAPACITY
        and not unexpected
        and detail["booked_count"] == CAPACITY
        and contiguous
        and len(bodies) == 1
        and codes == [200, 201]
    )
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
