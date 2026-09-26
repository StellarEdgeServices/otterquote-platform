#!/usr/bin/env python3
"""
Self-test for scripts/check-partner-consent-link.py (gh-2155 HI-0c REVIEW
FAIL 5836957364, item 3).

WHY THIS EXISTS
----------------
This detector was gh-1738 LEGACY_EXEMPT ("no negative-control test yet") --
scripts/detector-negative-control-check.py's own comment says to remove the
exemption once a <name>.test.py exists (this file), which the accompanying
PR does.

The item this test proves: the guard's INSPECTOR_TARGET acceptance used to
be GLOBAL -- ANY surface's "Partner Terms" consent link could point at
partner-agreement-inspector.html and still pass, which is not what D-278
means by "resolves to A real partner agreement" (it must be the ONE
agreement matching that surface's own track). The fix replaced the global
acceptance with an explicit per-page map
(INSPECTOR_TARGET_ALLOWED_ON = {"partner-inspectors.html", "hi-1.html"}).
This test exercises href_is_compliant() directly (the exact function the
real scan calls per-match), not the filesystem scan, so it needs no
fixture files on disk -- hi-1.html does not exist on main yet, and its
allowlist entry must still be provable before that page exists.

Run: python scripts/check-partner-consent-link.test.py
"""
import importlib.util
import pathlib
import sys

spec = importlib.util.spec_from_file_location(
    "check_partner_consent_link",
    pathlib.Path(__file__).resolve().parent / "check-partner-consent-link.py",
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"PASS {label}: {actual!r}")
    else:
        print(f"FAIL {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def main() -> int:
    print("positive control: partner-agreement.html is compliant on ANY surface")
    check(
        "partner-agreement.html href on partner-re.html (unrelated surface)",
        mod.href_is_compliant("partner-agreement.html", "partner-re.html"),
        True,
    )
    check(
        "partner-agreement.html href on partner-inspectors.html",
        mod.href_is_compliant("/partner-agreement.html", "partner-inspectors.html"),
        True,
    )

    print()
    print("positive control: partner-agreement-inspector.html IS compliant on its two mapped surfaces")
    check(
        "partner-agreement-inspector href on partner-inspectors.html (mapped)",
        mod.href_is_compliant("partner-agreement-inspector.html", "partner-inspectors.html"),
        True,
    )
    check(
        "partner-agreement-inspector href on hi-1.html (mapped, page does not exist on main yet)",
        mod.href_is_compliant("/partner-agreement-inspector.html", "hi-1.html"),
        True,
    )

    print()
    print("NEGATIVE CONTROL: partner-agreement-inspector.html is NOT compliant on an unmapped surface")
    check(
        "partner-agreement-inspector href on partner-re.html (unmapped -- must FAIL the guard)",
        mod.href_is_compliant("partner-agreement-inspector.html", "partner-re.html"),
        False,
    )
    check(
        "partner-agreement-inspector href on partner-agreement.html itself (unmapped -- must FAIL)",
        mod.href_is_compliant("/partner-agreement-inspector.html", "partner-agreement.html"),
        False,
    )
    check(
        "partner-agreement-inspector href on partner-other.html (unmapped -- must FAIL)",
        mod.href_is_compliant("partner-agreement-inspector.html", "partner-other.html"),
        False,
    )

    print()
    print("negative control: neither target -- always non-compliant regardless of surface")
    check(
        "/terms.html href on partner-re.html",
        mod.href_is_compliant("/terms.html", "partner-re.html"),
        False,
    )

    print()
    if FAILURES:
        print(f"FAILED -- {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("check-partner-consent-link: all assertions passed -- per-page INSPECTOR_TARGET map enforced correctly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
