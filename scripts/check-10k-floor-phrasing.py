#!/usr/bin/env python3
"""
gh-920 / D-286: $10,000 commission-floor phrasing guard.

D-286 (2026-08-14) locked the wording: "$10,000 or more" is correct;
"over $10,000", "over $10K", ">$10K", and "$10,000 or less" are struck.
The trigger (sql/v40-commission-trigger.sql, apply_referral_commission)
fires on `total_price >= 10000` -- inclusive, and always was. The bug
class this guards against is a contract/copy surface saying "over"
(exclusive) while the code pays inclusively -- a signed-agreement
defect, not a rounding one.

D-286 was applied once and verified only against `Claude's Memories/` --
the grep that certified it never touched the repo, so the customer- and
partner-facing half of the fix was silently never done. gh-920 found 5
of 5 checked surfaces still wrong and fixed 13 files (11 static HTML +
2 react-app copy/test files, 46 occurrences). This script exists so the
next reintroduction is a CI failure on the introducing PR, not a fourth
manual re-discovery -- this item is row 2 of `In Flight/recurrence-ledger.md`
at 4+ recurrences before this fix.

Patterns (case-insensitive), matching gh-920's AC3 verbatim:
  1. "over $10,000" / "over $10000"
  2. "over $10K"
  3. "$10,000 or less" / "$10000 or less"
  4. "<value> > $10,000" / "<value> > $10K" -- the symbolic exclusive form.
     Restricted to a ">" preceded by whitespace so it matches prose/code
     comparisons ("job_value > $10,000") without also matching every HTML
     tag boundary immediately before a price string (e.g. `>$10</span>`,
     which is `"` or `>` immediately before the `$`, never a space).

Two categories of match are real but out of scope, and are ALLOWLISTed
rather than special-cased inline (same convention as
check-payout-timing-copy-drift.py):
  (a) an unrelated dollar threshold that happens to also be exactly
      $10,000 (SPENDING-CONTROLS.md's Stripe payment-intent safety cap --
      nothing to do with the commission floor);
  (b) comment strings inside already-applied, superseded migration files
      (sql/v7-referral-system.sql, sql/v36-recruit-system.sql) -- gh-920's
      own text says "do not touch the SQL"; editing historical migration
      comments rewrites a point-in-time record rather than fixing live
      behavior, and the operative trigger (v40) is already correct and
      already covered by this scanner for any *new* SQL.

Exit codes:
  0 -- no un-allowlisted violations
  1 -- new/undocumented $10K exclusive-floor phrasing found
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

SKIP_DIR_NAMES = {"node_modules", ".git", "__pycache__", "playwright-report", "test-results", ".next"}
SCAN_SUFFIXES = {".html", ".ts", ".tsx", ".js", ".mjs"}

PATTERNS = [
    re.compile(r"over\s+\$10,?0{3}\b", re.IGNORECASE),
    re.compile(r"over\s+\$10k\b", re.IGNORECASE),
    re.compile(r"\$10,?0{3}\s*or less\b", re.IGNORECASE),
    re.compile(r"(?<=\s)>\s*\$10,?0{3}\b", re.IGNORECASE),
    re.compile(r"(?<=\s)>\s*\$10k\b", re.IGNORECASE),
]

# (relative path, exact substring to match, reason)
ALLOWLIST = [
    (
        "SPENDING-CONTROLS.md",
        "Stripe amount cap: Refuses any single payment intent over $10,000",
        "Unrelated $10,000 threshold -- the Stripe payment-intent safety cap, "
        "not the D-286 commission floor. Coincidentally the same number.",
    ),
    (
        "sql/v7-referral-system.sql",
        "$250 if job_value > $10,000; $0 otherwise",
        "Comment in a superseded, already-applied migration. The operative "
        "trigger is v40 (inclusive, >=10000, already correct). gh-920: "
        "'Correct the contract to the code. Do not touch the code.'",
    ),
    (
        "sql/v36-recruit-system.sql",
        "over $10K, the recruiter earns $50 and the referrer earns $200",
        "Comment in a superseded, already-applied migration -- see v7 entry above.",
    ),
    (
        "sql/v36-recruit-system.sql",
        "job_value > $10,000). Separate from total_commission_earned",
        "Comment in a superseded, already-applied migration -- see v7 entry above.",
    ),
    (
        "sql/v36-recruit-system.sql",
        "recruited_by_id and (2) job_value > $10,000. Otherwise stays at 0.",
        "Comment in a superseded, already-applied migration -- see v7 entry above.",
    ),
    (
        "sql/v36-recruit-system.sql",
        "recruited (recruited_by_id IS NOT NULL) and job_value > $10,000",
        "Comment in a superseded, already-applied migration -- see v7 entry above.",
    ),
]


def iter_candidate_files():
    for path in REPO.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in SCAN_SUFFIXES:
            continue
        if any(part in SKIP_DIR_NAMES for part in path.parts):
            continue
        yield path


def is_allowlisted(rel_path: str, line: str) -> bool:
    for allow_path, allow_substr, _reason in ALLOWLIST:
        if rel_path == allow_path and allow_substr.lower() in line.lower():
            return True
    return False


def main() -> int:
    hits: list[str] = []
    files_scanned = 0
    for path in iter_candidate_files():
        files_scanned += 1
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel_path = str(path.relative_to(REPO)).replace("\\", "/")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if not any(p.search(line) for p in PATTERNS):
                continue
            if is_allowlisted(rel_path, line):
                continue
            hits.append(f"{rel_path}:{lineno}: {line.strip()[:160]}")

    if hits:
        print("FAIL: exclusive $10,000 commission-floor phrasing found (D-286/gh-920):")
        for h in hits:
            print(f"  - {h}")
        print(
            "\nD-286 locked the wording as '$10,000 or more' (inclusive) -- matching "
            "sql/v40-commission-trigger.sql's `total_price >= 10000`. Every hit must be "
            "either (a) reworded to the inclusive form, or (b) added to ALLOWLIST in "
            "this script with a stated reason if it is genuinely unrelated or historical."
        )
        return 1

    print(f"PASS: check-10k-floor-phrasing: {files_scanned} files scanned, "
          f"0 violations ({len(ALLOWLIST)} allowlisted entries, D-286/gh-920).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
