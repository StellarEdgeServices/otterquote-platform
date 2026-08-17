#!/usr/bin/env python3
"""
Legal-surface link discovery, for #806.

Generates the list of URLs the weekly link-check (check-legal-surface-links.py)
verifies. This is a GENERATOR, not a hand-maintained list, per #806 AC #1's
explicit requirement ("state explicitly how the list is kept from going
stale as new forms are added") — it re-scans the repo on every run, so a new
consent checkbox or terms link is picked up automatically the next time
either script runs. Nothing needs to be hand-registered.

Method: every top-level *.html page is the deployed static site (each file
is served at its own path, e.g. terms.html -> /terms.html). We scan each
file for <a href="..."> tags and keep the ones whose surrounding context
(the anchor tag's own line, plus up to 4 non-blank lines before it) contains
a legal-load-bearing trigger word: agree, agreement, terms, privacy,
disclaimer, consent, attest, acknowledge, waiver, license, w-9, 1099.

This intentionally over-collects rather than under-collects — a false
positive (a marketing link near the word "agreement") costs one extra HTTP
check; a false negative silently reproduces the #766 failure mode. Anchors
pointing to mailto:, tel:, #fragments-only, or offsite http(s) URLs outside
otterquote.com are excluded (out of scope: we only assert about surfaces we
serve).

Exit: prints one JSON object per line to stdout (JSON Lines), one per
discovered URL: {url, source_file, source_line, link_text, trigger}.
"""
from __future__ import annotations
import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

TRIGGER_WORDS = [
    "agree", "agreement", "terms", "privacy", "disclaimer", "consent",
    "attest", "acknowledge", "waiver", "license", "w-9", "1099",
]
TRIGGER_RE = re.compile(r"(?i)\b(" + "|".join(re.escape(w) for w in TRIGGER_WORDS) + r")\b")
HREF_RE = re.compile(r'href=["\']([^"\'#][^"\']*)["\']')
LOOKBACK = 4

PROD_ORIGIN = "https://otterquote.com"


def is_in_scope(href: str) -> bool:
    if href.startswith(("mailto:", "tel:", "javascript:", "data:")):
        return False
    if "${" in href or "{{" in href:
        return False  # JS template literal / templating placeholder, not a static URL
    if href.startswith("http://") or href.startswith("https://"):
        return "otterquote.com" in href
    return True  # relative path — same-origin by construction


def to_absolute(href: str) -> str:
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if not href.startswith("/"):
        href = "/" + href
    return PROD_ORIGIN + href


def find_in_file(path: pathlib.Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    found: list[dict] = []
    for i, line in enumerate(lines):
        for m in HREF_RE.finditer(line):
            href = m.group(1)
            if not is_in_scope(href):
                continue
            # Build lookback window: this line + up to LOOKBACK prior non-blank lines
            window = [line]
            j = i - 1
            while j >= 0 and len(window) <= LOOKBACK:
                if lines[j].strip():
                    window.append(lines[j])
                j -= 1
            context = "\n".join(window)
            trig = TRIGGER_RE.search(context)
            if not trig:
                continue
            link_text_m = re.search(r">([^<]{0,80})</a>", line[m.end():])
            found.append({
                "url": to_absolute(href),
                "source_file": str(path.relative_to(REPO)).replace("\\", "/"),
                "source_line": i + 1,
                "link_text": (link_text_m.group(1).strip() if link_text_m else ""),
                "trigger": trig.group(1).lower(),
            })
    return found


def main() -> int:
    all_found: list[dict] = []
    for path in sorted(REPO.glob("*.html")):
        all_found.extend(find_in_file(path))

    # De-dupe by resolved URL — many pages link the same terms/privacy page;
    # we only need to check each distinct URL once, but keep the first
    # source reference for traceability.
    seen: dict[str, dict] = {}
    for entry in all_found:
        seen.setdefault(entry["url"], entry)

    for entry in seen.values():
        print(json.dumps(entry))

    print(f"# {len(seen)} distinct legally load-bearing URL(s) discovered across "
          f"{len(list(REPO.glob('*.html')))} top-level HTML files", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
