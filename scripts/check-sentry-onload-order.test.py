#!/usr/bin/env python3
"""
Self-test for scripts/check-sentry-onload-order.py (gh-2043).

WHY THIS EXISTS
----------------
scripts/detector-negative-control-check.py (gh-1738) fails the build on any
new detector-shaped script under scripts/ that has no accompanying
<name>.test.py negative-control fixture, unless it is explicitly
grandfathered in LEGACY_EXEMPT with a justification. This is that fixture
for check-sentry-onload-order.py, added alongside it rather than
grandfathered.

Exercises check_text() directly (the exact function the real per-file scan
calls), not the filesystem walk -- no fixture HTML files needed on disk.

Run: python scripts/check-sentry-onload-order.test.py
"""
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location(
    "check_sentry_onload_order",
    pathlib.Path(__file__).resolve().parent / "check-sentry-onload-order.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FAILURES = []

FIXED_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<!-- Sentry Error Monitoring -->
<!-- gh-2043: predeclare sentryOnLoad before the loader tag; the loader invokes it once the SDK is ready (pattern from gh-2010, PR #2023). -->
<script>
  window.sentryOnLoad = function () {
    Sentry.init({
      environment: "production"
    });
  };
</script>
<script
  src="https://js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js"
  crossorigin="anonymous"
></script>
</head>
</html>
"""

RACY_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<!-- Sentry Error Monitoring -->
<script
  src="https://js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js"
  crossorigin="anonymous"
></script>
<script>
  Sentry.onLoad(function() {
    Sentry.init({
      environment: "production"
    });
  });
</script>
</head>
</html>
"""

BACKWARDS_ORDER_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<script
  src="https://js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js"
  crossorigin="anonymous"
></script>
<script>
  window.sentryOnLoad = function () {
    Sentry.init({ environment: "production" });
  };
</script>
</head>
</html>
"""

NO_SENTRY_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<title>No Sentry here at all</title>
</head>
</html>
"""

DEAD_LOADER_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<!-- Sentry Error Monitoring -->
<script
  src="https://js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js"
  crossorigin="anonymous"
></script>
</head>
</html>
"""

DUPLICATE_PREDECLARE_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<script>
  window.sentryOnLoad = function () { Sentry.init({}); };
</script>
<script>
  window.sentryOnLoad = function () { Sentry.init({}); };
</script>
<script
  src="https://js.sentry-cdn.com/49b5839b50adc240398d822c46d4a86e.min.js"
  crossorigin="anonymous"
></script>
</head>
</html>
"""


def check(label, actual, expected):
    if actual == expected:
        print(f"PASS {label}")
    else:
        print(f"FAIL {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def main() -> int:
    print("positive control: the PR #2023 / gh-2043 fixed pattern is clean")
    check("fixed page has no errors", mod.check_text(FIXED_PAGE), [])

    print()
    print("NEGATIVE CONTROL: the racy post-load Sentry.onLoad( pattern must FAIL")
    errs = mod.check_text(RACY_PAGE)
    check("racy page reports at least one error", len(errs) > 0, True)
    check(
        "racy page's error names the Sentry.onLoad( pattern",
        any("Sentry.onLoad(" in e for e in errs),
        True,
    )

    print()
    print("NEGATIVE CONTROL: predeclare defined but placed AFTER the loader tag must FAIL")
    errs = mod.check_text(BACKWARDS_ORDER_PAGE)
    check("backwards-order page reports at least one error", len(errs) > 0, True)
    check(
        "backwards-order page's error names the ordering problem",
        any("is loaded before" in e for e in errs),
        True,
    )

    print()
    print("negative control: a page with no Sentry at all is silent")
    check("no-Sentry page has no errors", mod.check_text(NO_SENTRY_PAGE), [])

    print()
    print("NEGATIVE CONTROL: loader with neither Sentry.onLoad( nor a predeclare must FAIL "
          "(the privacy.html shape) UNLESS explicitly allowlisted by filename")
    errs_unnamed = mod.check_text(DEAD_LOADER_PAGE)
    check("dead-loader page (no filename) reports an error", len(errs_unnamed) > 0, True)
    errs_allowlisted = mod.check_text(DEAD_LOADER_PAGE, filename="privacy.html")
    check(
        "dead-loader page IS silenced when filename matches NO_INIT_AT_ALL_ALLOWLIST",
        errs_allowlisted,
        [],
    )
    check(
        "privacy.html is actually in the allowlist (fixture stays honest if it's ever removed)",
        "privacy.html" in mod.NO_INIT_AT_ALL_ALLOWLIST,
        True,
    )

    print()
    print("NEGATIVE CONTROL: predeclaring window.sentryOnLoad twice must FAIL")
    errs = mod.check_text(DUPLICATE_PREDECLARE_PAGE)
    check("duplicate-predeclare page reports at least one error", len(errs) > 0, True)
    check(
        "duplicate-predeclare page's error names the duplicate",
        any("2 times" in e for e in errs),
        True,
    )

    print()
    if FAILURES:
        print(f"FAILED -- {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("check-sentry-onload-order: all assertions passed -- ordering guard enforced correctly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
