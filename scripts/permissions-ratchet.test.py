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

# ---------------------------------------------------------------------------
# Layer 2b -- rule 4 (dynamic-sql-grant), independent of the fixture files.
# gh-1767 REVIEW: FAIL probe (g), PR #1836 comment 5578275973: a GRANT to
# anon wrapped in dynamic SQL (EXECUTE '<literal>' / EXECUTE format(...))
# is live, executable SQL that rules 1-3's statement splitter cannot see,
# because it blanks quoted/dollar-quoted content before splitting.
# ---------------------------------------------------------------------------
print()
print("Layer 2b: direct dynamic-sql-grant control (PR #1836 REVIEW: FAIL probe g)")

DYNAMIC_GRANT_EXECUTE_LITERAL = (
    "BEGIN;\n\nDO $$\nBEGIN\n"
    "  EXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO anon';\n"
    "END\n$$;\n\nCOMMIT;\n"
)
findings5, _pass_notes5 = ratchet.evaluate_file(
    "dynctrl_execute.sql", "", DYNAMIC_GRANT_EXECUTE_LITERAL
)
hard_fails5 = [f for f in findings5 if f.severity == "FAIL"]
check_true(
    "a GRANT ... TO anon wrapped in DO $$ EXECUTE '<literal>' FAILS as dynamic-sql-grant",
    len(hard_fails5) == 1 and hard_fails5[0].rule == "dynamic-sql-grant",
)

DYNAMIC_GRANT_FORMAT_UNKNOWN_ROLE = (
    "BEGIN;\n\nDO $$\nDECLARE\n  role_var text := 'anon';\nBEGIN\n"
    "  EXECUTE format('GRANT SELECT ON t TO %I', role_var);\n"
    "END\n$$;\n\nCOMMIT;\n"
)
findings6, _pass_notes6 = ratchet.evaluate_file(
    "dynctrl_format.sql", "", DYNAMIC_GRANT_FORMAT_UNKNOWN_ROLE
)
hard_fails6 = [f for f in findings6 if f.severity == "FAIL"]
check_true(
    "EXECUTE format('GRANT ... TO %I', role_var) FAILS CLOSED as "
    "dynamic-sql-grant-unknown-role (role not statically known)",
    len(hard_fails6) == 1 and hard_fails6[0].rule == "dynamic-sql-grant-unknown-role",
)

DYNAMIC_REVOKE_EXECUTE_LITERAL = (
    "BEGIN;\n\nDO $$\nBEGIN\n"
    "  EXECUTE 'REVOKE ALL ON FUNCTION public.f() FROM anon';\n"
    "END\n$$;\n\nCOMMIT;\n"
)
findings7, _pass_notes7 = ratchet.evaluate_file(
    "dynctrl_revoke.sql", "", DYNAMIC_REVOKE_EXECUTE_LITERAL
)
hard_fails7 = [f for f in findings7 if f.severity == "FAIL"]
check_true(
    "the REVOKE direction of the same dynamic-SQL shape PASSES "
    "(rule 4 preserves the GRANT/REVOKE asymmetry)",
    len(hard_fails7) == 0,
)

DYNAMIC_GRANT_WORD_IN_PROSE = (
    "BEGIN;\n\nINSERT INTO audit_log(msg) VALUES ('reviewed the GRANT policy');\n\nCOMMIT;\n"
)
findings8, _pass_notes8 = ratchet.evaluate_file(
    "dynctrl_prose.sql", "", DYNAMIC_GRANT_WORD_IN_PROSE
)
hard_fails8 = [f for f in findings8 if f.severity == "FAIL"]
check_true(
    "the word GRANT in prose text with no TO <role> shape PASSES rule 4",
    len(hard_fails8) == 0,
)

# ---------------------------------------------------------------------------
# Layer 2c -- gh-1767 fix2 (PR #1836 comment 5578401122): rule 1 unanchored
# + rule 4 concatenation-aware, independent of the fixture files.
# ---------------------------------------------------------------------------
print()
print("Layer 2c: rule 1 unanchored / rule 4 concatenation-aware (PR #1836 REVIEW: FAIL round 2)")

ALTER_DEFAULT_PRIV_GRANT_ANON = (
    "BEGIN;\n\nALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON "
    "FUNCTIONS TO anon;\n\nCOMMIT;\n"
)
findings9, _pass_notes9 = ratchet.evaluate_file(
    "altdef_grant.sql", "", ALTER_DEFAULT_PRIV_GRANT_ANON
)
hard_fails9 = [f for f in findings9 if f.severity == "FAIL"]
check_true(
    "probe (f): static ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon FAILS "
    "even though it does not start with the word GRANT",
    len(hard_fails9) == 1 and hard_fails9[0].rule == "grant-to-disallowed-role",
)

ALTER_DEFAULT_PRIV_REVOKE_ANON = (
    "BEGIN;\n\nALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON "
    "FUNCTIONS FROM anon;\n\nCOMMIT;\n"
)
findings10, _pass_notes10 = ratchet.evaluate_file(
    "altdef_revoke.sql", "", ALTER_DEFAULT_PRIV_REVOKE_ANON
)
hard_fails10 = [f for f in findings10 if f.severity == "FAIL"]
check_true(
    "the REVOKE direction of the same ALTER DEFAULT PRIVILEGES phrasing "
    "PASSES -- rule 1's unanchored scan is not so broad it starts flagging "
    "REVOKE-shaped statements that don't start with the word REVOKE",
    len(hard_fails10) == 0,
)

