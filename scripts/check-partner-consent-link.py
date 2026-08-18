#!/usr/bin/env python3
"""
gh-943 / D-278: partner-signup consent checkbox link guard.

D-278 (2026-08-12) requires every partner-signup surface's "Partner Terms"
consent checkbox to link to partner-agreement.html. #766 built the page;
partner-re.html was missed and shipped linking to /terms instead -- caught
only by the 2026-08-16 forge weekly sweep and filed as #941. That is the
same piecemeal, page-by-page-fix-with-no-full-surface-check pattern #942
covers for the D-286 purge: a fix applied to N-1 of N surfaces looks done
and isn't, and the miss survives until the next manual sweep finds it.

This script does NOT hardcode the surface list (gh-943 AC3). A hardcoded
list is exactly the failure mode being guarded against -- it would need a
human to remember to add every new partner-signup page to it, which is the
same kind of manual step that let partner-re.html slip through in the first
place. Instead it detects "is this a partner-signup surface" the same way
a user would: does the page contain the consent checkbox's link text at
all ("Partner Terms")? Any top-level .html file containing that anchor
text is treated as a partner-signup surface and its href is checked. A
newly added partner page automatically gets covered the moment its own
consent checkbox exists, with no separate registration step.

Exit codes:
  0 -- every "Partner Terms" consent link found resolves to partner-agreement
  1 -- at least one surface still links elsewhere (or a link couldn't be parsed)
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent

# Top-level .html only -- these are static marketing/signup pages, matching
# the D-278/#941 surfaces exactly. Not recursing into react-app/ (a distinct
# app with its own component-based consent UI, not a static anchor tag) or
# node_modules/.next (build output, not source).
SKIP_DIR_NAMES = {"node_modules", ".git", "__pycache__", "playwright-report", "test-results", ".next", "react-app"}

# Matches the consent checkbox's link, regardless of attribute order or
# extra attributes on the <a> tag -- anchored on the link TEXT ("Partner
# Terms"), not the filename it appears in or the href it currently has.
# That's what makes this dynamic rather than a hardcoded page list.
CONSENT_LINK_RE = re.compile(
    r'<a\s+[^>]*href="([^"]+)"[^>]*>\s*Partner\s+Terms\s*</a>',
    re.IGNORECASE,
)

REQUIRED_TARGET = "partner-agreement"


def href_is_compliant(href: str) -> bool:
    # Accept any relative/absolute form that resolves to partner-agreement:
    # "partner-agreement.html", "/partner-agreement", "/partner-agreement.html",
    # "partner-agreement" (extensionless routing), with or without a leading
    # "./" or trailing query/hash.
    target = href.split("?")[0].split("#")[0]
    target = target.lstrip("./").lstrip("/")
    target = re.sub(r"\.html$", "", target)
    return target == REQUIRED_TARGET


def iter_candidate_files():
    for path in REPO.glob("*.html"):
        if any(part in SKIP_DIR_NAMES for part in path.parts):
            continue
        yield path


def main() -> int:
    surfaces_checked: list[str] = []
    violations: list[str] = []

    for path in iter_candidate_files():
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        matches = list(CONSENT_LINK_RE.finditer(text))
        if not matches:
            continue  # not a partner-signup surface -- no consent checkbox at all

        rel_path = path.name
        surfaces_checked.append(rel_path)

        for m in matches:
            href = m.group(1)
            if not href_is_compliant(href):
                lineno = text.count("\n", 0, m.start()) + 1
                violations.append(
                    f"{rel_path}:{lineno}: Partner Terms link resolves to \"{href}\", "
                    f"must resolve to \"partner-agreement\" (D-278)"
                )

    if not surfaces_checked:
        print("FAIL: found 0 partner-signup surfaces (no 'Partner Terms' consent link anywhere) "
              "-- the detector itself is broken, or every surface was removed. Either way, "
              "investigate before trusting a 0-surfaces PASS.")
        return 1

    if violations:
        print(f"FAIL: partner-signup consent checkbox link guard (D-278/gh-943) -- "
              f"{len(violations)} violation(s) across {len(surfaces_checked)} surface(s) checked:")
        for v in violations:
            print(f"  - {v}")
        print(
            "\nD-278 (2026-08-12): the 'Partner Terms' consent checkbox must link to "
            "partner-agreement.html on every partner-signup surface. Fix the href, or if this "
            "surface genuinely should not require the standard partner agreement, say so "
            "explicitly in the PR rather than leaving it silently divergent."
        )
        return 1

    print(f"PASS: check-partner-consent-link: {len(surfaces_checked)} surface(s) checked, "
          f"0 violations (D-278/gh-943): {', '.join(sorted(surfaces_checked))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
