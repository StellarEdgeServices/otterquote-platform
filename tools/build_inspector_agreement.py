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

This is REMOVAL ONLY -- no new words are added anywhere. Everything else in
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
    source_text = SOURCE_PATH.read_text(encoding="utf-8", newline="")
    output_text = build_inspector_agreement(source_text)

    if "--stdout" in args:
        sys.stdout.buffer.write(output_text.encode("utf-8"))
        return 0

    if "--check" in args:
        if not OUTPUT_PATH.exists():
            print(f"MISSING: {OUTPUT_PATH} does not exist", file=sys.stderr)
            return 1
        committed = OUTPUT_PATH.read_text(encoding="utf-8", newline="")
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
