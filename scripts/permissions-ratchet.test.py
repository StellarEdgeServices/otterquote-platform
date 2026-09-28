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

# ---------------------------------------------------------------------------
# Layer 3 -- rename-awareness (gh-1438 follow-up, PR #2244 review comment
# 5851387029): changed_migration_files() previously used `git diff
# --name-only`, which performs NO rename detection, so a pure `git mv` /
# R100 rename of a migration file was read as a brand-new file with an
# empty old side -- every pre-existing, already-live GRANT in that file
# then read as newly ADDED and got flagged. These tests build a real git
# repo (subprocess `git`, not a mock) so `-M` rename detection is exercised
# for real, not merely asserted.
#
# CTO RUN 43 fresh-context review (comment 5856302490, REVIEW: FAIL) on the
# FIRST rename-awareness fix: treating every git-paired rename as "already
# live" makes the gate fail OPEN, because `-M` pairs files by CONTENT
# SIMILARITY, not by migration identity -- Supabase's real execution key is
# the 14-digit version prefix. The fix (this file's second pass) only keeps
# `old_path` when the version prefix is unchanged (safe re-slug) or the new
# version is already recorded as applied in
# supabase/migrations-reconciliation-baseline.json's `applied_versions`
# (PR #2244's real case). Cases A/A2 below are the SAFE renames (0
# findings); case B and the P1/P2/P7 cases are UNSAFE version-changing
# renames that must now be treated as brand-new files -- each is a
# fail-first negative control: it produced 0 findings on the FIRST fix
# (6999240a) and must produce >=1 finding on this head.
# ---------------------------------------------------------------------------
print()
print("Layer 3: rename-awareness (gh-1438 follow-up -- git diff -M / --find-renames)")

import json as _json
import subprocess as _subprocess
import tempfile as _tempfile


def _git(args, cwd):
    proc = _subprocess.run(
        ["git"] + args, cwd=str(cwd), capture_output=True, text=True
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "git %s failed (rc=%d): %s%s"
            % (" ".join(args), proc.returncode, proc.stdout, proc.stderr)
        )
    return proc.stdout.strip()


def _init_repo(cwd):
    _git(["init", "-q"], cwd)
    _git(["config", "user.email", "ratchet-test@example.com"], cwd)
    _git(["config", "user.name", "Ratchet Test"], cwd)


def _commit_all(cwd, msg):
    _git(["add", "-A"], cwd)
    _git(["commit", "-q", "-m", msg], cwd)
    return _git(["rev-parse", "HEAD"], cwd)


def _write_baseline(root: Path, applied_versions):
    """Writes a minimal supabase/migrations-reconciliation-baseline.json
    with the given applied_versions list. load_applied_versions() now reads
    this from a git REF (the `base` commit passed in), not off disk -- see
    its docstring (CTO RUN 45 review, comment 5868991987) -- so callers
    MUST commit this write (via _commit_all) at whichever ref they intend
    load_applied_versions() to read it from before that ref is used as
    `base`. A write left uncommitted, or committed only at `head`, is
    invisible to load_applied_versions(root, base)."""
    (root / "supabase").mkdir(parents=True, exist_ok=True)
    (root / "supabase" / "migrations-reconciliation-baseline.json").write_text(
        _json.dumps({"applied_versions": list(applied_versions)}), encoding="utf-8"
    )


# Deliberately a pre-existing, already-live GRANT TO anon (not service_role):
# on UNPATCHED main, a pure rename of this file is diffed against '' (the
# renamed path does not exist at base), so this statement reads as newly
# ADDED and wrongly fails rule 1. On the fix, a SAFE rename (this section's
# cases A/A2) is diffed against its OLD path's identical content, so this
# pre-existing statement is correctly seen as untouched and produces zero
# findings.
RENAME_BASE_SQL = "BEGIN;\n\nGRANT SELECT ON public.foo TO anon;\n\nCOMMIT;\n"

