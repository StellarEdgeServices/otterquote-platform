#!/usr/bin/env python3
"""
gh-832 / gh-850: payout-timing copy drift guard.

v1 (gh-832) matched two literal retired phrases -- exactly the two strings
that PR #812 had just deleted. It could prove those two strings were gone
and nothing else. gh-850 found two live survivors expressed in different
units ("five business days", "1-3 business days") that the exact-phrase
match structurally could not see, one of them in a transactional email
that told a partner money was "now processing" for a payout with no
disbursement mechanism (approve-payout has no Stripe/ACH send step; see
#767 -- W-9 collection isn't even live for the 9 existing agents).

v2 matches the CLASS instead of two instances: any sentence/string that is
commission- or payout-adjacent (mentions "commission", "payout", or
"disburs*") AND contains a day/week duration. Two things keep this from
being a blunt instrument:

1. The keyword gate. A duration alone is common and mostly unrelated --
   contractor approval times, Hover refund windows, CCPA response times,
   D-150 bid-validity windows -- so only sentences that are ALSO
   commission/payout-adjacent are flagged. D-150's "14-day window" text
   never mentions commission/payout and is excluded by the gate itself,
   not by a special-case exemption.

2. An explicit, reasoned ALLOWLIST for the categories of duration
   claim that are legitimate here: (a) how long the *approval decision*
   takes ("commission is pending approval, typically 5 business days") --
   a claim about an internal review step, not about money movement, and
   consistent across contractor-agreement.html and the partner dashboard
   copy; (b) internal admin-facing statements of the system's own actual
   behavior (process-payout-reminders' reminder/auto-approve thresholds --
   these describe what the code does, they are not promises made to a
   partner). Each entry states which category and why. Anything not on
   the allowlist fails.

   A third category was added 2026-08-15 (gh-892 follow-on): (c) durations
   that are not about money at all and only collide with the keyword filter
   because a contract section enumerating "material changes" happens to name
   the commission structure on the same line. See the partner-agreement.html
   Section 17 entry. Keep this category narrow -- it exists for
   keyword-proximity false positives, not for softening a real payout claim.

   gh-850 Survivor A (react-app/app/refer/copy.ts's Tier-3 D-180
   disclosure) was carried here as known, tracked debt until Dustin's
   ~09:00 ET 2026-08-14 GO to strike payout timing everywhere -- fixed the
   same session (code-lane item 5), allowlist entry removed since the
   duration claim no longer exists in the string.

Exit codes:
  0 -- no unallowlisted commission/payout duration claims found
  1 -- new/undocumented drift found
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

SKIP_DIR_NAMES = {"node_modules", ".git", "__pycache__", "playwright-report", "test-results", ".next"}
SCAN_SUFFIXES = {".html", ".ts", ".tsx", ".js", ".mjs"}

COMMISSION_KEYWORDS = re.compile(r"commission|payout|disburs", re.IGNORECASE)

# Digit durations ("5 business days", "1-3 business days", "14 days", "2 weeks")
# and the spelled-out numbers actually used in this codebase's copy.
DURATION_RE = re.compile(
    r"""
    (?:\d+\s*(?:[-–]\s*\d+\s*)?
       |zero|one|two|three|four|five|six|seven|eight|nine|ten|
        eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty[- ]five
    )
    \s*(?:\(\d+\)\s*)?
    (?:business\s+)?(?:day|days|week|weeks)\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# (relative path, exact substring to match, category, reason)
ALLOWLIST = [
    (
        "partner-agreement.html",
        "notify Partner of material changes by email or through Partner",
        "agreement-modification notice period",
        "Section 17's 30-day notice period before an Agreement change takes "
        "effect. Not a disbursement claim at all -- it says how much warning "
        "Partner gets before terms change, which is entirely within Otter "
        "Quotes' control and therefore keepable. It trips the scanner only "
        "because the same sentence enumerates which changes are material and "
        "names 'the commission structure in Section 4', putting the keyword "
        "and an unrelated duration on one line. Distinct from the two payout "
        "categories below: those constrain claims about money movement, this "
        "constrains nothing about money at all.",
    ),
    (
        "contractor-agreement.html",
        "typically approved and processed within five (5) business days",
        "approval-step timing",
        "States how long the internal approval DECISION takes, not a promise "
        "about when money moves -- consistent with the partner-dashboard "
        "'pending approval' copy below.",
    ),
    (
        "react-app/app/partner/dashboard/copy.ts",
        "Your commission is pending approval — typically within 5 business days",
        "approval-step timing",
        "Same category as contractor-agreement.html above: says 'pending "
        "approval', not 'processing' or 'expect to receive' -- an approval-"
        "decision timeline, not a disbursement promise.",
    ),
    (
        "react-app/app/partner/dashboard/copy.ts",
        "Pending — typically 5 days",
        "approval-step timing",
        "Short-label twin of the title string immediately above -- same "
        "approval-decision timeline, not a disbursement promise.",
    ),
    (
        "react-app/app/partner/dashboard/__tests__/dashboard.test.ts",
        "Your commission is pending approval — typically within 5 business days",
        "approval-step timing",
        "Test pin of the copy.ts title string above.",
    ),
    (
        "react-app/app/partner/dashboard/__tests__/dashboard.test.ts",
        "Pending — typically 5 days",
        "approval-step timing",
        "Test pin of the copy.ts label string above.",
    ),
    (
        "supabase/functions/process-payout-reminders/index.ts",
        "commissions have been pending for more than 2 days",
        "internal admin behavior",
        "Admin-only reminder email describing the reminder job's own actual "
        "threshold, not a promise made to a partner.",
    ),
    (
        "supabase/functions/process-payout-reminders/index.ts",
        "commission(s) awaiting approval (>2 days pending)",
        "internal admin behavior",
        "Same reminder email, same threshold, second mention.",
    ),
    (
        "supabase/functions/process-payout-reminders/index.ts",
        "were automatically approved after 7 days with no action",
        "internal admin behavior",
        "Describes the auto-approve job's real behavior (a fact about what "
        "the code does), not a claim made to a partner about payout timing.",
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
    for allow_path, allow_substr, _category, _reason in ALLOWLIST:
        if rel_path == allow_path and allow_substr.lower() in line.lower():
            return True
    return False


def main() -> int:
    hits: list[str] = []
    for path in iter_candidate_files():
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        rel_path = str(path.relative_to(REPO)).replace("\\", "/")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if not COMMISSION_KEYWORDS.search(line):
                continue
            if not DURATION_RE.search(line):
                continue
            if is_allowlisted(rel_path, line):
                continue
            hits.append(f"{rel_path}:{lineno}: {line.strip()[:160]}")

    if hits:
        print("FAIL: commission/payout copy with an un-allowlisted duration claim (gh-832/gh-850):")
        for h in hits:
            print(f"  - {h}")
        print(
            "\nEvery hit must be either (a) fixed so it doesn't claim a "
            "disbursement timeline the system can't back, or (b) added to "
            "ALLOWLIST in this script with a stated category and reason -- "
            "see the two categories already documented there."
        )
        return 1

    print(f"PASS: no un-allowlisted commission/payout duration claims found "
          f"({len(ALLOWLIST)} allowlisted entries, gh-832/gh-850).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
