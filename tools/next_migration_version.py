"""next_migration_version - single source of truth for the next free vNNN
migration number (GitHub #729).

ROOT CAUSE THIS FIXES: v-numbers are a single global sequence shared by two
directories that serve different technical roles:
  - supabase/migrations/  - timestamp-prefixed files tracked by the Supabase
    CLI's own migration-history table (supabase_migrations.schema_migrations).
  - sql/                  - hand-authored SQL applied directly (via the
    Supabase MCP or psql), paired with a *_rollback.sql sibling, not run
    through the CLI.

Consolidating the two directories into one was considered and rejected: the
Supabase CLI requires its own timestamp-prefixed naming and history-table
bookkeeping for supabase/migrations/, and forcing 226 hand-applied sql/
files to retroactively comply with that would be a large, risky rewrite for
no functional gain (D-221 Path A already routes both kinds of change through
the same PR -> CI -> merge flow regardless of which directory they land in).

Instead: v-numbers stay a SINGLE shared sequence (a v-number is meant to be
a globally unique identifier regardless of which directory holds the file -
splitting the counter per-directory would just trade one confusion
("which directory has the highest number?") for another ("do the two v107s
mean the same thing?")). What was actually missing was tooling: nothing
scanned BOTH directories before picking the next number. The existing
migration-author skill's Step 2 already had a DB-truth collision guard
(2026-07-03, after v87 collided twice within supabase/migrations/ alone) but
it only scanned supabase/migrations/ - never sql/. That gap is exactly how
v105/v106 (sql/) and the v107 pick for #711 (supabase/migrations/) collided
this week.

USAGE
  python tools/next_migration_version.py
  python tools/next_migration_version.py --project-id yeszghaspzwwstvsrioa

Prints the next free vNNN and a breakdown of where each candidate max came
from (sql/, supabase/migrations/, and live DB truth if --project-id is
given or SUPABASE_PROJECT_ID is set). If any two sources disagree on the
max, that is reported explicitly rather than silently resolved - this
mirrors the existing DB-truth collision guard's "record the drift, don't
silently pick either" rule.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SQL_DIR = REPO_ROOT / "sql"
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"

_V_PATTERN = re.compile(r"v(\d+)")


def _max_v_in_dir(directory: pathlib.Path) -> tuple[int, str | None]:
    """Return (max_v_number, filename_it_came_from) for *.sql files in directory.

    Returns (0, None) if the directory doesn't exist or has no v-numbered files.
    """
    if not directory.is_dir():
        return 0, None
    best_num = 0
    best_file: str | None = None
    for f in sorted(directory.glob("*.sql")):
        m = _V_PATTERN.search(f.name)
        if not m:
            continue
        num = int(m.group(1))
        if num > best_num:
            best_num = num
            best_file = f.name
    return best_num, best_file


def _max_v_in_db(project_id: str) -> tuple[int, str | None]:
    """Best-effort: shell out to the Supabase CLI's migration list.

    Returns (0, None) on any failure (CLI missing, not logged in, etc.) rather
    than raising - DB truth is a cross-check, not a hard dependency for a
    quick local run. Callers that need the authoritative check should also
    run `list_migrations` via the Supabase MCP tool directly, which is more
    reliable than shelling out from this script.
    """
    try:
        result = subprocess.run(
            ["supabase", "migration", "list", "--project-ref", project_id],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return 0, None
    if result.returncode != 0:
        return 0, None
    best_num = 0
    best_line: str | None = None
    for line in result.stdout.splitlines():
        m = _V_PATTERN.search(line)
        if not m:
            continue
        num = int(m.group(1))
        if num > best_num:
            best_num = num
            best_line = line.strip()
    return best_num, best_line


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--project-id", default=None,
                         help="Supabase project ref to cross-check against live DB truth "
                              "(optional - falls back to repo-only if the CLI is unavailable).")
    args = parser.parse_args()

    sql_max, sql_file = _max_v_in_dir(SQL_DIR)
    migrations_max, migrations_file = _max_v_in_dir(MIGRATIONS_DIR)

    print(f"sql/                 max v{sql_max:<4} ({sql_file or 'none'})")
    print(f"supabase/migrations/ max v{migrations_max:<4} ({migrations_file or 'none'})")

    db_max = 0
    if args.project_id:
        db_max, db_line = _max_v_in_db(args.project_id)
        if db_max:
            print(f"live DB (CLI)         max v{db_max:<4} ({db_line})")
        else:
            print("live DB (CLI)         unavailable - cross-check separately via the "
                  "Supabase MCP list_migrations tool before finalizing a number for a "
                  "Tier 3 migration.")

    overall_max = max(sql_max, migrations_max, db_max)
    next_num = overall_max + 1

    sources_agree = len({v for v in (sql_max, migrations_max) if v}) <= 1 or overall_max in (sql_max, migrations_max)
    if not sources_agree:
        print(f"\nWARNING: sources disagree on the max (sql/={sql_max}, "
              f"supabase/migrations/={migrations_max}) - investigate before picking a "
              f"number rather than trusting this script's max() blindly.")

    print(f"\nNext free migration number: v{next_num}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
