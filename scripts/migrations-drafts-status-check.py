#!/usr/bin/env python3
"""
migrations-drafts-status-check.py -- gh-1438(a): every file in
supabase/migrations_drafts/ must carry a STATUS header, and the directory must
carry a README.md stating the directory rule.

WHY THIS EXISTS
---------------
Issue #1438 found that supabase/migrations_drafts/ was not a drafts directory:
7 of 9 testable sets were live in production while the directory name said
"not applied". A file in that directory says nothing about whether production
has it. The fix is a per-file STATUS header (APPLIED / NOT APPLIED /
UNVERIFIED) that names its evidence and any repo copy, and a README that states
the rule for which directory a migration lives in once it is applied.

WHAT IT CHECKS (structure only)
-------------------------------
For every file under supabase/migrations_drafts/ other than README.md, within
the first 12 lines:
  - a `STATUS (gh-1438, as of <date>): APPLIED|NOT APPLIED|UNVERIFIED` line
  - an `EVIDENCE:` line
  - a `REPO COPY:` line
  - a `DO NOT RUN FROM THIS DIRECTORY` line
and that supabase/migrations_drafts/README.md exists.

WHAT IT DOES NOT CHECK
----------------------
Whether a header's claim is TRUE. That needs a live query against the
database (supabase_migrations.schema_migrations / pg_catalog), which CI does
not have. This is a presence check, not a truth check. The truth check is the
close-time live query described on #1438.

NOT WIRED INTO REQUIRED CI. Run: python3 scripts/migrations-drafts-status-check.py [--root .]

Exit codes: 0 = every file headed and README present; 1 = one or more violations.
"""

import argparse
import os
import re
import sys

DRAFTS_DIR = "supabase/migrations_drafts"
README = "README.md"
HEAD_LINES = 12

STATUS_RE = re.compile(
    r"STATUS \(gh-1438, as of [^)]+\):\s*(APPLIED|NOT APPLIED|UNVERIFIED)\b"
)
REQUIRED = (
    ("STATUS line", STATUS_RE),
    ("EVIDENCE line", re.compile(r"\bEVIDENCE:")),
    ("REPO COPY line", re.compile(r"\bREPO COPY:")),
    ("DO NOT RUN line", re.compile(r"DO NOT RUN FROM THIS DIRECTORY")),
)


def check(root: str):
    """Return (files_scanned, [violation strings])."""
    d = os.path.join(root, DRAFTS_DIR)
    violations = []
    scanned = 0
    if not os.path.isdir(d):
        return 0, [f"{DRAFTS_DIR} not found under {root}"]
    if not os.path.isfile(os.path.join(d, README)):
        violations.append(f"{DRAFTS_DIR}/{README} is missing (the directory rule must be stated there)")
    for name in sorted(os.listdir(d)):
        if name == README:
            continue
        path = os.path.join(d, name)
        if not os.path.isfile(path):
            continue
        scanned += 1
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = [next(fh, "") for _ in range(HEAD_LINES)]
        text = "".join(head)
        for label, rx in REQUIRED:
            if not rx.search(text):
                violations.append(f"{DRAFTS_DIR}/{name}: no {label} in the first {HEAD_LINES} lines")
    return scanned, violations


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".", help="Repository root (default: cwd)")
    args = ap.parse_args()
    scanned, violations = check(os.path.abspath(args.root))
    for v in violations:
        print(f"FAIL  {v}")
    print("-" * 60)
    print(f"Scanned {scanned} file(s) in {DRAFTS_DIR}/ | {len(violations)} violation(s)")
    if violations:
        print("Migrations-drafts STATUS check FAILED.")
        return 1
    print("Migrations-drafts STATUS check PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
