#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/spec-spy-order-check.py (gh-1840 control
1). Thin wrapper around that script's own --self-test (which already runs
against scripts/fixtures/spy-order-bad.spec.ts / spy-order-good.spec.ts and
prints PASS/FAIL lines in this repo's convention) so it is discovered and run
by scripts/detector-negative-control-check.py's CHECK 1 the same way every
other detector's <name>.test.py is.

Also directly exercises scan_file() against a FROZEN, committed fixture of
PR #1720's real original spec (scripts/fixtures/gh1840/spy-before-click.spec.ts.fixture
-- see scripts/fixtures/gh1840/PROVENANCE.md for exactly which commit it was
extracted from and why) and the REAL current
tests/e2e/smoke/entry-point-reachability.spec.ts on `main` -- the actual
incident this check exists to catch, not just a synthetic stand-in -- so a
regression that only shows up against real-world shapes (nine install sites
across three separate page.evaluate blocks, not one) does not slip past a
fixture that is too minimal to exercise it.

PR #1866 review (comment 5584552830) found the prior version of this file
read the original spec live via `git show <sha>:<path>` at test time. That
broke two ways at once, both fixed by freezing the content instead:
  1. `actions/checkout@v4`'s default shallow (depth-1) clone means the old
     commit is not present in CI's checkout, so `git show` exits 128 on
     every real GitHub Actions run -- the real-recovery check silently
     WARNed and skipped there, even though it ran fine locally (full
     history). The PR's own headline evidence never actually executed in
     the CI that gates `main`.
  2. The old commit's full SHA, embedded as a literal `git show` argument,
     tripped this repo's Credential Shape Sweep (HEX_RUN_20 -- any bare
     20+ hex-char run, regardless of what it actually is).
A missing fixture is now a HARD FAIL (non-zero exit, a named token,
FIXTURE_MISSING) rather than a WARN-and-skip -- a silent downgrade from
required-and-absent to skipped-and-invisible is exactly the #1840 issue
class this detector exists to catch, and this test file is not exempt from
its own rule.

Run: python spec-spy-order-check.test.py
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent

spec = importlib.util.spec_from_file_location("spy_order", HERE / "spec-spy-order-check.py")
spy_order = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spy_order)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def main():
    print("=" * 78)
    print("scripts/spec-spy-order-check.py -- self-test delegation")
    print("=" * 78)
    code = spy_order.self_test(ROOT)
    check("self_test(ROOT) exit code", code, 0)

    print()
    print("=" * 78)
    print("scripts/spec-spy-order-check.py -- real-world regression fixtures")
    print("=" * 78)

    # FROZEN fixture, committed to the repo -- see the module docstring above
    # and scripts/fixtures/gh1840/PROVENANCE.md for exactly which commit this
    # is byte-for-byte extracted from and why it is no longer fetched live
    # via `git show` at test time. Deliberately NOT a soft skip: a missing
    # fixture is this test's own instance of the #1840 issue class (a
    # required check silently downgrading to absent-and-unnoticed), so it is
    # a hard, named-token failure instead.
    real_buggy = HERE / "fixtures" / "gh1840" / "spy-before-click.spec.ts.fixture"
    if not real_buggy.exists():
        print(
            "  FAIL  FIXTURE_MISSING: frozen fixture not found at %s -- this is NOT an "
            "environment limitation to WARN past. The fixture is committed to the repo "
            "(see scripts/fixtures/gh1840/PROVENANCE.md); its absence means the real-world "
            "regression check this test exists to run cannot run at all." % real_buggy
        )
        FAILURES.append("FIXTURE_MISSING")
    else:
        violations, blocks = spy_order.scan_file(real_buggy, ROOT)
        spy_tokens = [v for v in violations if spy_order.VERDICT_TOKEN in v]
        check(
            "FROZEN FIXTURE (PR #1720 original, see scripts/fixtures/gh1840/"
            "PROVENANCE.md) rejected with >=6 SPY_UNVERIFIED violations "
            "(six money-path handlers, PR #1720 comment 5560323618)",
            len(spy_tokens) >= 6,
            True,
        )

    real_clean = ROOT / "tests" / "e2e" / "smoke" / "entry-point-reachability.spec.ts"
    if real_clean.exists():
        violations, blocks = spy_order.scan_file(real_clean, ROOT)
        check(
            "REAL current tests/e2e/smoke/entry-point-reachability.spec.ts "
            "(main, fixed) has zero SPY_UNVERIFIED violations",
            [v for v in violations if spy_order.VERDICT_TOKEN in v],
            [],
        )
    else:
        print(
            "  WARN  tests/e2e/smoke/entry-point-reachability.spec.ts not found under "
            "this checkout -- skipping the real-world clean-fixture check."
        )

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("spec-spy-order-check.test.py: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
