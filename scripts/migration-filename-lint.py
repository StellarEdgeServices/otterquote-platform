#!/usr/bin/env python3
"""
migration-filename-lint.py — OtterQuote Migration Filename Prefix Guard

Catches migration files in supabase/migrations/ that lack the
YYYYMMDDHHMMSS_ timestamp prefix Supabase's CLI-driven migration runner
requires. A file without that prefix is skipped by the runner silently --
no error, no warning, no CI signal -- so merging it to main is indistinguishable
from a real deploy until someone manually checks
supabase_migrations.schema_migrations against production.

Motivation: gh-1307 (2026-08-27) -- v113_derived_role_view.sql and
v114_fix_bid_accepted_trigger_and_notify.sql both merged to main without the
prefix. v114 sat merged-and-unapplied for ~12 minutes before being caught;
v113 sat merged-and-unapplied for over a week before anyone noticed, because
the failure produces no artifact of any kind. This is at least the second
occurrence of the same defect, so per R-148 it closes on a mechanism, not a
rule.

Usage:
  python3 scripts/migration-filename-lint.py [--root REPO_ROOT]

Exit codes:
  0  — clean (every .sql file in supabase/migrations/ carries the prefix)
  1  — one or more violations found

ADR: Docs/ADRs/ADR-010-schema-column-lint.md (this lint follows the same
fail-hard CI convention as schema-column-lint.py / schema-secret-lint.py)
"""

import argparse
import os
import re
import sys

# Directory (relative to repo root) whose *.sql files must carry the prefix.
MIGRATIONS_DIR = "supabase/migrations"

# Supabase's own convention: 14-digit YYYYMMDDHHMMSS, then an underscore.
PREFIX_PATTERN = re.compile(r"^\d{14}_")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", default=".", help="Repository root (default: current directory)"
    )
    args = parser.parse_args()

    repo_root = os.path.abspath(args.root)
    dir_path = os.path.join(repo_root, MIGRATIONS_DIR)

    if not os.path.isdir(dir_path):
        print(f"{MIGRATIONS_DIR} not found under {repo_root} -- nothing to check.")
        return 0

    violations = []
    files_scanned = 0

    for fname in sorted(os.listdir(dir_path)):
        if not fname.lower().endswith(".sql"):
            continue
        files_scanned += 1
        if not PREFIX_PATTERN.match(fname):
            violations.append(fname)

    for fname in violations:
        print(
            f"FAIL  {MIGRATIONS_DIR}/{fname} — missing the YYYYMMDDHHMMSS_ prefix "
            f"Supabase's migration runner requires. A file without it is skipped "
            f"silently at merge time: CI stays green, the PR closes, and nothing "
            f"runs against the database. Rename it with the timestamp you intend "
            f"to apply it at (or already applied it at, if backfilling) -- see gh-1307."
        )

    print(f"\n{'-' * 60}")
    print(f"Scanned {files_scanned} SQL file(s) in {MIGRATIONS_DIR}/ | {len(violations)} violation(s)")

    if violations:
        print("Migration filename prefix check FAILED.")
        return 1

    print("Migration filename prefix check PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
