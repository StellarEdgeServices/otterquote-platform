#!/usr/bin/env python3
"""
Self-test for scripts/permissions-ratchet.py (gh-1767).

Two layers, per this repo's detector-negative-control-check.py (gh-1738)
convention -- a self-test must actually run and self-report PASS/FAIL lines,
not just exist:

  1. Runs the script's own `--self-test` as a subprocess against
     scripts/permissions-ratchet-fixtures/ and asserts it exits 0. This is
     the fixture suite the CI workflow itself invokes
     (.github/workflows/permissions-ratchet.yml), so this layer proves the
     wiring, not just the logic.
  2. Imports the module directly and exercises the negative-control shape
     from the issue body verbatim -- `GRANT EXECUTE ON FUNCTION
     public.admin_delete_user() TO anon;` (no money word anywhere) -- FAILS,
     and the corresponding REVOKE direction PASSES, proving the core
     asymmetry gh-1767 exists to encode without relying on the fixture files
     staying in sync with this test.

Run: python scripts/permissions-ratchet.test.py
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ratchet", HERE / "permissions-ratchet.py")
ratchet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratchet)

FAILURES = []
TOTAL_CHECKS = 0


def check(label, actual, expected):
    global TOTAL_CHECKS
    TOTAL_CHECKS += 1
    if actual == expected:
        print("  PASS  %s: %r" % (label, actual))
    else:
        print("  FAIL  %s: expected %r, got %r" % (label, expected, actual))
        FAILURES.append(label)


def check_true(label, cond):
    check(label, bool(cond), True)


# ---------------------------------------------------------------------------
# Layer 1 -- the fixture suite, run exactly as CI runs it.
# ---------------------------------------------------------------------------
print("Layer 1: scripts/permissions-ratchet-fixtures/ via --self-test")
proc = subprocess.run(
    [sys.executable, str(HERE / "permissions-ratchet.py"), "--self-test"],
    capture_output=True,
    text=True,
)
print(proc.stdout)
if proc.stderr:
    print(proc.stderr, file=sys.stderr)
check("fixture self-test exit code", proc.returncode, 0)
check_true(
    "fixture self-test reports zero mismatches",
    "0 mismatch(es)" in proc.stdout,
)
fixtures_dir = HERE / "permissions-ratchet-fixtures"
fixture_count = len(list(fixtures_dir.glob("*.sql"))) if fixtures_dir.is_dir() else 0
check_true("at least 10 fixtures present", fixture_count >= 10)

# ---------------------------------------------------------------------------
# Layer 2 -- direct module-level negative control, independent of the
# fixture files (proves the CORE asymmetry even if a fixture were ever
# accidentally deleted or miscategorized).
# ---------------------------------------------------------------------------
print()
print("Layer 2: direct negative control (issue body's own example)")

NEGATIVE_CONTROL_GRANT = (
    "BEGIN;\n\nGRANT EXECUTE ON FUNCTION public.admin_delete_user() TO anon;\n\nCOMMIT;\n"
)
findings, _pass_notes = ratchet.evaluate_file("negctrl.sql", "", NEGATIVE_CONTROL_GRANT)
hard_fails = [f for f in findings if f.severity == "FAIL"]
check_true(
    "negative control (no money word, GRANT ... TO anon) FAILS the ratchet",
    len(hard_fails) == 1 and hard_fails[0].rule == "grant-to-disallowed-role",
)

REVOKE_DIRECTION = (
    "BEGIN;\n\nREVOKE EXECUTE ON FUNCTION public.admin_delete_user() FROM anon;\n\nCOMMIT;\n"
)
findings2, _pass_notes2 = ratchet.evaluate_file("negctrl_revoke.sql", "", REVOKE_DIRECTION)
hard_fails2 = [f for f in findings2 if f.severity == "FAIL"]
check_true(
    "the REVOKE direction of the same function PASSES (the asymmetry gh-1767 encodes)",
    len(hard_fails2) == 0,
)

ALLOWLISTED = (
    "BEGIN;\n\nGRANT EXECUTE ON FUNCTION public.admin_delete_user() TO service_role;\n\nCOMMIT;\n"
)
findings3, _pass_notes3 = ratchet.evaluate_file("negctrl_service_role.sql", "", ALLOWLISTED)
hard_fails3 = [f for f in findings3 if f.severity == "FAIL"]
check_true(
    "a GRANT to the allowlisted service_role role PASSES",
    len(hard_fails3) == 0,
)

BYPASSED = ratchet.evaluate_file("negctrl_bypass.sql", "", NEGATIVE_CONTROL_GRANT)[0]
ratchet.apply_bypass(BYPASSED, [ratchet.BYPASS_LABEL])
check_true(
    "the same dangerous grant, with the bypass label applied, has zero remaining FAIL severity",
    all(f.severity != "FAIL" for f in BYPASSED),
)
check_true(
    "...but the bypassed finding is still PRESENT (loud, not silently dropped)",
    len(BYPASSED) == 1 and BYPASSED[0].severity == "BYPASSED",
)

# Pre-existing (non-added) statements must never fail, even if they read as
# a live GRANT-to-anon -- the ratchet's whole job is to gate WIDENING, not
# to retroactively fail the repo's existing debt.
OLD_FILE = "BEGIN;\n\nGRANT EXECUTE ON FUNCTION public.legacy_fn() TO anon;\n\nCOMMIT;\n"
NEW_FILE_UNTOUCHED_GRANT_PLUS_NEW_REVOKE = (
    OLD_FILE.rsplit("COMMIT;", 1)[0]
    + "REVOKE EXECUTE ON FUNCTION public.other_fn() FROM PUBLIC;\n\nCOMMIT;\n"
)
findings4, _pass_notes4 = ratchet.evaluate_file(
    "preexisting.sql", OLD_FILE, NEW_FILE_UNTOUCHED_GRANT_PLUS_NEW_REVOKE
)
hard_fails4 = [f for f in findings4 if f.severity == "FAIL"]
check_true(
    "a pre-existing GRANT-to-anon statement untouched by this diff is NOT "
    "re-flagged, even when the same file gains an unrelated new statement",
    len(hard_fails4) == 0,
)

print()
print("assertions: %d, failures: %d" % (TOTAL_CHECKS, len(FAILURES)))
if FAILURES:
    print("FAILED CHECKS: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("ALL CHECKS PASSED")
sys.exit(0)