# --- Case A: slug-only rename (version prefix UNCHANGED) -> safe, 0 findings.
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-a-") as _tmp_a:
    _root_a = Path(_tmp_a)
    _init_repo(_root_a)
    _write_baseline(_root_a, [])
    _mig_a = _root_a / "supabase" / "migrations"
    _mig_a.mkdir(parents=True)
    _old_a = _mig_a / "20260101000000_foo.sql"
    _old_a.write_text(RENAME_BASE_SQL, encoding="utf-8")
    _base_a = _commit_all(_root_a, "base")

    _new_a = _mig_a / "20260101000000_foo_renamed.sql"
    _git(["mv", _old_a.name, _new_a.name], _mig_a)
    _head_a = _commit_all(_root_a, "pure rename, byte-identical content, SAME version prefix")

    _entries_a = ratchet.changed_migration_files(_root_a, _base_a, _head_a, set())
    check_true(
        "changed_migration_files() reports a same-version-prefix rename as "
        "ONE entry with an old_path set (not a bare add with old_path=None)",
        len(_entries_a) == 1
        and _entries_a[0][0].endswith("20260101000000_foo_renamed.sql")
        and _entries_a[0][1] is not None
        and _entries_a[0][1].endswith("20260101000000_foo.sql"),
    )

    _findings_a, _pn_a, _files_a, _bypass_a = ratchet.run_diff_mode(
        _root_a, _base_a, _head_a, []
    )
    _hard_a = [f for f in _findings_a if f.severity == "FAIL"]
    check_true(
        "a slug-only rename (version prefix unchanged) produces ZERO "
        "findings -- the exact version the CLI already ran is still the "
        "one that runs, so this stays safe",
        len(_hard_a) == 0,
    )
    check_true(
        "the renamed file is still inspected at its new path, not silently "
        "dropped",
        any(f.endswith("20260101000000_foo_renamed.sql") for f in _files_a),
    )

# --- Case A2: version-changing rename, but the NEW version is already
# recorded as applied in applied_versions (PR #2244's real shape: renaming
# a file to its actual, already-applied ledger version) -> safe, 0 findings.
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-a2-") as _tmp_a2:
    _root_a2 = Path(_tmp_a2)
    _init_repo(_root_a2)
    _write_baseline(_root_a2, ["20260101000001"])
    _mig_a2 = _root_a2 / "supabase" / "migrations"
    _mig_a2.mkdir(parents=True)
    _old_a2 = _mig_a2 / "20260101000000_foo.sql"
    _old_a2.write_text(RENAME_BASE_SQL, encoding="utf-8")
    _base_a2 = _commit_all(_root_a2, "base")

    _new_a2 = _mig_a2 / "20260101000001_foo.sql"
    _git(["mv", _old_a2.name, _new_a2.name], _mig_a2)
    _head_a2 = _commit_all(_root_a2, "rename to the real, already-applied ledger version")

    _findings_a2, _pn_a2, _files_a2, _bypass_a2 = ratchet.run_diff_mode(
        _root_a2, _base_a2, _head_a2, []
    )
    _hard_a2 = [f for f in _findings_a2 if f.severity == "FAIL"]
    check_true(
        "a version-changing rename to a version already in applied_versions "
        "(PR #2244's real case) produces ZERO findings",
        len(_hard_a2) == 0,
    )

