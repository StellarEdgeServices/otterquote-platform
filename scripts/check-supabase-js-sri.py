#!/usr/bin/env python3
"""
Stage 5 prevention for gh-1793 (2026-09-08).

75 of 78 root *.html pages loaded @supabase/supabase-js from the jsDelivr CDN
at a FLOATING major (`@2`, or no version at all) with zero Subresource
Integrity -- third-party code executing unverified, in the same scope as the
Supabase client, on every authenticated page a homeowner or contractor
touches. Nothing in CI checked what a `<script src>` pointed at.

The fix pins one exact version with a matching sha384 `integrity=` on every
page. This guard is what keeps a fresh page (or a "quick CDN link" reflex)
from reintroducing an unpinned or uninstrumented load. It scans root-level
*.html files only -- the same scope the originating enumeration used
(`git ls-tree --name-only origin/main`, non-recursive) -- and fails when any
`<script>` tag loading @supabase/supabase-js either:
  (a) has no `integrity="sha256-|sha384-|sha512-..."` attribute, or
  (b) is pinned to a floating tag (`@2`, `@latest`, no version at all)
      instead of an exact `x.y.z` version.

Exit codes:
  0 -- no violations
  1 -- one or more unpinned/uninstrumented supabase-js load(s) (each printed)
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent

# <script ...src="...supabase-js...">  -- any attribute order, single tag.
SCRIPT_TAG_RE = re.compile(
    r'<script\b[^>]*\bsrc\s*=\s*["\']([^"\']*supabase-js[^"\']*)["\'][^>]*>',
    re.IGNORECASE,
)
VERSION_RE = re.compile(r"@supabase/supabase-js@([^/\"'?#]+)")
EXACT_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+([.\-+].*)?$")
INTEGRITY_RE = re.compile(r'\bintegrity\s*=\s*["\']sha(?:256|384|512)-', re.IGNORECASE)


def root_html_files() -> list[pathlib.Path]:
    return sorted(p for p in REPO.iterdir() if p.is_file() and p.suffix.lower() == ".html")


def main() -> int:
    violations: list[str] = []
    for path in root_html_files():
        rel = path.name
        try:
            text = path.read_bytes().decode("utf-8", errors="replace")
        except OSError as e:
            violations.append(f"{rel}: unreadable ({e})")
            continue
        for m in SCRIPT_TAG_RE.finditer(text):
            tag, src = m.group(0), m.group(1)
            vm = VERSION_RE.search(src)
            version = vm.group(1) if vm else None
            floating = version is None or not EXACT_VERSION_RE.match(version)
            pinned = INTEGRITY_RE.search(tag) is not None
            if floating or not pinned:
                reasons = []
                if floating:
                    reasons.append(f"floating/unpinned version ({version!r})")
                if not pinned:
                    reasons.append("missing integrity=")
                violations.append(f"{rel}: {', '.join(reasons)} -- {src}")

    if violations:
        print(f"check-supabase-js-sri: {len(violations)} unpinned/uninstrumented supabase-js load(s):")
        for v in violations:
            print("  " + v)
        return 1
    print("check-supabase-js-sri: OK -- every root-page supabase-js load is pinned with a matching integrity hash")
    return 0


if __name__ == "__main__":
    sys.exit(main())
