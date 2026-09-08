#!/usr/bin/env python3
"""
Proof-of-ratchet test for scripts/migrations-reconciliation-check.py (gh-1438).

Proves the two directions that matter for a ratchet, per the CTO's own framing
on gh-1438 ("a lint that fails on 104 pre-existing items on day one is
disabled on day two"):

  1. The pre-existing gap (both the applied-no-file and repo-no-applied sides)
     PASSES unchanged, and stays passing when a PR adds an ordinary new
     not-yet-applied migration or fixes one of the pre-existing orphans.
  2. A PR that deletes the repo file for a version the baseline recorded as
     applied-and-documented FAILS -- that is the one widening a repo diff can
     see.

Also proves the gh-1438 amendment (issuecomment-5571428783, DECIDED
2026-09-07): a `_rollback.sql` / `_pre-flight.md` companion file is excluded
from `scan_repo_versions` on a real filesystem fixture (not just the
fabricated in-memory sets above the fold), and the end-to-end negative
control -- scan + compute_verdict together, against files actually on disk
-- still FAILS when a documented-applied migration's forward file is deleted,
even when a rollback companion for that same version is left behind.

No network access and no credentials required -- this drives the pure
`compute_verdict` comparison layer directly, the same importlib pattern this
repo already uses in scripts/edge-function-drift-check.test.py for scripts
whose filenames aren't valid Python module names. The two new fixture-based
tests below use `tempfile.TemporaryDirectory()` for the same reason --
real `os.listdir()` behavior, no mocking.

Run: python3 scripts/migrations-reconciliation-check.test.py
"""

import importlib.util
import os
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "ratchet", HERE / "migrations-reconciliation-check.py"
)
ratchet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratchet)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


# Fabricated baseline, not the real gh-1438 manifest -- keeps the test fast,
# readable, and independent of the live population size.
#   applied_versions            = {10, 20, 30, 40, 50}
#   applied_no_repo_file        = {30, 40}   <- legacy debt, no file ever filed
#   => applied_with_file        = {10, 20, 50}
#   repo_file_no_applied        = {60}       <- a stale unapplied draft
BASELINE = {
    "applied_versions": ["10", "20", "30", "40", "50"],
    "applied_no_repo_file_versions": ["30", "40"],
    "repo_file_no_applied_versions": ["60"],
}
BASELINE_REPO_VERSIONS = {"10", "20", "50", "60"}


def test_unchanged_state_passes():
    verdict = ratchet.compute_verdict(BASELINE, set(BASELINE_REPO_VERSIONS))
    check("unchanged state: ok", verdict["ok"], True)
    check("unchanged state: no regressions", verdict["regressions"], [])


def test_legacy_debt_alone_passes():
    # The baseline's own known gaps (30, 40 missing entirely; 60 unapplied)
    # must not fail a PR that doesn't touch migrations at all.
    verdict = ratchet.compute_verdict(BASELINE, set(BASELINE_REPO_VERSIONS))
    check("legacy debt alone: ok (day-one legacy must pass)", verdict["ok"], True)
    check(
        "legacy debt alone: baseline_applied_no_repo_file_count reported",
        verdict["baseline_applied_no_repo_file_count"],
        2,
    )
    check(
        "legacy debt alone: baseline_repo_no_applied_count reported",
        verdict["baseline_repo_no_applied_count"],
        1,
    )


def test_new_unapplied_migration_does_not_fail():
    # A PR adds a brand-new, not-yet-applied migration (version 70). Normal
    # mid-flight state for every migration ever written -- must not fail.
    current = set(BASELINE_REPO_VERSIONS) | {"70"}
    verdict = ratchet.compute_verdict(BASELINE, current)
    check("new unapplied migration: ok", verdict["ok"], True)
    check("new unapplied migration: no regressions", verdict["regressions"], [])
    check(
        "new unapplied migration: repo_no_applied grew by one (informational only)",
        verdict["current_repo_no_applied_count"],
        2,  # {60, 70}
    )


def test_partial_backfill_does_not_fail():
    # A PR fixes one of the legacy orphans by finally filing version 30.
    # Shrinking the gap is always allowed, no special-casing required.
    current = set(BASELINE_REPO_VERSIONS) | {"30"}
    verdict = ratchet.compute_verdict(BASELINE, current)
    check("partial backfill: ok", verdict["ok"], True)
    check("partial backfill: no regressions", verdict["regressions"], [])


def test_deleting_a_documented_applied_migration_fails():
    # THE widening case: a PR removes the repo file for version 20, which the
    # baseline recorded as APPLIED and documented. This re-opens exactly the
    # hole gh-1438 closed for that version.
    current = set(BASELINE_REPO_VERSIONS) - {"20"}
    verdict = ratchet.compute_verdict(BASELINE, current)
    check("deleted documented migration: ok is False", verdict["ok"], False)
    check("deleted documented migration: regression lists 20", verdict["regressions"], ["20"])


