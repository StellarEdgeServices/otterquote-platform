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

Exit codes:
  0 -- no violations
  1 -- one or more ungated loader sites (each printed as path:line)
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
GATE_FILES = {
    "js/ga-gate.js",
    "react-app/app/components/GA4Gate.tsx",
}
LOADER_RES = [
    ("gtag.js loader", re.compile(r"googletagmanager\.com/gtag/js")),
    ("clarity.ms loader", re.compile(r"clarity\.ms/tag")),
]
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