# --- Case B: version-changing rename (NOT in applied_versions) with a new
# violation added in the same diff -- must flag the added violation, same
# as before, now via the whole-file-is-new path rather than a diff against
# stale old content.
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-b-") as _tmp_b:
    _root_b = Path(_tmp_b)
    _init_repo(_root_b)
    _write_baseline(_root_b, [])
    _mig_b = _root_b / "supabase" / "migrations"
    _mig_b.mkdir(parents=True)
    _BENIGN_BASE_SQL = "BEGIN;\n\nCREATE TABLE public.foo (id int);\n\nCOMMIT;\n"
    _old_b = _mig_b / "20260101000000_foo.sql"
    _old_b.write_text(_BENIGN_BASE_SQL, encoding="utf-8")
    _base_b = _commit_all(_root_b, "base")

    _new_b = _mig_b / "20260601000000_foo.sql"
    _git(["mv", _old_b.name, _new_b.name], _mig_b)
    _new_b.write_text(
        _BENIGN_BASE_SQL.rsplit("COMMIT;", 1)[0]
        + "GRANT SELECT ON public.foo TO anon;\n\nCOMMIT;\n",
        encoding="utf-8",
    )
    _head_b = _commit_all(
        _root_b, "version-changing rename + new GRANT TO anon in the same diff"
    )

    _findings_b, _pn_b, _files_b, _bypass_b = ratchet.run_diff_mode(
        _root_b, _base_b, _head_b, []
    )
    _hard_b = [f for f in _findings_b if f.severity == "FAIL"]
    check_true(
        "negative control: a version-changing rename with an added GRANT "
        "TO anon in the SAME commit still flags the added GRANT -- "
        "rename-awareness must not blind the ratchet to a real new "
        "violation riding along in the same diff",
        len(_hard_b) == 1 and _hard_b[0].rule == "grant-to-disallowed-role",
    )

# --- Case C: brand-new file, no rename involved at all -> still flagged.
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-c-") as _tmp_c:
    _root_c = Path(_tmp_c)
    _init_repo(_root_c)
    _write_baseline(_root_c, [])
    _mig_c = _root_c / "supabase" / "migrations"
    _mig_c.mkdir(parents=True)
    _existing_c = _mig_c / "20260101000000_foo.sql"
    _existing_c.write_text(RENAME_BASE_SQL, encoding="utf-8")
    _base_c = _commit_all(_root_c, "base")

    _brand_new_c = _mig_c / "20260101000002_bar.sql"
    _brand_new_c.write_text(
        "BEGIN;\n\nGRANT SELECT ON public.bar TO anon;\n\nCOMMIT;\n", encoding="utf-8"
    )
    _head_c = _commit_all(_root_c, "brand-new file with GRANT TO anon (no rename)")

    _findings_c, _pn_c, _files_c, _bypass_c = ratchet.run_diff_mode(
        _root_c, _base_c, _head_c, []
    )
    _hard_c = [f for f in _findings_c if f.severity == "FAIL"]
    check_true(
        "a brand-new file (no rename involved at all) with GRANT TO anon is "
        "still flagged exactly as before this fix",
        len(_hard_c) == 1 and _hard_c[0].rule == "grant-to-disallowed-role",
    )

# ---------------------------------------------------------------------------
# Layer 3b -- CTO RUN 43 masked-case negative controls (comment 5856302490):
# each of these produced ZERO findings on the FIRST rename-awareness fix
# (6999240a, "every git-paired rename is already-live") and must produce
# >=1 finding on this head, which only trusts a rename when the version
# prefix didn't change or the new version is already-applied.
# ---------------------------------------------------------------------------
print()
print("Layer 3b: CTO RUN 43 masked-case negative controls (comment 5856302490)")

