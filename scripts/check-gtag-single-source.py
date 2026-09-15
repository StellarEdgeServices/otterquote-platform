#!/usr/bin/env python3
"""
Stage 5 prevention for the ungated-analytics-loader cluster (gh-1619, 2026-09-04).

The production GA4 tag (and Microsoft Clarity) used to load unconditionally on
every host that served these pages -- staging, branch-deploy previews,
localhost -- so 92% of the GA4 property was our own CI and every funnel
denominator derived from it was wrong by ~17x. The fix routes every loader
through ONE gate per app that checks `location.hostname` against a
production allowlist and never injects the vendor <script> off-allowlist:

  js/ga-gate.js                        (static site: gtag.js + clarity.ms)
  react-app/app/components/GA4Gate.tsx (React app: gtag.js)

A per-file variant of the loader -- a fresh page that pastes the vendor
snippet, or a .tsx that adds its own `next/script` -- is how the bug recurs,
and the first sweep found the React loader only because it looked past
.html/.js. So this check scans .html, .js, .jsx, .ts and .tsx (excluding
node_modules, .next, build output and this script) for any occurrence of an
analytics loader URL outside the gate files.

gh-1817: extended to also guard the Meta Pixel loader (fbevents.js), routed
through the same two-file gate pattern (js/meta-pixel-gate.js and
react-app/app/components/MetaPixelGate.tsx).

gh-1969: js/meta-pixel-gate.js was found sending a token-bearing URL
fragment (Supabase access_token/refresh_token) to facebook.com/tr as `dl`,
because fbevents.js reads window.location itself and offers no supported
override -- the only fix is to never load fbevents.js while the fragment
carries a live credential (the same fragment predicate PR #1947 added to
js/ga-gate.js for Clarity). This check now also asserts that predicate is
present in js/meta-pixel-gate.js, so a future edit that removes it (the
"single loader location" property alone does not catch this class -- the
gate file can load fbevents.js unconditionally and still pass the loader
scan) fails CI instead of shipping silently.

Exit codes:
  0 -- no violations
  1 -- one or more ungated loader sites, or the pixel gate is missing its
       token-fragment predicate (each printed as path:line or as a named
       violation)
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
GATE_FILES = {
    "js/ga-gate.js",
    "react-app/app/components/GA4Gate.tsx",
    "js/meta-pixel-gate.js",
    "react-app/app/components/MetaPixelGate.tsx",
}
LOADER_RES = [
    ("gtag.js loader", re.compile(r"googletagmanager\.com/gtag/js")),
    ("clarity.ms loader", re.compile(r"clarity\.ms/tag")),
    ("fbevents.js loader", re.compile(r"connect\.facebook\.net/[^\s\"']*fbevents\.js")),
]
META_PIXEL_GATE = REPO / "js" / "meta-pixel-gate.js"
# gh-1969: the fragment predicate must gate the fbevents.js load itself.
# Match the actual `hash.indexOf('access_token')`-style code, not prose --
# a comment mentioning these names (as this very file's writeup does) must
# NOT satisfy the check, or a planted removal of the real predicate that
# leaves the comment behind would pass. hash/window.location.hash is
# required too, since the token names alone could appear in an unrelated
# check.
TOKEN_NAMES = ("access_token", "refresh_token", "provider_token")
TOKEN_CODE_RES = {
    name: re.compile(r"""(?:hash|location\.hash)[^\n]*indexOf\(['"]""" + re.escape(name) + r"""['"]\)""")
    for name in TOKEN_NAMES
}
RETURN_STATEMENT_RE = re.compile(r"\breturn\b[^\n]*;")
FBEVENTS_SRC_RE = re.compile(r"s\.src\s*=.*fbevents\.js")


def check_meta_pixel_fragment_guard() -> list[str]:
    rel = META_PIXEL_GATE.relative_to(REPO).as_posix()
    if not META_PIXEL_GATE.is_file():
        return [f"{rel}: file missing"]
    text = META_PIXEL_GATE.read_text(encoding="utf-8", errors="replace")

    missing = [name for name, rx in TOKEN_CODE_RES.items() if not rx.search(text)]
    if missing:
        return [f"{rel}: missing live token-fragment predicate code for {missing} "
                f"(a substring/comment mention is not enough -- gh-1969 fragment guard "
                f"removed or weakened)"]

    fb_match = FBEVENTS_SRC_RE.search(text)
    if fb_match is None:
        return [f"{rel}: fbevents.js script-src assignment not found -- cannot verify the "
                f"fragment predicate gates it"]
    fbevents_pos = fb_match.start()

    last_token_code_pos = max(rx.search(text).start() for rx in TOKEN_CODE_RES.values())
    if last_token_code_pos > fbevents_pos:
        return [f"{rel}: token-fragment predicate code appears after the fbevents.js script "
                f"tag is built -- it must gate the load, not run after it"]

    # The predicate must actually short-circuit before the load: there must
    # be a `return` between the last token check and the fbevents.js src
    # assignment (mirrors js/ga-gate.js's `if (urlHasAuthToken) { return; }`).
    between = text[last_token_code_pos:fbevents_pos]
    if not RETURN_STATEMENT_RE.search(between):
        return [f"{rel}: no return/early-exit found between the token-fragment predicate and "
                f"the fbevents.js load -- the predicate is not actually gating it"]
    return []
SCAN_SUFFIXES = {".html", ".js", ".jsx", ".ts", ".tsx"}
SKIP_DIR_NAMES = {"node_modules", ".git", ".next", "dist", "build", "coverage", "playwright-report", "test-results"}
SELF = pathlib.Path(__file__).resolve()


def scan_files() -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for path in REPO.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SCAN_SUFFIXES:
            continue
        if any(part in SKIP_DIR_NAMES for part in path.relative_to(REPO).parts):
            continue
        if path.resolve() == SELF:
            continue
        out.append(path)
    return sorted(out)


def main() -> int:
    violations: list[str] = []
    violations.extend(check_meta_pixel_fragment_guard())
    for path in scan_files():
        rel = path.relative_to(REPO).as_posix()
        if rel in GATE_FILES:
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            violations.append(f"{rel}: unreadable ({e})")
            continue
        for i, line in enumerate(lines, 1):
            for label, rx in LOADER_RES:
                if rx.search(line):
                    violations.append(f"{rel}:{i}: {label} outside the gate")
    if violations:
        print(f"check-gtag-single-source: {len(violations)} ungated analytics loader site(s) "
              f"(only {sorted(GATE_FILES)} may load gtag.js / clarity.ms):")
        for v in violations:
            print("  " + v)
        return 1
    print("check-gtag-single-source: OK -- every gtag.js / clarity.ms loader lives in a gate file")
    return 0


if __name__ == "__main__":
    sys.exit(main())