REVOKE_GRANT_OPTION_FOR = (
    "BEGIN;\n\nREVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.f() FROM "
    "anon;\n\nCOMMIT;\n"
)
findings11, _pass_notes11 = ratchet.evaluate_file(
    "revoke_grant_option.sql", "", REVOKE_GRANT_OPTION_FOR
)
hard_fails11 = [f for f in findings11 if f.severity == "FAIL"]
check_true(
    "REVOKE GRANT OPTION FOR ... FROM anon PASSES -- contains the literal "
    "word GRANT but is REVOKE-shaped (checked first, unconditionally)",
    len(hard_fails11) == 0,
)

DYNAMIC_GRANT_CONCAT_AFTER_TO = (
    "BEGIN;\n\nEXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO ' || "
    "'anon';\n\nCOMMIT;\n"
)
findings12, _pass_notes12 = ratchet.evaluate_file(
    "dynctrl_concat_after_to.sql", "", DYNAMIC_GRANT_CONCAT_AFTER_TO
)
hard_fails12 = [f for f in findings12 if f.severity == "FAIL"]
check_true(
    "probe (a): role split via || concat right at the TO boundary FAILS "
    "as dynamic-sql-grant with the role correctly resolved to anon",
    len(hard_fails12) == 1 and hard_fails12[0].rule == "dynamic-sql-grant",
)

DYNAMIC_GRANT_CONCAT_SPLIT_BEFORE_TO = (
    "BEGIN;\n\nEXECUTE 'GRANT EXECUTE ON FUNCTION public.f() ' || "
    "'TO anon';\n\nCOMMIT;\n"
)
findings13, _pass_notes13 = ratchet.evaluate_file(
    "dynctrl_concat_before_to.sql", "", DYNAMIC_GRANT_CONCAT_SPLIT_BEFORE_TO
)
hard_fails13 = [f for f in findings13 if f.severity == "FAIL"]
check_true(
    "probe (e): split before the TO keyword also FAILS as dynamic-sql-grant "
    "by design (span merge), not by dollar-quote accident",
    len(hard_fails13) == 1 and hard_fails13[0].rule == "dynamic-sql-grant",
)

DYNAMIC_GRANT_CONCAT_UNKNOWN_ROLE = (
    "BEGIN;\n\nCREATE OR REPLACE FUNCTION public.grant_to_role(r text) "
    "RETURNS void AS $$\nBEGIN\n  EXECUTE 'GRANT EXECUTE ON FUNCTION "
    "public.f() TO ' || quote_ident(r);\nEND;\n$$ LANGUAGE plpgsql;"
    "\n\nCOMMIT;\n"
)
findings14, _pass_notes14 = ratchet.evaluate_file(
    "dynctrl_concat_unknown.sql", "", DYNAMIC_GRANT_CONCAT_UNKNOWN_ROLE
)
hard_fails14 = [f for f in findings14 if f.severity == "FAIL"]
check_true(
    "role concatenated from a non-literal expression (quote_ident(r)) FAILS "
    "CLOSED as dynamic-sql-grant-unknown-role, same posture as an unresolved "
    "format() placeholder",
    len(hard_fails14) == 1 and hard_fails14[0].rule == "dynamic-sql-grant-unknown-role",
)

DYNAMIC_GRANT_CONCAT_SERVICE_ROLE = (
    "BEGIN;\n\nEXECUTE 'GRANT EXECUTE ON FUNCTION public.f() TO ' || "
    "'service_role';\n\nCOMMIT;\n"
)
findings15, _pass_notes15 = ratchet.evaluate_file(
    "dynctrl_concat_service_role.sql", "", DYNAMIC_GRANT_CONCAT_SERVICE_ROLE
)
hard_fails15 = [f for f in findings15 if f.severity == "FAIL"]
check_true(
    "positive control: a || -concatenated GRANT that resolves to the "
    "allowlisted service_role PASSES -- the merge logic actually checks "
    "the allowlist, it does not fail closed unconditionally",
    len(hard_fails15) == 0,
)

DYNAMIC_REVOKE_CONCAT = (
    "BEGIN;\n\nEXECUTE 'REVOKE EXECUTE ON FUNCTION public.f() FROM ' || "
    "'anon';\n\nCOMMIT;\n"
)
findings16, _pass_notes16 = ratchet.evaluate_file(
    "dynctrl_revoke_concat.sql", "", DYNAMIC_REVOKE_CONCAT
)
hard_fails16 = [f for f in findings16 if f.severity == "FAIL"]
check_true(
    "REVOKE split across the same || concatenation shape PASSES -- rule 4 "
    "only ever fires on GRANT, the merge does not change that",
    len(hard_fails16) == 0,
)

print()
print("assertions: %d, failures: %d" % (TOTAL_CHECKS, len(FAILURES)))
if FAILURES:
    print("FAILED CHECKS: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("ALL CHECKS PASSED")
sys.exit(0)