# P1: an old, already-applied migration's anon GRANT is git-mv'd to a LATER,
# never-applied version. On deploy this RE-EXECUTES the GRANT under the new
# version -- it must be evaluated as brand-new content, not "already live".
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-p1-") as _tmp_p1:
    _root_p1 = Path(_tmp_p1)
    _init_repo(_root_p1)
    _write_baseline(_root_p1, ["20250101000000"])  # old version IS applied
    _mig_p1 = _root_p1 / "supabase" / "migrations"
    _mig_p1.mkdir(parents=True)
    _P1_SQL = "BEGIN;\n\nGRANT SELECT ON public.secrets TO anon;\n\nCOMMIT;\n"
    _old_p1 = _mig_p1 / "20250101000000_a.sql"
    _old_p1.write_text(_P1_SQL, encoding="utf-8")
    _base_p1 = _commit_all(_root_p1, "base -- already-applied anon grant")

    _new_p1 = _mig_p1 / "20261001000000_a.sql"  # LATER version, never applied
    _git(["mv", _old_p1.name, _new_p1.name], _mig_p1)
    _head_p1 = _commit_all(_root_p1, "P1: git mv to a later, never-applied version")

    _entries_p1 = ratchet.changed_migration_files(
        _root_p1, _base_p1, _head_p1, ratchet.load_applied_versions(_root_p1, _base_p1)
    )
    check_true(
        "P1: renaming to a later, never-applied version reports old_path=None "
        "(treated as brand-new, not diffed against the old path's content)",
        len(_entries_p1) == 1 and _entries_p1[0][1] is None,
    )
    _findings_p1, _pn_p1, _files_p1, _bypass_p1 = ratchet.run_diff_mode(
        _root_p1, _base_p1, _head_p1, []
    )
    _hard_p1 = [f for f in _findings_p1 if f.severity == "FAIL"]
    check_true(
        "P1 (masked on 6999240a): a git-mv to a later, never-applied version "
        "FAILS -- re-running this GRANT under a version that never ran it "
        "before is exactly what must not be waved through",
        len(_hard_p1) == 1 and _hard_p1[0].rule == "grant-to-disallowed-role",
    )

# P2: git pairs a brand-new, unrelated migration with a deleted file at a
# high (but non-R100) similarity score because most of the file is shared
# boilerplate, including a pre-existing GRANT TO anon that then reads as
# "carried over, untouched" unless the version-safety check kicks in.
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-p2-") as _tmp_p2:
    _root_p2 = Path(_tmp_p2)
    _init_repo(_root_p2)
    _write_baseline(_root_p2, ["20250101000000"])
    _mig_p2 = _root_p2 / "supabase" / "migrations"
    _mig_p2.mkdir(parents=True)
    _P2_OLD_SQL = (
        "BEGIN;\n\n"
        "-- shared boilerplate line 1\n"
        "-- shared boilerplate line 2\n"
        "-- shared boilerplate line 3\n"
        "GRANT SELECT ON public.legacy_widget TO anon;\n\n"
        "COMMIT;\n"
    )
    _old_p2 = _mig_p2 / "20250101000000_b.sql"
    _old_p2.write_text(_P2_OLD_SQL, encoding="utf-8")
    _base_p2 = _commit_all(_root_p2, "base -- already-applied legacy grant")

    _git(["rm", "-q", _old_p2.name], _mig_p2)
    _P2_NEW_SQL = (
        "BEGIN;\n\n"
        "-- shared boilerplate line 1\n"
        "-- shared boilerplate line 2\n"
        "-- shared boilerplate line 3\n"
        "GRANT SELECT ON public.legacy_widget TO anon;\n"
        "GRANT SELECT ON public.new_feature_table TO anon;\n\n"
        "COMMIT;\n"
    )
    _new_p2 = _mig_p2 / "20261001000000_totally_new_feature.sql"
    _new_p2.write_text(_P2_NEW_SQL, encoding="utf-8")
    _head_p2 = _commit_all(
        _root_p2, "P2: unrelated new migration, high textual similarity to a deleted file"
    )

    _entries_p2 = ratchet.changed_migration_files(
        _root_p2, _base_p2, _head_p2, ratchet.load_applied_versions(_root_p2, _base_p2)
    )
    check_true(
        "P2: git -M pairs the new file with the deleted one by similarity, "
        "but the version-safety check still reports old_path=None",
        len(_entries_p2) == 1
        and _entries_p2[0][0].endswith("20261001000000_totally_new_feature.sql")
        and _entries_p2[0][1] is None,
    )
    _findings_p2, _pn_p2, _files_p2, _bypass_p2 = ratchet.run_diff_mode(
        _root_p2, _base_p2, _head_p2, []
    )
    _hard_p2 = [f for f in _findings_p2 if f.severity == "FAIL"]
    check_true(
        "P2 (masked on 6999240a): both the carried-over legacy GRANT and the "
        "new feature's own GRANT are flagged once the pairing is treated as "
        "unsafe (2 findings, not the 1 the buggy fix would have shown)",
        len(_hard_p2) == 2
        and all(f.rule == "grant-to-disallowed-role" for f in _hard_p2),
    )

