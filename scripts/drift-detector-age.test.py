#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/drift-detector-age.py (gh-1501).

Covers the shape gh-1501 exists to close: a session-triggered age check whose own
failure to measure must never look like a pass. No network access and no credentials
required -- every fetch-adjacent path is exercised by monkeypatching urllib.request's
`urlopen` so it never leaves this machine, following the importlib-load pattern this
repo already uses for hyphenated script filenames in scripts/edge-function-drift-check.test.py
and scripts/migrations-reconciliation-check.test.py.

Run: python drift-detector-age.test.py
"""

import importlib.util
import io
import json
import pathlib
import re
import sys
import urllib.error
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("age", HERE / "drift-detector-age.py")
age = importlib.util.module_from_spec(spec)
spec.loader.exec_module(age)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def iso_hours_ago(now, hours):
    return (now - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


class _FakeResponse:
    """Minimal context-manager stand-in for urllib.request.urlopen's return value."""

    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def main():
    now = datetime(2026, 9, 2, 12, 0, 0, tzinfo=timezone.utc)

    # -------------------------------------------------------------------------------
    print("Pure verdict logic (compute_result) -- FRESH/STALE boundary")
    # -------------------------------------------------------------------------------
    threshold = 36.0

    exactly_at_threshold = iso_hours_ago(now, 36.0)
    r = age.compute_result(exactly_at_threshold, "actions-api run id=1", threshold, now=now)
    check("age == threshold -> FRESH (boundary is inclusive, <=)", r["verdict"], "FRESH")
    check("age == threshold -> exit 0", r["code"], 0)

    just_under = iso_hours_ago(now, 35.99)
    r = age.compute_result(just_under, "actions-api run id=2", threshold, now=now)
    check("age just under threshold -> FRESH", r["verdict"], "FRESH")

    just_over = iso_hours_ago(now, 36.01)
    r = age.compute_result(just_over, "actions-api run id=3", threshold, now=now)
    check("age just over threshold -> STALE", r["verdict"], "STALE")
    check("age just over threshold -> exit 2", r["code"], 2)

    way_over = iso_hours_ago(now, 200)
    r = age.compute_result(way_over, "actions-api run id=4", threshold, now=now)
    check("age far over threshold -> STALE", r["verdict"], "STALE")

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED paths -- must never resolve to FRESH")
    # -------------------------------------------------------------------------------
    r = age.compute_result(None, "no GITHUB_PERSONAL_ACCESS_TOKEN found in the environment",
                            threshold, now=now)
    check("iso=None (no token) -> UNMEASURED", r["verdict"], "UNMEASURED")
    check("iso=None (no token) -> exit 3", r["code"], 3)
    check("iso=None (no token) -> age_hours is None", r["age_hours"], None)

    r = age.compute_result(None, "GitHub API HTTP 401 (Unauthorized)", threshold, now=now)
    check("iso=None (auth failure) -> UNMEASURED", r["verdict"], "UNMEASURED")

    r = age.compute_result("not-a-timestamp", "actions-api run id=5", threshold, now=now)
    check("unparseable timestamp -> UNMEASURED, not a crash", r["verdict"], "UNMEASURED")
    check("unparseable timestamp -> exit 3", r["code"], 3)

    # -------------------------------------------------------------------------------
    print("\nthreshold flag is honoured")
    # -------------------------------------------------------------------------------
    check("no flag -> default 36.0", age.parse_threshold_hours([]), 36.0)
    check("--threshold-hours 10 -> 10.0", age.parse_threshold_hours(["--threshold-hours", "10"]), 10.0)
    check("--threshold-hours 72 -> 72.0", age.parse_threshold_hours(["--threshold-hours", "72"]), 72.0)

    ten_hour_threshold = age.parse_threshold_hours(["--threshold-hours", "10"])
    twelve_hours_old = iso_hours_ago(now, 12)
    r = age.compute_result(twelve_hours_old, "actions-api run id=6", ten_hour_threshold, now=now)
    check("12h-old run against a 10h flag -> STALE (flag actually changes the verdict)",
          r["verdict"], "STALE")

    # -------------------------------------------------------------------------------
    print("\n_token() reads GITHUB_PERSONAL_ACCESS_TOKEN from the environment only")
    # -------------------------------------------------------------------------------
    saved_token = age.os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    try:
        age.os.environ.pop("GITHUB_PERSONAL_ACCESS_TOKEN", None)
        check("_token() with unset env var -> None", age._token(), None)
        age.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = "   "
        check("_token() with blank/whitespace env var -> None", age._token(), None)
        age.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = "fake-not-a-real-token"
        check("_token() with a set value -> returns it unmodified",
              age._token(), "fake-not-a-real-token")
    finally:
        if saved_token is None:
            age.os.environ.pop("GITHUB_PERSONAL_ACCESS_TOKEN", None)
        else:
            age.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = saved_token

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED on missing token (fetch_newest_successful_run, no network)")
    # -------------------------------------------------------------------------------
    iso, reason = age.fetch_newest_successful_run(token=None)
    check("fetch with token=None -> iso is None", iso, None)
    check("fetch with token=None -> reason mentions the missing token",
          "GITHUB_PERSONAL_ACCESS_TOKEN" in reason, True)

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED on unreachable API (fetch_newest_successful_run, urlopen monkeypatched)")
    # -------------------------------------------------------------------------------
    real_urlopen = age.urllib.request.urlopen

    def _raise_network_error(req, timeout=20):
        raise urllib.error.URLError("[Errno -2] Name or service not known")

    age.urllib.request.urlopen = _raise_network_error
    try:
        iso, reason = age.fetch_newest_successful_run(token="fake-token-not-real")
        check("fetch with unreachable API -> iso is None", iso, None)
        check("fetch with unreachable API -> reason names the failure",
              "URLError" in reason or "Name or service" in reason, True)
    finally:
        age.urllib.request.urlopen = real_urlopen

    # HTTPError path (e.g. bad/expired token) is also UNMEASURED, not a crash.
    def _raise_http_401(req, timeout=20):
        raise urllib.error.HTTPError(
            url="https://api.github.com/x", code=401, msg="Unauthorized", hdrs=None, fp=None
        )

    age.urllib.request.urlopen = _raise_http_401
    try:
        iso, reason = age.fetch_newest_successful_run(token="fake-token-not-real")
        check("fetch with HTTP 401 -> iso is None", iso, None)
        check("fetch with HTTP 401 -> reason names the status code", "401" in reason, True)
    finally:
        age.urllib.request.urlopen = real_urlopen

    # Empty result set (reachable, authenticated, but zero successful runs ever) must
    # also be UNMEASURED -- the exact fail-quiet shape this script exists to avoid.
    def _empty_runs(req, timeout=20):
        body = json.dumps({"total_count": 0, "workflow_runs": []}).encode("utf-8")
        return _FakeResponse(body)

    age.urllib.request.urlopen = _empty_runs
    try:
        iso, reason = age.fetch_newest_successful_run(token="fake-token-not-real")
        check("fetch with zero successful runs -> iso is None", iso, None)
        check("fetch with zero successful runs -> reason says so",
              "zero successful runs" in reason, True)
    finally:
        age.urllib.request.urlopen = real_urlopen

    # A reachable response with a real successful run -> iso comes back, not UNMEASURED.
    def _one_success_run(req, timeout=20):
        body = json.dumps(
            {
                "total_count": 1,
                "workflow_runs": [
                    {"id": 33515902091, "conclusion": "success",
                     "created_at": "2026-09-01T13:51:10Z"}
                ],
            }
        ).encode("utf-8")
        return _FakeResponse(body)

    age.urllib.request.urlopen = _one_success_run
    try:
        iso, reason = age.fetch_newest_successful_run(token="fake-token-not-real")
        check("fetch with one successful run -> iso extracted", iso, "2026-09-01T13:51:10Z")
        check("fetch with one successful run -> source names the run id",
              "33515902091" in reason, True)
    finally:
        age.urllib.request.urlopen = real_urlopen

    # Non-success runs (e.g. a failed scheduled run) must be filtered out even though
    # status=success is requested server-side -- defend the client filter independently.
    def _mixed_runs(req, timeout=20):
        body = json.dumps(
            {
                "total_count": 2,
                "workflow_runs": [
                    {"id": 2, "conclusion": "failure", "created_at": "2026-09-02T09:17:00Z"},
                    {"id": 1, "conclusion": "success", "created_at": "2026-08-31T12:36:00Z"},
                ],
            }
        ).encode("utf-8")
        return _FakeResponse(body)

    age.urllib.request.urlopen = _mixed_runs
    try:
        iso, reason = age.fetch_newest_successful_run(token="fake-token-not-real")
        check("fetch filters out non-success conclusions", iso, "2026-08-31T12:36:00Z")
    finally:
        age.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nNever prints the token")
    # -------------------------------------------------------------------------------
    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        r = age.compute_result(iso_hours_ago(now, 1), "actions-api run id=9", 36.0, now=now)
        age.print_report(iso_hours_ago(now, 1), r, 36.0, as_json=False)
        age.print_report(iso_hours_ago(now, 1), r, 36.0, as_json=True)
    finally:
        sys.stdout = real_stdout
    check("secret-token-value never appears in any printed report",
          "secret-token-value" in captured.getvalue(), False)

    # -------------------------------------------------------------------------------
    print("\nBanners: UNMEASURED and STALE both print an unmistakable warning; FRESH does not")
    # -------------------------------------------------------------------------------
    def rendered(iso_val, result, threshold_val):
        buf = io.StringIO()
        real = sys.stdout
        sys.stdout = buf
        try:
            age.print_report(iso_val, result, threshold_val, as_json=False)
        finally:
            sys.stdout = real
        return buf.getvalue()

    fresh_result = age.compute_result(iso_hours_ago(now, 1), "actions-api run id=10", 36.0, now=now)
    fresh_text = rendered(iso_hours_ago(now, 1), fresh_result, 36.0)
    check("FRESH output does not carry the UNMEASURED/STALE banner",
          ("NOT A PASS" in fresh_text) or ("STALE:" in fresh_text), False)

    unmeasured_result = age.compute_result(None, "no GITHUB_PERSONAL_ACCESS_TOKEN found in the environment", 36.0, now=now)
    unmeasured_text = rendered(None, unmeasured_result, 36.0)
    check("UNMEASURED output carries the loud banner", "NOT A PASS" in unmeasured_text, True)
    # Word-boundary match, not substring: "TOKEN" legitimately contains "OK" and must
    # not trip this check -- only a standalone reassuring "OK" is the thing to forbid.
    check("UNMEASURED output never says anything resembling 'drift detector OK'",
          bool(re.search(r"\bOK\b", unmeasured_text)), False)

    stale_result = age.compute_result(iso_hours_ago(now, 100), "actions-api run id=11", 36.0, now=now)
    stale_text = rendered(iso_hours_ago(now, 100), stale_result, 36.0)
    check("STALE output carries its own loud banner", "STALE:" in stale_text, True)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("drift-detector-age: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
