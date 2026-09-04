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

gh-1617 pass 2 closed the bare-"licensed" class the first pass did not reach:
"licensed contractors" with no "insured" beside it, on 74 lines. The most
expensive were index.html's <meta name="description"> and og:description -- the
text Google renders under the homepage result -- plus how-it-works.html's three
meta tags and its JSON-LD HowTo description. 23 lines across 12 files were
reworded; the remaining 51 are consumer advice and stayed (see below).

Pass 2 also removed an affirmative verification PROMISE, which is worse than the
marketing copy because it is a first-person statement to a contractor in a
transactional email about what we do:
send-welcome-email/index.ts told every applicant "We verify your contractor
license(s) for each trade and municipality." We do not. D-217 (v77/v78) removed
the license requirement outright: v77 constrains contractors.license_path to
NULL or 'not_provided' -- there is no third value -- and v78 backfilled every
row to 'not_provided', so contractor_has_required_docs()'s license limb
(`EXISTS(contractor_licenses) OR license_path = 'not_provided'`) is satisfied
unconditionally. license_verified/insurance_verified are admin-only columns
(frozen against end-user writes by contractors_freeze_privileged_columns), and 1
of 8 active contractors carries each. What actually happens at that step is that
the contractor supplies license information and attests to it under the IC
24-5-11 attestation in contractor-pre-approval.html. The email now says so.
The two siblings found by the same grep -- the COI half of the same email, and
contractor-how-it-works.html's "We review your profile to confirm licensing and
insurance are in order" -- were reworded the same way.

