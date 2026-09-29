#!/usr/bin/env python3
"""gh-2155 HI-0c (Ben ruling, #2152 comment 5836510515).

Generates `partner-agreement-inspector.html` from `partner-agreement.html` by
REMOVING, at build time, the same content that the live agreement already
hides from the home_inspector track via CSS (`#track-home-inspector:target`)
and the `?track=home_inspector` JS fallback -- i.e. every element already
marked `class="inspector-hide"` in the source:

  1. The Section 4 fee-structure block (`#feeStructureBlock`): the intro
     paragraph, the $200/$50 commission table, and the $10,000-Floor
     paragraph.
  2. Section 4.1 (Single-Level Recruiting / Forward-Only Accrual) -- the
     Recruit Bonus accrual rules, moot for a track that earns no Recruit
     Bonus.
  3. All of Section 7 (Licensing and Employment Compliance Disclaimer),
     heading included -- the D-266 "lawful to accept referral fees" warning
     and the represents-and-warrants paragraph, both conditioned on accepting
     a fee inspectors never accept.
  4. The Section 14(a) cross-reference span pointing back at "the
     representation in Section 7".
  5. (gh-2155 HI-0d, D-333, Ben ruling on PR #2312) Everything in Section 4
     except the 4.3 "Home Inspector Partners" statement: the "4. Referral Fee
     Structure" heading and the 4.2 Payment Timing paragraph are dropped, and
     the section is re-headed "4. No Referral Fee or Recruit Bonus". The 4.3
     statement itself is copied byte-for-byte from the source. The source
     partner-agreement.html (the fee-earning partners' agreement) is NOT
     edited.

  6. (gh-2155 HI-0e, D-333, Ben ruling 5882085491 on #2155, "STRIP IT.")
     The fee-payment mechanics, removal only, no new words, no renumbering:
       - all of Section 5 (Payment Method; Payment Information), heading
         included -- every sentence in it describes paying a fee or bonus;
       - all of Section 10 (Commission Reversal), heading included;
       - the Section 9 sentence "Commissions and bonuses are earned only on
         jobs ..." (calculation of a commission; the attribution sentences
         that follow it are kept);
       - the Section 11 cross-reference "10 (Commission Reversal), " (it
         points at the dropped Section 10);
       - the phrase "commission terms" from the meta description, og
         description and the top-of-page notice.
     A sentence that mixes a payment element with a non-payment obligation
     (Sections 8, 11, 13, 17) is KEPT and listed in the PR for Ben to rule on.

This is REMOVAL ONLY, apart from the one Section 4 heading in item 5 (whose
new text is the only wording this script writes; the 4.3 statement under it
is copied verbatim from the source). Everything else in
the document (title, meta tags, every other section, the footer, the
tracking CSS/JS -- now inert since the hidden content no longer exists to
hide) is byte-for-byte identical to `partner-agreement.html`. A committed
parity test (`tests/gh2155-hi0c-inspector-agreement-parity.mjs`) regenerates
this file from the current source and asserts byte-equality with what's
committed here, so the two can never silently drift apart.

Usage:
    python tools/build_inspector_agreement.py            # writes the file
    python tools/build_inspector_agreement.py --check     # exits 1 on drift
    python tools/build_inspector_agreement.py --stdout    # prints, no write
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_PATH = REPO_ROOT / "partner-agreement.html"
OUTPUT_PATH = REPO_ROOT / "partner-agreement-inspector.html"

FEE_BLOCK_START = '<div id="feeStructureBlock" class="inspector-hide">'
FOUR_ONE_START = '<div class="inspector-hide">\n                <h3>4.1 Single-Level Recruiting'
SECTION_7_START = '<section class="inspector-hide">'
SPAN_14A_START = '<span class="inspector-hide">'

SECTION_4_START = '<section>\n                <h2>4. Referral Fee Structure</h2>'
FOUR_THREE_START = '<h3>4.3 Home Inspector Partners</h3>\n                <p>'
INSPECTOR_SECTION_4_HEADING = "4. No Referral Fee or Recruit Bonus"

# HI-0e (D-333): fee-payment mechanics removed from the inspector build.
SECTION_5_START = "<section>\n                <h2>5. Payment Method; Payment Information</h2>"
SECTION_10_START = "<section>\n                <h2>10. Commission Reversal</h2>"
SECTION_9_SENTENCE = (
    "Commissions and bonuses are earned only on jobs that Otter Quotes&rsquo; "
    "tracking systems attribute to Partner&rsquo;s unique referral or recruit link. "
)
SECTION_11_XREF = "10 (Commission Reversal), "
# (old, new, expected occurrences): each `new` is `old` with words removed.
PHRASE_REMOVALS = [
    ("— commission terms, tax treatment, and", "— tax treatment and", 2),  # meta + og description
    ("tax reporting obligations, commission terms, and licensing", "tax reporting obligations and licensing", 1),
]


def _cut_balanced(text: str, start_marker: str, close_tag: str, search_from: int = 0) -> tuple[str, int]:
    """Remove the first element beginning with `start_marker`, up to and
    including the first `close_tag` that follows it (these four elements
    contain no nested instance of their own tag, so a first-match close is
    correct -- verified by inspection of partner-agreement.html at HEAD).
    Returns (new_text, end_index_in_new_text) so callers can keep searching
    forward without re-scanning already-processed text.
    """
    start = text.index(start_marker, search_from)
    end = text.index(close_tag, start) + len(close_tag)
    return text[:start] + text[end:], start


def build_inspector_agreement(source_text: str) -> str:
    text = source_text

    # 1. Fee structure block (div, no nested <div> inside it).
    text, pos = _cut_balanced(text, FEE_BLOCK_START, "</div>")

    # 2. Section 4.1 (div, no nested <div> inside it).
    text, pos = _cut_balanced(text, FOUR_ONE_START, "</div>", pos)

    # 3. All of Section 7 (section, no nested <section> inside it).
    text, pos = _cut_balanced(text, SECTION_7_START, "</section>", pos)

    # 4. Section 14(a) cross-reference span (span, no nested <span> inside it).
    text, pos = _cut_balanced(text, SPAN_14A_START, "</span>", pos)

    # 5. Section 4 -> heading "4. No Referral Fee or Recruit Bonus" containing
    #    ONLY the verbatim 4.3 Home Inspector Partners statement (drops the
    #    "4. Referral Fee Structure" heading, the 4.2 Payment Timing paragraph
    #    and the 4.3 sub-heading; no nested <section>/<p> inside the paragraph).
    p_start = source_text.index(FOUR_THREE_START) + len(FOUR_THREE_START) - len("<p>")
    p_end = source_text.index("</p>", p_start) + len("</p>")
    statement = source_text[p_start:p_end]
    sec_start = text.index(SECTION_4_START)
    sec_end = text.index("</section>", sec_start) + len("</section>")
    new_section = (
        "<section>\n                <h2>" + INSPECTOR_SECTION_4_HEADING + "</h2>\n"
        "                " + statement + "\n            </section>"
    )
    text = text[:sec_start] + new_section + text[sec_end:]

    # 6. HI-0e (D-333): remove the fee-payment mechanics (see docstring item 6).
    #    Whole sections are dropped (with the blank line that follows them) and
    #    the remaining sections keep their numbers.
    for start in (SECTION_5_START, SECTION_10_START):
        sec_start = text.index(start)
        sec_end = text.index("</section>", sec_start) + len("</section>")
        tail = "\n\n            "
        if text.startswith(tail, sec_end):
            sec_end += len(tail)
        text = text[:sec_start] + text[sec_end:]
    for old, expected in ((SECTION_9_SENTENCE, 1), (SECTION_11_XREF, 1)):
        if text.count(old) != expected:
            raise ValueError(f"expected {expected} occurrence(s) of {old!r}, found {text.count(old)}")
        text = text.replace(old, "")
    for old, new, expected in PHRASE_REMOVALS:
        if text.count(old) != expected:
            raise ValueError(f"expected {expected} occurrence(s) of {old!r}, found {text.count(old)}")
        text = text.replace(old, new)

    return text


def main() -> int:
    # gh-2155 HI-0c / R-... (Windows EOL fossil): partner-agreement.html is
    # committed with bare LF line endings. Every read/write below uses
    # newline="" so Python does NO universal-newline translation in either
    # direction -- on Windows, the default text-mode translation would
    # silently turn this file's LF into CRLF on write (and stdout would do
    # the same), producing a byte-for-byte drift against the committed file
    # that has nothing to do with the actual HTML content. Match the
    # source's EOL exactly; never normalize (memory: otterquote-ef-crlf /
    # code-edit-tool-crlf-flip).
    args = sys.argv[1:]
    # Path.read_text()'s `newline` kwarg is Python 3.13+ only; CI runs 3.11,
    # so open() directly instead (it has always accepted `newline`).
    with SOURCE_PATH.open("r", encoding="utf-8", newline="") as f:
        source_text = f.read()
    output_text = build_inspector_agreement(source_text)

    if "--stdout" in args:
        sys.stdout.buffer.write(output_text.encode("utf-8"))
        return 0

    if "--check" in args:
        if not OUTPUT_PATH.exists():
            print(f"MISSING: {OUTPUT_PATH} does not exist", file=sys.stderr)
            return 1
        with OUTPUT_PATH.open("r", encoding="utf-8", newline="") as f:
            committed = f.read()
        if committed != output_text:
            print(f"DRIFT: {OUTPUT_PATH} does not match a fresh build from {SOURCE_PATH}", file=sys.stderr)
            return 1
        print("OK: partner-agreement-inspector.html matches a fresh build.")
        return 0

    with OUTPUT_PATH.open("w", encoding="utf-8", newline="") as f:
        f.write(output_text)
    print(f"Wrote {OUTPUT_PATH} ({len(output_text)} bytes).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