# P7: two files deleted, one added; git pairs the add with the
# byte-identical deleted file as an R100 "identical rename" even though the
# added file was never applied under that name.
with _tempfile.TemporaryDirectory(prefix="ratchet-rename-p7-") as _tmp_p7:
    _root_p7 = Path(_tmp_p7)
    _init_repo(_root_p7)
    _write_baseline(_root_p7, ["20250101000000", "20250101000001"])
    _mig_p7 = _root_p7 / "supabase" / "migrations"
    _mig_p7.mkdir(parents=True)
    _P7_A_SQL = "BEGIN;\n\nGRANT SELECT ON public.old_table TO anon;\n\nCOMMIT;\n"
    _P7_B_SQL = "BEGIN;\n\nCREATE TABLE public.other (id int);\n\nCOMMIT;\n"
    _old_p7_a = _mig_p7 / "20250101000000_a.sql"
    _old_p7_a.write_text(_P7_A_SQL, encoding="utf-8")
    _old_p7_b = _mig_p7 / "20250101000001_b.sql"
    _old_p7_b.write_text(_P7_B_SQL, encoding="utf-8")
    _base_p7 = _commit_all(_root_p7, "base -- two already-applied files")

    _git(["rm", "-q", _old_p7_a.name], _mig_p7)
    _git(["rm", "-q", _old_p7_b.name], _mig_p7)
    _new_p7 = _mig_p7 / "20261001000000_c.sql"
    _new_p7.write_text(_P7_A_SQL, encoding="utf-8")  # byte-identical to a.sql
    _head_p7 = _commit_all(
        _root_p7, "P7: two deletes + one byte-identical add, never-applied version"
    )

    _entries_p7 = ratchet.changed_migration_files(
        _root_p7, _base_p7, _head_p7, ratchet.load_applied_versions(_root_p7, _base_p7)
    )
    # Two entries come back: the R100-paired add (c.sql, old_path decided by
    # the version-safety check below) and the plain delete of b.sql (kept
    # with old_path=None like any ordinary delete -- run_diff_mode() drops
    # it once git_show() at head returns None for a deleted path). Only c's
    # entry is this case's subject.
    _entry_p7_c = next(
        (e for e in _entries_p7 if e[0].endswith("20261001000000_c.sql")), None
    )
    check_true(
        "P7: an R100 byte-identical pairing to a never-applied version still "
        "reports old_path=None",
        _entry_p7_c is not None and _entry_p7_c[1] is None,
    )
    _findings_p7, _pn_p7, _files_p7, _bypass_p7 = ratchet.run_diff_mode(
        _root_p7, _base_p7, _head_p7, []
    )
    _hard_p7 = [f for f in _findings_p7 if f.severity == "FAIL"]
    check_true(
        "P7 (masked on 6999240a): the byte-identical content, now running "
        "under a version it never ran under before, is flagged",
        len(_hard_p7) == 1 and _hard_p7[0].rule == "grant-to-disallowed-role",
    )

# ---------------------------------------------------------------------------
# Layer 3c: CTO RUN 45 fresh-context review (comment 5868991987) -- a PR
# cannot approve its own rename by editing the baseline JSON in the same
# head. load_applied_versions() must read applied_versions from `base`,
# never from the PR's own working tree / head commit.
# ---------------------------------------------------------------------------
print()
print("Layer 3c: CTO RUN 45 self-approving-baseline negative control (comment 5868991987)")