Patterns (case-insensitive):
  1. "licensed, insured" / "licensed and insured" -- the noun-phrase form.
  2. "vetted / pre-screened / screened / background-checked / verified
     contractors" -- the screening-claim form.
  3. "<contractors|professionals|roofers|bidders> [on <surface>] are|is
     [all|fully] licensed|insured|vetted|screened|verified" -- the predicate
     form, which is how the claim gets reintroduced once the noun phrase is
     gone.
  4. the bare-"licensed" ROSTER forms (pass 2). Scoped to the shape in which
     "licensed <contractor|professional|roofer>" is OUR representation about who
     bids through us, NOT to the bare phrase, because the bare phrase is also
     how legitimate consumer advice is written and ~45 such lines remain in the
     repo on purpose. Deliberately five narrow patterns rather than one broad
     one plus a 45-entry allowlist: an allowlist that long stops being read, and
     the broad form would pressure a future author to weaken good advice ("ask
     to see their license") just to quiet the scanner. The five:
       4a. "<quotes|bids> from [up to 3 words] licensed contractors" -- the
           supply claim ("competing quotes from licensed contractors").
       4b. "licensed contractors ... <bid on|submit|compete|in your area|on your
           job|for your project>" -- the predicate claim.
       4c. "<connects|delivers|matches|puts|priced by> ... licensed contractors"
           -- the intermediation claim.
       4d. a standalone element whose whole text is "Licensed Local Contractors"
           -- the trust-badge form, which carries no sentence to key on.
       4e. "is a licensed contractor" -- the generated-bio form
           (contractor-about.html wrote this for any contractor who left
           about_us blank, making it OtterQuote's assertion, not theirs).
  5. the VERIFICATION PROMISE: "we|Otter Quotes ... <verify|confirm|validate|
     vet|screen|check> ... <licen*|insur*|coverage minimum|credential|
     background>" within one sentence. Negations are excluded from the gap, so
     the honest disclaimer this fix introduced ("We do not independently verify
     it") does not trip the scanner that required it.

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
      statements are true, useful, and make no claim about our roster. Copy
      that tells the homeowner to check credentials THEMSELVES is the reason
      this category exists: deleting it would make the site worse, not more
      honest, so it is allowlisted rather than reworded.
  (d) a verification we genuinely perform or genuinely reserve -- the COI
      confirmation email an admin actually sends to a contractor's broker, and
      the contract clause that reserves the right to verify without promising
      that we routinely do.

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

# Credential nouns the roster claims attach to (pass-2 patterns 4a-4c).
_CRED = r"(?:contractors?|professionals?|roofers?)"

# One non-sentence-ending character that is not part of a negation. Used as the
# gap in pattern 5 so "We do not independently verify it" cannot match while
# "We review your profile to confirm licensing ... " still does.
_NO_NEG = r"(?:(?!\bnot\b|n't|\bnever\b|\bcannot\b|\bdon\b)[^.])"

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
    # -- pass 2: the bare-"licensed" roster forms (4a-4e) --
    # 4a: the supply claim -- "competing quotes/bids from licensed contractors".
    re.compile(
        r"(?:quotes?|bids?)\s+from\s+(?:\w+\s+){0,3}"
        r"licensed\s+(?:local\s+)?" + _CRED,
        re.IGNORECASE,
    ),
    # 4b: the predicate claim -- licensed contractors doing something for us.
    re.compile(
        r"\blicensed\s+(?:local\s+|roofing\s+(?:and\s+exterior\s+)?)?" + _CRED +
        r"\b[^.]{0,70}?\b(?:bid on|submit|compet|in your area|on your job|"
        r"on the platform|for your (?:project|job))",
        re.IGNORECASE,
    ),
    # 4c: the intermediation claim -- we connect/deliver/price via them.
    re.compile(
        r"\b(?:connects?|connecting|delivers?|matches?|puts?|priced\s+by|"
        r"sourced\s+from)\b[^.]{0,70}?"
        r"\blicensed\s+(?:local\s+|roofing\s+(?:and\s+exterior\s+)?)?" + _CRED,
        re.IGNORECASE,
    ),
    # 4d: the trust-badge form -- an element whose entire text is the claim.
    re.compile(r">\s*Licensed\s+(?:Local\s+|Roofing\s+)?Contractors?\s*<", re.IGNORECASE),
    # 4e: the generated-bio form -- we assert it on the contractor's behalf.
    re.compile(r"\bis\s+a\s+licensed\s+(?:local\s+)?contractor\b", re.IGNORECASE),
    # 5: the first-person verification promise. _NO_NEG keeps negations out of
    #    the gap so an honest "we do not verify" disclaimer never trips this.
    re.compile(
        r"\b(?:we|otter\s*quotes?)\b" + _NO_NEG + r"{0,45}?"
        r"\b(?:verif(?:y|ies)|confirms?|validates?|vets?|screens?|checks?)\b"
        r"[^.]{0,80}?"
        r"(?:licen[cs]|insur|coverage\s+minimum|credential|background)",
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
    # ---- gh-1617 pass 2: the four lines the new patterns 4a/4b/4c/5 match
    # ---- that are legitimate. Everything else pass 2 matched was reworded.
    (
        "guides/how-to-file-property-damage-claim.html",
        "Having competing bids from multiple licensed contractors serves two purposes",
        "Consumer advice, not a supply claim: the paragraph directly under "
        "'Use licensed, insured, local contractors' tells the homeowner why to "
        "collect competing bids from whoever they hire. The sibling clause in "
        "the same line ('the bids you're receiving from licensed contractors') "
        "has the same homeowner subject. The OtterQuote CTA 12 lines below it "
        "is the line pass 2 reworded.",
    ),
    (
        "guides/how-to-negotiate-with-insurer.html",
        "If multiple licensed contractors in your area cannot complete the work within the adjuster's pricing",
        "Body prose making a market-pricing argument -- if nobody can do the job "
        "for the adjuster's number, the estimate is low. Says nothing about who "
        "bids through us; the two CTA boxes on the same page that did were "
        "reworded.",
    ),
    (
        "contractor-agreement.html",
        "Otter Quotes reserves the right to verify all licenses, insurance, and credentials at any time",
        "A RESERVED RIGHT, not a promise -- 'reserves the right to' is the "
        "opposite of an assertion that we routinely do it, and the clause is "
        "what lets us suspend a contractor whose credentials lapse. Removing it "
        "would cost us the enforcement hook and buy no honesty.",
    ),
    (
        "supabase/functions/admin-contractor-action/index.ts",
        "We are writing to verify the Certificate of Insurance on file for",
        "A verification we actually perform: the body of the COI confirmation "
        "email an admin sends to the contractor's broker, which stamps "
        "insurance_verification_sent_at on the row. First person is accurate "
        "here because the action is happening as the sentence is sent. That it "
        "is admin-triggered per contractor -- not automatic at signup -- is "
        "also why the welcome email no longer promises it to everyone. "
        "(Matches on two lines: plain-text and HTML halves of the same email.)",
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
            "license_path='not_provided' -- a value D-217/v77 constrains to NULL or "
            "'not_provided', so the license limb of the doc gate is satisfied "
            "unconditionally. Every hit must be either (a) reworded to drop the "
            "credential claim -- say what the platform actually does (contractors "
            "compete for the project; the contractor supplies and attests to their own "
            "license information; the homeowner confirms credentials before hiring) -- "
            "or (b) added to ALLOWLIST in this script with a stated reason if it is a "
            "disclaimer, contractor speech, generic consumer advice, or a verification "
            "we genuinely perform.\n"
            "Do NOT satisfy this scanner by deleting copy that tells the homeowner to "
            "check credentials themselves. That copy is the point; allowlist it."
        )
        return 1

    print(f"PASS: check-credential-claims: {files_scanned} files scanned, "
          f"0 violations ({len(ALLOWLIST)} allowlisted entries, D-104/gh-1617).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