def test_deleting_two_documented_migrations_lists_both():
    current = set(BASELINE_REPO_VERSIONS) - {"10", "20"}
    verdict = ratchet.compute_verdict(BASELINE, current)
    check("deleted two: ok is False", verdict["ok"], False)
    check("deleted two: both regressions listed", verdict["regressions"], ["10", "20"])


def test_deleting_an_already_orphaned_version_is_not_double_counted():
    # Version 30 has no file at baseline anyway (it's already in
    # applied_no_repo_file_versions) -- "removing" a file that never existed
    # is a no-op, not a new regression.
    current = set(BASELINE_REPO_VERSIONS)  # 30 was never in here to begin with
    verdict = ratchet.compute_verdict(BASELINE, current)
    check("pre-existing orphan not double-counted: ok", verdict["ok"], True)


def test_render_report_mentions_fail_and_versions():
    current = set(BASELINE_REPO_VERSIONS) - {"20"}
    verdict = ratchet.compute_verdict(BASELINE, current)
    report = ratchet.render_report(verdict)
    check("report: contains FAIL", "FAIL" in report, True)
    check("report: contains regressed version", "20" in report, True)


def test_render_report_pass_case():
    verdict = ratchet.compute_verdict(BASELINE, set(BASELINE_REPO_VERSIONS))
    report = ratchet.render_report(verdict)
    check("report: contains PASS", "PASS" in report, True)


def test_scan_repo_versions_excludes_orphan_rollback_and_preflight():
    # gh-1438 amendment (issuecomment-5571428783): an orphan rollback/
    # pre-flight companion -- no forward .sql sibling at the same version --
    # would, before this fix, register as a brand-new "repo file but not
    # applied" version that can never be resolved, since a rollback script
    # is never itself applied. Real filesystem fixture, not a fabricated set.
    with tempfile.TemporaryDirectory() as tmp:
        mig_dir = os.path.join(tmp, "supabase", "migrations")
        os.makedirs(mig_dir)
        # A real, ordinary forward migration -- must still be scanned.
        open(os.path.join(mig_dir, "20260101000000_gh1_real_migration.sql"), "w").close()
        # An orphan rollback file at a version with NO forward sibling.
        open(os.path.join(mig_dir, "20990101000000_gh9999_orphan_rollback.sql"), "w").close()
        # An orphan pre-flight doc at a different orphan version.
        open(os.path.join(mig_dir, "20990101000001_gh9999_orphan_pre-flight.md"), "w").close()
        versions = ratchet.scan_repo_versions(tmp)
    check(
        "orphan rollback/pre-flight excluded from scan: only the real migration counted",
        versions,
        {"20260101000000"},
    )


def test_end_to_end_fixture_fails_when_documented_migration_file_deleted():
    # Full negative control on a real directory tree (not the fabricated
    # in-memory BASELINE_REPO_VERSIONS set used above): version 20's forward
    # file is deleted -- only its rollback companion is left behind, the
    # exact failure mode the CTO's ruling describes. Proves scan_repo_versions
    # + compute_verdict together still catch the regression: the rollback
    # companion does not mask it by supplying a same-named version, because
    # it is excluded from the scan on both sides.
    baseline = {
        "applied_versions": ["20260101000010", "20260101000020", "20260101000030"],
        "applied_no_repo_file_versions": ["20260101000030"],
        "repo_file_no_applied_versions": [],
    }
    with tempfile.TemporaryDirectory() as tmp:
        mig_dir = os.path.join(tmp, "supabase", "migrations")
        os.makedirs(mig_dir)
        open(os.path.join(mig_dir, "20260101000010_gh_a.sql"), "w").close()
        # version 20260101000020's forward file is DELETED; only its
        # rollback companion remains.
        open(os.path.join(mig_dir, "20260101000020_gh_b_rollback.sql"), "w").close()
        current = ratchet.scan_repo_versions(tmp)
        verdict = ratchet.compute_verdict(baseline, current)
    check("end-to-end fixture: ok is False", verdict["ok"], False)
    check(
        "end-to-end fixture: regression lists the deleted version, not masked by its rollback file",
        verdict["regressions"],
        ["20260101000020"],
    )


def main() -> int:
    test_unchanged_state_passes()
    test_legacy_debt_alone_passes()
    test_new_unapplied_migration_does_not_fail()
    test_partial_backfill_does_not_fail()
    test_deleting_a_documented_applied_migration_fails()
    test_deleting_two_documented_migrations_lists_both()
    test_deleting_an_already_orphaned_version_is_not_double_counted()
    test_render_report_mentions_fail_and_versions()
    test_render_report_pass_case()
    test_scan_repo_versions_excludes_orphan_rollback_and_preflight()
    test_end_to_end_fixture_fails_when_documented_migration_file_deleted()

    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) FAILED: {FAILURES}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
