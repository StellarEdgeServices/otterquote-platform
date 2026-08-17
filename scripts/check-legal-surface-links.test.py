#!/usr/bin/env python3
"""
Proof-of-detection test for #806 AC #5: "Demonstrate the detector catches
partner-agreement.html in its current 404 state."

Runs check_url() (the same function the scheduled check uses) directly
against two live production URLs:
  - https://otterquote.com/terms.html   — known-good, must PASS
  - https://otterquote.com/partner-agreement.html — the real #766 defect,
    confirmed live 404 as of 2026-08-14, must FAIL

This is not a synthetic fixture — it is the actual production failure the
issue describes. If #766 lands and partner-agreement.html starts resolving,
this test's second assertion will need updating (or the URL swapped for
whatever the next known-bad case is) — that is expected and fine; the point
of this file is proving the checker's PASS/FAIL logic is correct, not
pinning today's defect forever.

Run: python scripts/check-legal-surface-links.test.py
Requires network access to otterquote.com (production).
"""
import sys
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "check_legal_surface_links",
    pathlib.Path(__file__).resolve().parent / "check-legal-surface-links.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def main() -> int:
    failures = []

    good = mod.check_url("https://otterquote.com/terms.html")
    if not good["ok"]:
        failures.append(f"expected terms.html to PASS, got: {good}")
    else:
        print(f"OK: terms.html correctly PASSED (status={good['status']})")

    bad = mod.check_url("https://otterquote.com/partner-agreement.html")
    if bad["ok"]:
        failures.append(
            f"expected partner-agreement.html to FAIL (known #766 404) but it PASSED — "
            f"either #766 landed (update this test's target URL) or the check has a bug: {bad}"
        )
    elif bad["status"] != 404:
        failures.append(f"expected partner-agreement.html to fail with 404, got: {bad}")
    else:
        print(f"OK: partner-agreement.html correctly FAILED (status=404, reason={bad['reason']!r})")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\nDetector proof: PASS on known-good, FAIL on known-bad (#766). Detector works.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
