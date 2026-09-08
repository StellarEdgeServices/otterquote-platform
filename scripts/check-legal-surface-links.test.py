#!/usr/bin/env python3
"""
Proof-of-detection test for #806 AC #5: "Demonstrate the detector catches
a broken legal-surface link" -- fixed for gh-1841.

ORIGINAL DEFECT (gh-1841, instance 3 of the six the detector-negative-control
gate flagged on run 78 of `main`): this test pinned its negative control to
one specific, real, then-broken production URL --
https://otterquote.com/partner-agreement.html, confirmed 404 as of
2026-08-14 (#766). #766 has since been fixed -- the page now resolves 200 --
so the assertion that it "must FAIL" started failing itself, and the test
started exiting 1 on every run regardless of whether the detector's own
PASS/FAIL logic still works. A negative control that depends on a specific
external defect staying broken is not a negative control; it is a race
against whoever fixes that defect next, and this file lost that race.

THE FIX: the negative-control target is now a URL guaranteed to 404
independent of any tracked bug (a fixed, obviously-synthetic path under
otterquote.com that will never be a real page). This proves the same thing
the original test intended -- check_url() correctly distinguishes a live
200 from a 404 -- without pinning to a defect that closes out from under it.
If this repo's next real broken-link defect needs its own regression test,
that is a separate fixture, not a reason to reuse this one as a tripwire.

Also fixed: PASS/FAIL line format. The prior version printed "OK: ..." on
success, which does not match this repo's PASS/FAIL self-test convention
(scripts/detector-negative-control-check.py's count_assertions() looks for
lines starting literally with "PASS" or "FAIL") -- so even when this test
exited 0, the gate above it would have reported "self-test exited 0 but
self-reported ZERO assertions." Rewritten to the check()/PASS/FAIL
convention used throughout scripts/*.test.py (e.g.
scripts/credential-sweep.test.py) so a real run of this file self-reports
real, countable assertions.

Runs check_url() (the same function the scheduled check uses) directly
against two live URLs:
  - https://otterquote.com/terms.html — known-good, must PASS
  - a synthetic, guaranteed-nonexistent path under otterquote.com —
    known-bad, must FAIL with status 404

Run: python scripts/check-legal-surface-links.test.py
Requires network access to otterquote.com (production).
"""
import sys
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "check_legal_surface_links",
    pathlib.Path(__file__).resolve().parent / "check-legal-surface-links.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Deliberately synthetic: guaranteed never to be a real page, so this
# negative control cannot be invalidated by some future PR fixing a
# tracked production defect out from under it (see module docstring above).
KNOWN_BAD_URL = "https://otterquote.com/definitely-does-not-exist-negative-control-check-806.html"

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def check_true(label, cond):
    check(label, bool(cond), True)


def main() -> int:
    print("positive control: known-good production URL")
    good = mod.check_url("https://otterquote.com/terms.html")
    check_true("terms.html check_url()['ok']", good["ok"])
    check("terms.html status", good.get("status"), 200)

    print()
    print("negative control: synthetic, guaranteed-nonexistent URL")
    bad = mod.check_url(KNOWN_BAD_URL)
    check_true("synthetic-404 URL check_url()['ok'] is False", not bad["ok"])
    check("synthetic-404 URL status", bad.get("status"), 404)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("check-legal-surface-links: all assertions passed (PASS on known-good, FAIL on known-bad). Detector works.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
