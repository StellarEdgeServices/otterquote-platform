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

No network access and no credentials required -- this drives the pure
`compute_verdict` comparison layer directly, the same importlib pattern this
repo already uses in scripts/edge-function-drift-check.test.py for scripts
whose filenames aren't valid Python module names.

Run: python3 scripts/migrations-reconciliation-check.test.py
"""

import importlib.util
import pathlib
import sys

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

    if FAILURES:
        print(f"\n{len(FAILURES)} check(s) FAILED: {FAILURES}")
        return 1
    print("\nAll checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
