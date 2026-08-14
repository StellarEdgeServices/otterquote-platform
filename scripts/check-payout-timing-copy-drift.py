#!/usr/bin/env python3
"""
gh-832: payout-timing copy drift guard.

PR #812 (D-180-adjacent, Dustin-approved) dropped the unqualified "14 days"
commission-payout-timing promise from partner-inspectors.html,
partner-insurance.html, and partner-re.html -- "Commissions are paid after
job completion and approval — typically within 14 days of completion."
became "Commissions are paid after job completion and approval." The
narrower claim was replaced because it isn't one Otter Quotes can
guarantee (payout approval timing depends on the homeowner/contractor
payment cycle, not a fixed SLA).

That replacement has now drifted three times: it shipped on only 3 of 8
files that carried the sentence (gh-832 found it live on
partner-adjusters.html, partner-other.html, partner-dashboard.html,
refer-a-friend.html x2, and react-app/app/refer/copy.ts). This script is
the CI-side guard the gh-832 fix asked for -- it fails if the retired
phrasing (or its react-app equivalent) reappears anywhere in the tree,
so the next new partner/referral surface can't reintroduce it silently.

This is deliberately an exact-phrase check, not a generic "14 days" ban --
the bid-validity feature (D-150, contractor bids expire after 14 days,
unrelated to commission payouts) legitimately says "14 days" in several
places and must not be flagged.

Exit codes:
  0 -- no drift
  1 -- the retired phrasing has reappeared
"""
from __future__ import annotations
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

RETIRED_PHRASES = [
    "typically within 14 days of completion",
    "within 14 days after the referred job is completed",
]

SKIP_DIR_NAMES = {"node_modules", ".git", "__pycache__", "playwright-report", "test-results", ".next"}
SCAN_SUFFIXES = {".html", ".ts", ".tsx", ".js", ".mjs"}


def iter_candidate_files():
    for path in REPO.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix not in SCAN_SUFFIXES:
            continue
        if any(part in SKIP_DIR_NAMES for part in path.parts):
            continue
        yield path


def main() -> int:
    hits: list[str] = []
    for path in iter_candidate_files():
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for phrase in RETIRED_PHRASES:
            if phrase.lower() in text.lower():
                hits.append(f"{path.relative_to(REPO)}: contains retired phrase \"{phrase}\"")

    if hits:
        print("FAIL: retired payout-timing copy has reappeared (gh-832 drift guard):")
        for h in hits:
            print(f"  - {h}")
        print(
            "\nPR #812 replaced this unqualified 14-day promise with "
            '"Commissions are paid after job completion and approval." '
            "(or the react-app equivalent without the day count). "
            "Use that wording instead of re-adding a fixed-day claim."
        )
        return 1

    print("PASS: no retired payout-timing phrasing found (gh-832).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
