#!/usr/bin/env python3
"""
Sentry loader/onLoad ordering guard (gh-2010, gh-2023, gh-2043).

The Sentry loader tag (`js.sentry-cdn.com/<key>.min.js`) carries no `async`
and no `defer`, so it blocks the HTML parser until it finishes. If that
fetch never completes at all -- ad blocker, CSP, or the CDN host sitting on
a common blocklist -- the `Sentry` global never gets defined. The OLD
pattern called `Sentry.onLoad(function() { Sentry.init({...}); })` in a
plain inline `<script>` placed AFTER the loader tag. When the loader never
executes, that call throws `ReferenceError: Sentry is not defined` --
silently killing error monitoring for every ad-blocking visitor, on every
page that still uses it, every time (gh-2010, corrected diagnosis on
comment 5729280585: this is not a load-order race, it is a guaranteed
failure whenever the loader doesn't load).

The fix (gh-2010 / PR #2023, swept to the remaining pages on gh-2043) is
Sentry's own documented pattern for exactly this case: predeclare
`window.sentryOnLoad = function () { Sentry.init({...}); };` BEFORE the
loader `<script>` tag. The loader itself calls `window.sentryOnLoad` once
the SDK has actually finished loading; if the loader never runs, nothing
ever calls it and nothing throws.

This script fails the build the moment any HTML page reintroduces the old
`Sentry.onLoad(` ordering, or defines `window.sentryOnLoad` AFTER the
loader tag instead of before it.

Every HTML file that talks to Sentry at all must:
  1. Never call `Sentry.onLoad(` (the racy post-load pattern) -- use
     `window.sentryOnLoad = function () { ... }` instead.
  2. Define `window.sentryOnLoad` strictly BEFORE the loader tag
     (`src="https://js.sentry-cdn.com/...")`, if the page loads one at all.
  3. Define `window.sentryOnLoad` exactly once.

Exit codes:
  0 -- no violations
  1 -- one or more violations
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent

ONLOAD_CALL_RE = re.compile(r'Sentry\.onLoad\(')
PREDECLARE_RE = re.compile(r'window\.sentryOnLoad\s*=')
LOADER_RE = re.compile(r'src=["\']https://js\.sentry-cdn\.com/[^"\']+["\']')

# Pre-existing, DIFFERENT defect (not this check's target): the page loads the
# Sentry loader tag but never calls Sentry.onLoad( OR predeclares
# window.sentryOnLoad at all -- the SDK loads and does nothing, silently.
# That's a missing-init bug, not the racy onLoad-after-loader ordering gh-2010/
# gh-2023/gh-2043 fixed, and fixing it means writing a NEW Sentry.init config
# for a page that never had one -- design judgment, out of scope for a
# mechanical ordering sweep. Filed separately; do not silently expand this
# allowlist without a tracking issue.
NO_INIT_AT_ALL_ALLOWLIST = {
    "privacy.html",  # loads js.sentry-cdn.com/...min.js, calls neither Sentry.onLoad( nor predeclares sentryOnLoad
}


def check_file(path: pathlib.Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    onload_call_lines = [i + 1 for i, l in enumerate(lines) if ONLOAD_CALL_RE.search(l)]
    predeclare_lines = [i + 1 for i, l in enumerate(lines) if PREDECLARE_RE.search(l)]
    loader_lines = [i + 1 for i, l in enumerate(lines) if LOADER_RE.search(l)]

    errors: list[str] = []

    if onload_call_lines:
        errors.append(
            f"uses the racy `Sentry.onLoad(` pattern (line {onload_call_lines[0]}) -- "
            f"replace with `window.sentryOnLoad = function () {{ ... }};` predeclared "
            f"before the loader tag (gh-2010/PR #2023 pattern)"
        )

    if not loader_lines:
        return errors  # page doesn't load the Sentry SDK at all

    if not predeclare_lines:
        if path.name in NO_INIT_AT_ALL_ALLOWLIST and not onload_call_lines:
            return errors
        errors.append(
            f"loads the Sentry SDK (line {loader_lines[0]}) but never predeclares "
            f"`window.sentryOnLoad` -- Sentry.init() will never run"
        )
        return errors

    if len(predeclare_lines) > 1:
        errors.append(
            f"defines `window.sentryOnLoad` {len(predeclare_lines)} times "
            f"(lines {predeclare_lines}) -- remove the duplicate"
        )

    if predeclare_lines[0] > loader_lines[0]:
        errors.append(
            f"loader tag (line {loader_lines[0]}) is loaded before `window.sentryOnLoad` "
            f"is defined (first at line {predeclare_lines[0]}) -- move the predeclare "
            f"block above the loader `<script>` tag"
        )

    return errors


def main() -> int:
    failures = 0
    files_scanned = 0
    for path in sorted(REPO.glob("*.html")):
        files_scanned += 1
        errors = check_file(path)
        if not errors:
            continue
        failures += 1
        print(f"FAIL: {path.name}")
        for err in errors:
            print(f"  {err}")

    if failures:
        print()
        print(f"{failures} HTML file(s) have Sentry loader/onLoad ordering violations.")
        print("Reference: gh-2010 (diagnosis + first fix), PR #2023 (index/login/contractor-join), "
              "gh-2043 (remaining pages).")
        return 1

    print(f"check-sentry-onload-order: {files_scanned} HTML files scanned, no violations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
