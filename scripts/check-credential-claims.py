#!/usr/bin/env python3
"""
gh-1617 / D-104: contractor credential-claim guard.

D-104 bars OtterQuote from making screening or credential claims about the
contractors on the marketplace. The site made them anyway: the phrase
"licensed, insured contractors" (and the "licensed and insured" variant)
appeared on 94 lines across 35 files -- homepage, landing page, how-it-works,
llms.txt, the referral and partner surfaces, the one-pagers, and 16 blog and
guide articles.

Our own gate supports neither half of the claim. Of the 8 contractors at
status='active', exactly 1 carries license_verified=true and exactly 1 carries
insurance_verified=true; 7 of the 8 carry license_path='not_provided'. There is
no screening step behind the word "licensed" and no coverage check behind the
word "insured" -- the copy asserted a gate the platform does not run.

gh-1617 removed the claim from 83 lines across 31 files (81 "licensed, insured"
occurrences plus 2 "vetted contractors" claims on partner-dashboard.html, the
same D-104 defect in different words). This script exists so the next
reintroduction fails CI on the introducing PR rather than being re-discovered
by hand.

A special sub-case worth naming, because it is the trap this guard is really
for: otterquote-deploy/blog/roofing-estimate-red-flags.html used to satisfy
D-104's letter by writing "the contractors competing for your project are
licensed and insured -- never described as 'vetted' or 'approved' by us." It
disclaimed the weaker word while asserting the stronger claim, and advertised
the compliance. Pattern 3 below catches that shape ("contractors ... are
licensed"), not just the fixed noun phrase.

Patterns (case-insensitive):
  1. "licensed, insured" / "licensed and insured" -- the noun-phrase form.
  2. "vetted / pre-screened / screened / background-checked / verified
     contractors" -- the screening-claim form.
  3. "<contractors|professionals|roofers|bidders> [on <surface>] are|is
     [all|fully] licensed|insured|vetted|screened|verified" -- the predicate
     form, which is how the claim gets reintroduced once the noun phrase is
     gone.

Three categories of match are legitimate and are ALLOWLISTed rather than
special-cased inline (same convention as check-10k-floor-phrasing.py and
check-payout-timing-copy-drift.py):
  (a) our DISCLAIMER of the position -- contractor-settings.html and
      react-app/app/contractor/settings/copy.ts say each contractor represents
      *itself* as licensed and insured. Removing that sentence would create the
      opposite defect: it is the text that tells the reader we do not vouch.
  (b) a contractor's own editable self-description or its placeholder --
      contractor-profile.html. That is the contractor's speech, not ours.
  (c) generic consumer advice where the subject is the HOMEOWNER's right or
      duty, not a representation about who is on our platform ("you have the
      right to choose any licensed, insured contractor", "use licensed,
      insured contractors who provide complete documentation"). Those
      statements are true, useful, and make no claim about our roster.

Compliance guards, generators and tests are skipped wholesale (see SKIP_DIR_NAMES
and SKIP_FILE_MARKERS) -- a rule or an assertion has to be able to quote the
barred string.

Exit codes:
  0 -- no un-allowlisted violations
  1 -- new/undocumented contractor credential or screening claim found
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

SKIP_DIR_NAMES = {
    "node_modules", ".git", "__pycache__", "playwright-report", "test-results",
    ".next", "__tests__", "skills-for-code", "tools",
}
SKIP_FILE_MARKERS = (".test.", ".spec.")
SCAN_SUFFIXES = {".html", ".ts", ".tsx", ".js", ".mjs", ".txt"}

PATTERNS = [
    re.compile(r"licensed,?\s+(?:and\s+)?insured", re.IGNORECASE),
    re.compile(
        r"\b(?:vetted|pre[- ]?screened|screened|background[- ]checked|"
        r"credential[- ]verified|license[- ]verified)\s+"
        r"(?:local\s+|roofing\s+)?contractors?\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:contractors?|professionals?|roofers?|bidders?)\s+"
        r"(?:on\s+[^.]{0,40}?\s+)?(?:are|is)\s+(?:all\s+|fully\s+)?"
        r"(?:licensed|insured|vetted|screened|verified|background[- ]checked)\b",
        re.IGNORECASE,
    ),
]

# (relative path, exact substring to match, reason)
ALLOWLIST = [
    (
        "contractor-settings.html",
        "Every contractor represents themselves &mdash; directly &mdash; as licensed, insured, and compliant with applicable law",
        "Our DISCLAIMER, not our claim -- it says the contractor represents itself. "
        "Deleting it would create the opposite D-104 defect.",
    ),
    (
        "react-app/app/contractor/settings/copy.ts",
        "Every contractor represents themselves — directly — as licensed, insured, and compliant with applicable law",
        "React twin of the contractor-settings.html disclaimer above -- same reason.",
    ),
    (
        "contractor-profile.html",
        "Licensed, insured, and dedicated to the highest standards in workmanship",
        "The contractor's own editable 'why choose us' self-description and its "
        "placeholder default. Contractor speech, not an OtterQuote representation.",
    ),
    (
        "blog/what-to-do-after-storm-damages-roof.html",
        "You have the right to choose any licensed, insured contractor",
        "Consumer advice about the HOMEOWNER's right against carrier steering. "
        "True, and says nothing about who is on our platform. (Prose + JSON-LD twin.)",
    ),
    (
        "otterquote-deploy/blog/does-homeowners-insurance-cover-roof-damage.html",
        "You can hire any licensed, insured contractor you choose",
        "Consumer advice about the homeowner's right to pick any contractor; the "
        "same paragraph says using OtterQuote is optional.",
    ),
    (
        "otterquote-deploy/blog/what-is-recoverable-depreciation-roofing.html",
        "Use licensed, insured contractors who provide complete documentation",
        "Consumer advice on what the homeowner should require of whoever they hire, "
        "in a list of claim-payout mistakes. No platform subject.",
    ),
    (
        "otterquote-deploy/blog/why-roofers-quote-different-prices.html",
        "A properly licensed, insured contractor carries general liability and workers' comp",
        "Explains an industry cost structure (why an uninsured operator bids lower). "
        "Generic, and makes no claim about our roster.",
    ),
    (
        "guides/how-to-file-property-damage-claim.html",
        "Use licensed, insured, local contractors.",
        "Consumer advice -- the sentence itself tells the homeowner to verify the "
        "license and demand a COI before work begins.",
    ),
    (
        "guides/how-to-file-property-damage-claim.html",
        "Select a licensed, insured local contractor and get the work done",
        "JSON-LD HowTo step name for the consumer-advice section allowlisted above; "
        "kept in sync with the visible copy deliberately.",
    ),
    (
        "guides/how-to-choose-contractor.html",
        "A licensed, insured contractor should also be a registered business entity",
        "Consumer advice on how the homeowner should evaluate any contractor.",
    ),
    (
        "guides/how-to-choose-contractor.html",
        "confirm that the subcontractors are also licensed and insured",
        "Consumer advice on what to ask a GC about its subs.",
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
        if any(marker in path.name for marker in SKIP_FILE_MARKERS):
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
        print("FAIL: contractor credential/screening claim found (D-104/gh-1617):")
        for h in hits:
            print(f"  - {h}")
        print(
            "\nD-104 bars screening and credential claims about the contractors on the "
            "marketplace, and the data does not support one: of 8 active contractors, 1 "
            "has license_verified=true, 1 has insurance_verified=true, and 7 have "
            "license_path='not_provided'. Every hit must be either (a) reworded to drop "
            "the credential claim -- say what the platform actually does (contractors "
            "compete for the project; the homeowner confirms credentials before hiring) "
            "-- or (b) added to ALLOWLIST in this script with a stated reason if it is a "
            "disclaimer, contractor speech, or generic consumer advice."
        )
        return 1

    print(f"PASS: check-credential-claims: {files_scanned} files scanned, "
          f"0 violations ({len(ALLOWLIST)} allowlisted entries, D-104/gh-1617).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
