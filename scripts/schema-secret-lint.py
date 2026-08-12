#!/usr/bin/env python3
"""
schema-secret-lint.py — OtterQuote Hardcoded-Secret-in-Function-Body Guard

Catches SQL function bodies that embed a live-looking secret literal instead
of reading it from Vault / current_setting, failing CI before the leak
reaches production.

Motivation: gh-720 (2026-08-11) — two SECURITY DEFINER trigger functions
(notify_feature_request_webhook, notify_hover_rebate) carried a hardcoded
sb_secret_ key in prosrc, which is world-readable via pg_catalog to anon and
authenticated. Both were rewritten to pull the key from
vault.decrypted_secrets at call time. This lint is the regression guard gh-720
and gh-770 both asked for, applied statically against the migration/SQL
source tree rather than the live database (CI has no DB credentials, and the
repo source is what a PR diff actually changes).

Secret shapes checked (same set as gh-720's own verification query):
  - sb_secret_...   (current-format Supabase secret key)
  - eyJ...          (legacy JWT prefix, base64 "{" start)

Usage:
  python3 scripts/schema-secret-lint.py [--root REPO_ROOT]

Exit codes:
  0  — clean (no violations)
  1  — one or more violations found

ADR: Docs/ADRs/ADR-010-schema-column-lint.md (this lint follows the same
fail-hard CI convention as schema-column-lint.py)
"""

import argparse
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Directories (relative to repo root) whose *.sql files are scanned.
SCAN_DIRS = ("supabase/migrations", "sql")

# CREATE [OR REPLACE] FUNCTION ... AS $tag$ ... $tag$  (tag may be empty, i.e. $$)
FUNCTION_BODY_PATTERN = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.\"]+)\s*\([^;]*?"
    r"AS\s+\$(\w*)\$(.*?)\$\2\$",
    re.IGNORECASE | re.DOTALL,
)

# Secret shapes: current-format Supabase secret key, and legacy JWT prefix.
SECRET_SHAPE_PATTERN = re.compile(r"sb_secret_[A-Za-z0-9_]*|eyJ[A-Za-z0-9_-]{10,}")


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def scan_file(rel_path: str, source: str, violations: list) -> None:
    for match in FUNCTION_BODY_PATTERN.finditer(source):
        func_name, _tag, body = match.group(1), match.group(2), match.group(3)
        body_start = match.start(3)
        for secret_match in SECRET_SHAPE_PATTERN.finditer(body):
            abs_index = body_start + secret_match.start()
            violations.append({
                "file": rel_path,
                "line": line_of(source, abs_index),
                "function": func_name,
                "message": (
                    f"function {func_name} body matches a hardcoded-secret shape "
                    f"({secret_match.group(0)[:12]}…) — read it from vault.decrypted_secrets "
                    f"or current_setting() instead"
                ),
            })


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", default=".", help="Repository root (default: current directory)"
    )
    args = parser.parse_args()

    repo_root = os.path.abspath(args.root)
    violations: list[dict] = []
    files_scanned = 0

    for scan_dir in SCAN_DIRS:
        dir_path = os.path.join(repo_root, scan_dir)
        if not os.path.isdir(dir_path):
            continue
        for dirpath, _dirnames, filenames in os.walk(dir_path):
            for fname in filenames:
                if Path(fname).suffix.lower() != ".sql":
                    continue
                full_path = os.path.join(dirpath, fname)
                rel_path = os.path.relpath(full_path, repo_root)
                try:
                    with open(full_path, encoding="utf-8", errors="replace") as f:
                        source = f.read()
                except OSError:
                    continue
                scan_file(rel_path, source, violations)
                files_scanned += 1

    for v in sorted(violations, key=lambda x: (x["file"], x["line"])):
        print(f"FAIL  {v['file']}:{v['line']} — {v['message']}")

    print(f"\n{'-' * 60}")
    print(f"Scanned {files_scanned} SQL file(s) | {len(violations)} violation(s)")

    if violations:
        print("Hardcoded-secret function-body check FAILED.")
        return 1

    print("Hardcoded-secret function-body check PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
