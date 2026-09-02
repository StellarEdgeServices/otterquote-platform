#!/usr/bin/env python3
"""
migrations-reconciliation-check.py -- gh-1438 CI reconciliation RATCHET.

Background (gh-1438): `supabase/migrations/` and production's
`supabase_migrations.schema_migrations` disagree in both directions -- as of
the baseline snapshot this ratchet ships with, 105 applied migrations have no
repo file, and 29 repo files were never applied. The CTO's ruling
(issuecomment-5488058121, amended -5494363131 on gh-1438) is explicit that a
lint failing on that pre-existing population "is disabled on day two"; the
ratchet's only job is to stop the gap from growing while the backfill batches
(a separate, unscoped, oldest-first effort) burn it down.

THE ONE THING THIS SCRIPT GATES

  A version that had a file in `supabase/migrations/` at baseline time (i.e.
  production's schema_migrations recorded it as applied, AND the repo already
  documented it) must still have a file in this PR's tree. Deleting or
  renaming away such a file re-opens a hole gh-1438 just closed for that
  version -- that is a widening this script can see, because it is fully
  visible in a repo diff.

WHAT THIS SCRIPT DELIBERATELY DOES NOT GATE, AND WHY

  - New, not-yet-applied migration files added by a PR. Per this repo's own
    deploy chain (CLAUDE.md, D-221 Path A: "GitHub PR -> merge -> Supabase
    migration auto-run"), a brand-new migration is *always* unapplied for the
    life of its PR -- that is normal, not drift. Gating on it would turn every
    ordinary migration-authoring PR red.

  - The pre-existing 105/29 baseline debt itself. Not this PR's problem, and
    not this script's job to fix (see the backfill batches referenced in the
    gh-1438 issue history). A PR that happens to file one of the missing 105
    is welcomed silently -- it only ever shrinks the gap this script watches,
    never grows it, so no special-casing is needed.

  - A migration applied directly to production OUTSIDE any PR (via
    `apply_migration` through the Supabase MCP or dashboard, with no file ever
    committed here). That is the leak the CTO's ruling names explicitly
    ("gh1410_claims_measurement_shape made it 110 ... by exactly the leak this
    issue names") and it is invisible to a per-PR repo-diff check by
    construction: nothing in the repo changed, so there is no diff, so there
    is no signal for this script to act on. Catching that needs a live query
    against production compared on a schedule, not a PR gate -- see the
    "known_limitations" entry in the baseline manifest for the honest
    statement that this is not built here.

Usage:
  python3 scripts/migrations-reconciliation-check.py [--root REPO_ROOT]
      [--baseline PATH] [--markdown-out PATH]

Exit codes:
  0 -- no regression (includes the unchanged legacy-debt state)
  1 -- a PR-visible regression was found (a documented applied migration's
       file went missing)
  2 -- could not run the check at all (baseline manifest missing/unreadable)
"""

import argparse
import json
import os
import re
import sys

MIGRATIONS_DIR = "supabase/migrations"
VERSION_RE = re.compile(r"^(\d{14})_.*\.sql$")


def scan_repo_versions(root: str, migrations_dir: str = MIGRATIONS_DIR) -> set:
    """Return the set of distinct 14-digit version prefixes present under
    supabase/migrations/ in the given repo root. Pure filesystem read, no
    network."""
    dir_path = os.path.join(root, migrations_dir)
    versions = set()
    if not os.path.isdir(dir_path):
        return versions
    for fname in os.listdir(dir_path):
        m = VERSION_RE.match(fname)
        if m:
            versions.add(m.group(1))
    return versions


def load_baseline(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def compute_verdict(baseline: dict, current_repo_versions: set) -> dict:
    """Pure comparison layer -- no filesystem, no network beyond what the
    caller already resolved. Unit-tested directly by
    migrations-reconciliation-check.test.py with fabricated baselines, so the
    verdict logic is provable without touching a real repo or a real
    database.

    `baseline` must have:
      - "applied_versions": list[str]              (full applied set at baseline)
      - "applied_no_repo_file_versions": list[str]  (subset of the above with no file)
      - "repo_file_no_applied_versions": list[str]  (informational only, not gated)
    """
    applied_versions = set(baseline["applied_versions"])
    applied_no_file_baseline = set(baseline["applied_no_repo_file_versions"])
    applied_with_file_baseline = applied_versions - applied_no_file_baseline

    regressions = sorted(applied_with_file_baseline - current_repo_versions)

    repo_no_applied_current = sorted(current_repo_versions - applied_versions)

    return {
        "ok": len(regressions) == 0,
        "regressions": regressions,
        "baseline_applied_no_repo_file_count": len(applied_no_file_baseline),
        "current_repo_no_applied_count": len(repo_no_applied_current),
        "baseline_repo_no_applied_count": len(baseline.get("repo_file_no_applied_versions", [])),
        "current_repo_version_count": len(current_repo_versions),
    }


def render_report(verdict: dict) -> str:
    lines = []
    lines.append("## gh-1438 migrations reconciliation ratchet")
    lines.append("")
    if verdict["ok"]:
        lines.append(
            "PASS -- no migration that the gh-1438 baseline recorded as APPLIED "
            "and documented lost its repo file in this diff."
        )
    else:
        lines.append(
            "FAIL -- this PR removes the repo file for one or more migrations "
            "the baseline recorded as APPLIED and documented. That re-opens a "
            "hole gh-1438 closed for those versions."
        )
        lines.append("")
        lines.append("Regressed versions (applied + previously filed, now missing a file):")
        for v in verdict["regressions"]:
            lines.append(f"  - {v}")
    lines.append("")
    lines.append(
        f"Baseline applied-but-no-repo-file debt (pre-existing, NOT gated by "
        f"this check -- see the backfill batches): {verdict['baseline_applied_no_repo_file_count']}"
    )
    lines.append(
        f"Current repo-file-but-not-applied count (informational only, NOT "
        f"gated -- brand-new migrations are always unapplied mid-PR): "
        f"{verdict['current_repo_no_applied_count']} "
        f"(baseline: {verdict['baseline_repo_no_applied_count']})"
    )
    lines.append("")
    lines.append(
        "This check cannot see a migration applied to production outside any "
        "PR (no file ever committed) -- that leak needs a live query against "
        "the database, not a repo diff. See the baseline manifest's "
        "known_limitations."
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--root", default=".", help="Repository root (default: current directory)"
    )
    parser.add_argument(
        "--baseline",
        default="supabase/migrations-reconciliation-baseline.json",
        help="Path to the baseline manifest, relative to --root unless absolute",
    )
    parser.add_argument(
        "--markdown-out", default=None, help="Optional path to write the report as markdown"
    )
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    baseline_path = (
        args.baseline if os.path.isabs(args.baseline) else os.path.join(root, args.baseline)
    )

    if not os.path.isfile(baseline_path):
        print(
            f"FAIL -- baseline manifest not found at {baseline_path}. "
            f"The ratchet cannot run without something to ratchet against."
        )
        return 2

    try:
        baseline = load_baseline(baseline_path)
    except (json.JSONDecodeError, OSError) as e:
        print(f"FAIL -- could not read/parse baseline manifest at {baseline_path}: {e}")
        return 2

    current_repo_versions = scan_repo_versions(root)
    verdict = compute_verdict(baseline, current_repo_versions)
    report = render_report(verdict)
    print(report)

    if args.markdown_out:
        with open(args.markdown_out, "w", encoding="utf-8") as f:
            f.write(report + "\n")

    return 0 if verdict["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