with _tempfile.TemporaryDirectory(prefix="ratchet-rename-p8-") as _tmp_p8:
    _root_p8 = Path(_tmp_p8)
    _init_repo(_root_p8)
    # base: the OLD version is live with an anon GRANT; the baseline does
    # NOT (yet) list the later version this PR is about to rename onto.
    _write_baseline(_root_p8, ["20250101000000"])
    _mig_p8 = _root_p8 / "supabase" / "migrations"
    _mig_p8.mkdir(parents=True)
    _P8_SQL = "BEGIN;\n\nGRANT SELECT ON public.secrets TO anon;\n\nCOMMIT;\n"
    _old_p8 = _mig_p8 / "20250101000000_a.sql"
    _old_p8.write_text(_P8_SQL, encoding="utf-8")
    _base_p8 = _commit_all(_root_p8, "base -- baseline does not list 20261001000000")

    # head, ONE commit: git mv to a later, never-applied version AND append
    # that same version to the baseline JSON -- the self-approval this
    # review reproduced. If load_applied_versions() read this off disk /
    # the PR's own head, the rename would read as "already live".
    _new_p8 = _mig_p8 / "20261001000000_a.sql"
    _git(["mv", _old_p8.name, _new_p8.name], _mig_p8)
    _write_baseline(_root_p8, ["20250101000000", "20261001000000"])
    _head_p8 = _commit_all(
        _root_p8, "P8: rename to a never-applied version + self-approve via baseline edit"
    )

    check_true(
        "P8: applied_versions read from `base` does NOT include the version "
        "this head's own commit added to the baseline",
        "20261001000000" not in ratchet.load_applied_versions(_root_p8, _base_p8),
    )
    _findings_p8, _pn_p8, _files_p8, _bypass_p8 = ratchet.run_diff_mode(
        _root_p8, _base_p8, _head_p8, []
    )
    _hard_p8 = [f for f in _findings_p8 if f.severity == "FAIL"]
    check_true(
        "P8: a PR cannot approve its own rename by editing the baseline in "
        "the same head -- reading applied_versions from `base` still flags "
        "the carried-over GRANT (GATE: FAIL), not waved through as PASS",
        len(_hard_p8) == 1 and _hard_p8[0].rule == "grant-to-disallowed-role",
    )
    # Positive control: this is really testing the base-vs-head distinction,
    # not something else broken -- when the target version is ALREADY in
    # the baseline AT base (Layer 3's existing "case A2" shape, no
    # self-approval involved), the identical rename is 0 findings.
    with _tempfile.TemporaryDirectory(prefix="ratchet-rename-p8ctrl-") as _tmp_p8c:
        _root_p8c = Path(_tmp_p8c)
        _init_repo(_root_p8c)
        _write_baseline(_root_p8c, ["20250101000000", "20261001000000"])
        _mig_p8c = _root_p8c / "supabase" / "migrations"
        _mig_p8c.mkdir(parents=True)
        _old_p8c = _mig_p8c / "20250101000000_a.sql"
        _old_p8c.write_text(_P8_SQL, encoding="utf-8")
        _base_p8c = _commit_all(_root_p8c, "base -- baseline already lists 20261001000000")
        _git(["mv", _old_p8c.name, "20261001000000_a.sql"], _mig_p8c)
        _head_p8c = _commit_all(_root_p8c, "P8 control: rename onto an already-applied-at-base version")
        _findings_p8c, _pn_p8c, _files_p8c, _bypass_p8c = ratchet.run_diff_mode(
            _root_p8c, _base_p8c, _head_p8c, []
        )
        check_true(
            "P8 control: the same rename with the target version ALREADY in "
            "the baseline AT BASE (no self-approval) is 0 findings",
            len([f for f in _findings_p8c if f.severity == "FAIL"]) == 0,
        )


print()
print("assertions: %d, failures: %d" % (TOTAL_CHECKS, len(FAILURES)))
if FAILURES:
    print("FAILED CHECKS: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("ALL CHECKS PASSED")
sys.exit(0)
