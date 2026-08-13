#!/usr/bin/env python3
"""
Stage 5 prevention for the contractor-dashboard auth TypeError cluster (2026-05-21).
Bug threads: 86e1fratf, 86e1frat0.

Every `sb.auth.onAuthStateChange(` registration in an HTML file must be preceded
by an `if (!sb) return;` (or equivalent `if (sb)` ternary) guard within the
nearest 5 non-blank preceding lines. The Supabase JS UMD CDN can fail to load
(ad blocker, transient CDN failure), leaving `sb` undefined when DOMContentLoaded
fires — without a guard, the `.auth` access throws an uncaught TypeError that
breaks the page.

Pages migrated to the shared `js/supabase-client.js` init (GitHub #448) are
exempt from the local-guard requirement: that module runs synchronously
before any later inline script and is itself responsible for the CDN-failure
case (gh-448 A3 ruling — it leaves `window.sb` unset on load failure so a
misconfigured/CDN-down page fails loudly rather than silently). Requiring a
second, page-local guard on top of that would just reintroduce the duplicated
per-page pattern gh-448 was migrating away from. A page qualifies for the
exemption only if the shared-init `<script>` tag appears before the
onAuthStateChange call in document order — script tags execute in sequence.

This script fails CI on NEW violations. Known pre-existing violations are
allowlisted by file path only (not line number, to survive unrelated edits) and
are tracked in a follow-up ClickUp task — see ALLOWLIST_NOTE below.

Exit codes:
  0 — no new violations
  1 — one or more new (non-allowlisted) violations
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
TRIGGER_RE = re.compile(r"\bsb\.auth\.onAuthStateChange\s*\(")
GUARD_RE = re.compile(r"if\s*\(\s*!\s*sb\s*\)|if\s*\(\s*sb\s*\)|if\s*\(\s*typeof\s+sb\s*===?\s*['\"]undefined['\"]")
SHARED_INIT_RE = re.compile(r'<script\s+src\s*=\s*["\']js/supabase-client\.js["\']')
LOOKBACK = 5

# Files known to have unguarded onAuthStateChange calls as of 2026-05-21.
# Each entry is allowlisted because adding a guard requires per-file judgment
# (auth-callback.html in particular is on the magic-link critical path and a
# silent early-return would mask CDN-load failures during PKCE exchange).
# Tracked: ClickUp follow-up task created 2026-05-21 from bug-killer-code run
# on 86e1fratf cluster. Remove a file from this set once it has been hardened.
ALLOWLIST_NOTE = "tracked in 2026-05-21 bug-killer-code follow-up"
ALLOWLIST: set[str] = set()

def find_unguarded(path: pathlib.Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    shared_init_line = next(
        (i for i, line in enumerate(lines) if SHARED_INIT_RE.search(line)), None
    )

    violations: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        if not TRIGGER_RE.search(line):
            continue
        if shared_init_line is not None and shared_init_line < i:
            # Shared js/supabase-client.js init runs before this call in
            # document order — it owns the CDN-failure case (gh-448 A3
            # ruling), so a page-local guard is no longer required here.
            continue
        prior_non_blank: list[str] = []
        j = i - 1
        while j >= 0 and len(prior_non_blank) < LOOKBACK:
            stripped = lines[j].strip()
            if stripped:
                prior_non_blank.append(stripped)
            j -= 1
        if any(GUARD_RE.search(p) for p in prior_non_blank):
            continue
        violations.append((i + 1, line.strip()))
    return violations

def main() -> int:
    new_failures = 0
    allowlisted_files_seen: set[str] = set()
    files_scanned = 0
    for path in sorted(REPO.glob("*.html")):
        files_scanned += 1
        rel = path.name
        viols = find_unguarded(path)
        if not viols:
            continue
        if rel in ALLOWLIST:
            allowlisted_files_seen.add(rel)
            for ln, _ in viols:
                print(f"ALLOWLISTED: {rel}:{ln} ({ALLOWLIST_NOTE})")
            continue
        new_failures += 1
        print(f"FAIL: {rel}")
        for ln, src in viols:
            print(f"  line {ln}: {src}")
            print(f"    -> add `if (!sb) return;` within {LOOKBACK} non-blank lines before this call")

    stale_allowlist = ALLOWLIST - allowlisted_files_seen
    if stale_allowlist:
        print()
        print(f"NOTE: allowlist entries with no violations found (remove from ALLOWLIST): {sorted(stale_allowlist)}")
        # stale allowlist is informational, not a failure

    if new_failures:
        print()
        print(f"{new_failures} HTML file(s) have NEW unguarded sb.auth.onAuthStateChange() calls.")
        print("Fix: add `if (!sb) return;` before each onAuthStateChange registration.")
        print("Reference: contractor-dashboard.html lines 1664/2098/2241 fixed in PR #120 (2026-05-21).")
        return 1

    print(f"check-sb-auth-guards: {files_scanned} HTML files scanned, "
          f"{len(allowlisted_files_seen)} allowlisted file(s), no new violations.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
