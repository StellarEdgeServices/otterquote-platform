#!/usr/bin/env python3
"""
schema-secret-lint.py — OtterQuote Hardcoded-Secret-in-Function Linter

Catches SQL migration files that hardcode a secret-shaped literal
(Supabase sb_secret_ key, or a JWT starting eyJ) inside a public function
body, instead of reading it from vault.decrypted_secrets at call time.

Motivation (GitHub #720 / #770): notify_feature_request_webhook and
notify_hover_rebate both hardcoded the service-role key directly in a
SECURITY DEFINER function body. A hardcoded secret in a function body
ships with every schema dump and migration diff, and survives key
rotation silently (the function keeps using the old value). This lint
fails CI before that class of leak reaches production again.

Usage:
  python3 scripts/schema-secret-lint.py [--root REPO_ROOT]

Exit codes:
  0  — clean (no violations)
  1  — one or more violations found
"""

import argparse
import re
import sys
from pathlib import Path

SCAN_DIRS = ("supabase/migrations", "sql")

FUNCTION_START = re.compile(
    r"CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(public\.)?", re.IGNORECASE
)

# Secret shapes: Supabase new-style secret keys, and JWT-prefixed literals.
SECRET_SHAPE = re.compile(r"sb_secret_[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{15,}")

# A reference to vault.decrypted_secrets (or a comment referencing it) is
# the sanctioned pattern — matching a secret shape is only a violation if
# it looks like a literal, not a lookup.
VAULT_LOOKUP = re.compile(r"vault\.decrypted_secrets", re.IGNORECASE)


def find_function_bodies(text: str):
    """Yield (start_offset, body_text) for each CREATE FUNCTION ... $$ ... $$ block."""
    for m in FUNCTION_START.finditer(text):
        tail = text[m.end():]
        dollar_match = re.search(r"\$(\w*)\$", tail)
        if not dollar_match:
            continue
        tag = dollar_match.group(0)
        body_start = dollar_match.end()
        end_idx = tail.find(tag, body_start)
        if end_idx == -1:
            continue
        yield m.start(), tail[body_start:end_idx]


def lint_file(path: Path):
    violations = []
    text = path.read_text(encoding="utf-8", errors="ignore")
    for offset, body in find_function_bodies(text):
        for sm in SECRET_SHAPE.finditer(body):
            literal = sm.group(0)
            line_no = text[: offset + sm.start()].count("\n") + 1
            violations.append((path, line_no, literal[:12] + "…"))
    return violations


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    args = parser.parse_args()

    root = Path(args.root)
    all_violations = []
    for scan_dir in SCAN_DIRS:
        d = root / scan_dir
        if not d.is_dir():
            continue
        for sql_file in sorted(d.rglob("*.sql")):
            all_violations.extend(lint_file(sql_file))

    if all_violations:
        print("FAIL — hardcoded secret-shaped literal(s) found in function body:")
        for path, line_no, snippet in all_violations:
            print(f"  {path}:{line_no}  {snippet}")
        print(
            "\nRead the secret from vault.decrypted_secrets at call time instead "
            "of hardcoding it in the function body. See GitHub #720/#770."
        )
        return 1

    print("schema-secret-lint: PASS — no hardcoded secret-shaped literals in public function bodies.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
