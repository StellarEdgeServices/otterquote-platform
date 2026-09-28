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

PR #2222 LEGAL-READ FAIL (comment 5849208388, L1): a task spec substituted a
non-approved fee sentence ("$200 flat referral fee on completed jobs of
$10,000+") for ins-3.html. This script's exclusive-floor patterns above did
not catch it, because "$10,000+" is not "over $10,000" -- the substitution
was inclusive-floor-correct but still wrong wording, dropping the $50 recruit
tier and changing the completion condition. `check_fee_sentence_pages()`
below closes that gap: for every page in D266_PAGES (tools/partner_parity_check
.py's referral-fee funnel-surface registry) that mentions a fee at all, the
Dustin-approved D-301/D-305 sentence (otterquote-ref-marketing.md, "the fee
sentence -- Dustin-approved, verbatim, not paraphrasable") must appear
verbatim (whitespace-normalized). A page can mention $10,000 without a fee
context (this script's own ALLOWLIST above exists for exactly that), so this
check only fires on pages that show fee-shaped language at all, and only
fails when the required sentence is absent from those.

Exit codes:
  0 -- no un-allowlisted violations and every fee-mentioning D266_PAGES page
       carries the approved sentence verbatim
  1 -- new/undocumented $10K exclusive-floor phrasing found, or a
       fee-mentioning page in D266_PAGES is missing the approved sentence
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools"))

SKIP_DIR_NAMES = {"node_modules", ".git", "__pycache__", "playwright-report", "test-results", ".next"}
SCAN_SUFFIXES = {".html", ".ts", ".tsx", ".js", ".mjs"}

# D-301/D-305 standard referral-fee sentence -- Dustin-approved verbatim,
# "APPROVED. DONE," not paraphrasable (otterquote-ref-marketing.md).
APPROVED_FEE_SENTENCE = (
    "$200 when a homeowner you refer completes a project of $10,000 or "
    "more. $50 on the same terms for referrals from partners you recruit."
)

# A page "mentions a fee" if it contains a dollar amount that is part of the
# referral-commission structure (D-139..D-143: $200 referral / $50 recruit)
# or the phrase "referral fee" itself. Broad on purpose -- the point is to
# catch every page that talks about the fee at all, not just ones already
# suspected of getting it wrong.
FEE_MENTION_RE = re.compile(r"referral fee|\$200|\$50\b", re.IGNORECASE)


def _norm_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text)


# The dedicated single-funnel landing pages (RE-1/INS-1 template family, plus
# the -3 wave-3 siblings this fix is for) are the surfaces that were BUILT to
# carry the D-301/D-305 sentence as its own standalone paragraph -- that is
# what PR #2150/#2151/#2222 actually shipped and what LEGAL-READ comment
# 5849208388 (L1) is about. Older, pre-existing pages in D266_PAGES
# (partner-re.html, partner-insurance.html, partners.html, FAQ copy, etc.)
# state the fee conversationally across hero/table/FAQ copy that predates the
# standard-sentence convention and was never migrated to it; sweeping the
# whole D266_PAGES set into this requirement would fail CI on all of them at
# once, which is a copy-migration decision for its own PR, not a side effect
# of this guard. So this check's page set is the subset of D266_PAGES that IS
# built to the standard-sentence convention -- verified as an actual subset
# of D266_PAGES (not a parallel, driftable list) below.
FEE_SENTENCE_PAGES = {"re-1", "ins-1", "re-3", "ins-3"}


def check_fee_sentence_pages() -> list[str]:
    """Every FEE_SENTENCE_PAGES page that mentions a fee must carry the
    approved D-301/D-305 sentence verbatim. Returns violation strings."""
    try:
        import partner_parity_check as ppc
    except ImportError:
        # tools/partner_parity_check.py not importable (e.g. run from an
        # unusual cwd) -- do not fail the whole script over an unrelated
        # import path issue; the floor-phrasing scan above still runs.
        return []

    violations = []
    # gh-2222 rebase (CEO RUN 72): tools/partner_parity_check.py's D266_PAGES
    # module-level constant was replaced by a compute_d266_pages() function
    # (a concurrent main-branch change, #2225/content-census refactor) while
    # this PR was in flight -- calling the function is now the only way to
    # get the current page set; the old `ppc.D266_PAGES` attribute no longer
    # exists on the module.
    unmapped = sorted(FEE_SENTENCE_PAGES - set(ppc.compute_d266_pages()))
    if unmapped:
        violations.append(
            "FEE_SENTENCE_PAGES has drifted out of D266_PAGES: "
            + ", ".join(unmapped)
            + " -- fix tools/partner_parity_check.py's compute_d266_pages() or this list"
        )

    norm_sentence = _norm_ws(APPROVED_FEE_SENTENCE)
    for stem in sorted(FEE_SENTENCE_PAGES):
        page = REPO / f"{stem}.html"
        if not page.is_file():
            continue
        try:
            html = page.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if not FEE_MENTION_RE.search(html):
            continue  # this page never mentions a fee -- nothing to require
        if norm_sentence not in _norm_ws(html):
            violations.append(
                f"{stem}.html: mentions a fee but does not carry the "
                f"D-301/D-305 approved sentence verbatim"
            )
    return violations

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

    fee_sentence_hits = check_fee_sentence_pages()

    if hits or fee_sentence_hits:
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
        if fee_sentence_hits:
            print("FAIL: D-301/D-305 approved fee sentence missing on a fee-mentioning page:")
            for h in fee_sentence_hits:
                print(f"  - {h}")
            print(
                "\nThe D-301/D-305 sentence is Dustin-approved verbatim and not "
                "paraphrasable (otterquote-ref-marketing.md). PR #2222 comment "
                "5849208388 (L1) is the precedent -- a task-spec paraphrase is a "
                "defect, not a style choice."
            )
        return 1

    print(f"PASS: check-10k-floor-phrasing: {files_scanned} files scanned, "
          f"0 violations ({len(ALLOWLIST)} allowlisted entries, D-286/gh-920); "
          f"D-301/D-305 fee sentence verified verbatim on every fee-mentioning D266_PAGES page.")
    return 0


# ── --self-test: planted fixtures for check_fee_sentence_pages() ──────────
def run_self_test() -> int:
    import tempfile

    results: list[str] = []
    failed = False

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal failed
        if cond:
            results.append(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
        else:
            failed = True
            results.append(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))

    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        (tmp / "tools").mkdir()
        # gh-2222 rebase (CEO RUN 72): the fixture module exposes
        # compute_d266_pages() (a function), matching main's post-refactor
        # API, not the old D266_PAGES module-level constant this fixture
        # used to define directly.
        (tmp / "tools" / "partner_parity_check.py").write_text(
            "def compute_d266_pages(root=None):\n"
            "    return {'re-1', 'ins-1', 're-3', 'ins-3', 'no-fee-page'}\n",
            encoding="utf-8",
        )

        # Positive control: exact approved sentence present alongside a fee
        # mention -- must NOT be flagged.
        (tmp / "re-3.html").write_text(
            "<p>Refer a homeowner. "
            "$200 when a homeowner you refer completes a project of $10,000 "
            "or more. $50 on the same terms for referrals from partners you "
            "recruit.</p>",
            encoding="utf-8",
        )

        # Negative control: this IS the PR #2222 defect -- a fee is
        # mentioned ($200, "referral fee") but the sentence is a
        # non-approved paraphrase. Must be flagged.
        (tmp / "ins-3.html").write_text(
            "<p>Earn a $200 flat referral fee on completed jobs of "
            "$10,000+</p>",
            encoding="utf-8",
        )

        # Page in D266_PAGES that never mentions a fee at all -- must NOT
        # be flagged (nothing to require).
        (tmp / "no-fee-page.html").write_text(
            "<p>Welcome, partner. No dollar amounts here.</p>", encoding="utf-8"
        )

        old_repo = globals()["REPO"]
        old_path = list(sys.path)
        try:
            globals()["REPO"] = tmp
            sys.path.insert(0, str(tmp / "tools"))
            sys.modules.pop("partner_parity_check", None)
            violations = check_fee_sentence_pages()
        finally:
            globals()["REPO"] = old_repo
            sys.path[:] = old_path
            sys.modules.pop("partner_parity_check", None)

        violated_stems = {v.split(".html")[0] for v in violations}
        check(
            "self-test:approved-sentence-verbatim-passes",
            "re-3" not in violated_stems,
            f"re-3.html carries the exact approved sentence and must not be flagged -- violations={violations}",
        )
        check(
            "self-test:non-approved-paraphrase-fails (negative control, PR #2222 L1)",
            "ins-3" in violated_stems,
            f"ins-3.html's paraphrase must be flagged -- violations={violations}",
        )
        check(
            "self-test:no-fee-mention-not-flagged",
            "no-fee-page" not in violated_stems,
            f"a page mentioning no fee at all must not be flagged -- violations={violations}",
        )

    for line in results:
        print(line)
    return 1 if failed else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        sys.exit(run_self_test())
    sys.exit(main())
