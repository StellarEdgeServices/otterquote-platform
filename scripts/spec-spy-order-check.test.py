#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/spec-spy-order-check.py (gh-1840 control
1). Thin wrapper around that script's own --self-test (which already runs
against scripts/fixtures/spy-order-bad.spec.ts / spy-order-good.spec.ts and
prints PASS/FAIL lines in this repo's convention) so it is discovered and run
by scripts/detector-negative-control-check.py's CHECK 1 the same way every
other detector's <name>.test.py is.

Also directly exercises scan_file() against the REAL, historically-recovered
PR #1720 original spec (commit 133b2db, before its own review fix in commit
4d542ba) and the REAL current tests/e2e/smoke/entry-point-reachability.spec.ts
on `main` -- the actual incident this check exists to catch, not just a
synthetic stand-in -- so a regression that only shows up against real-world
shapes (nine install sites across three separate page.evaluate blocks, not
one) does not slip past a fixture that is too minimal to exercise it.

Run: python spec-spy-order-check.test.py
"""
import importlib.util
import pathlib
import subprocess
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

    # Recovered from git history directly, not committed as a duplicate file
    # under scripts/fixtures/ -- this IS PR #1720's actual original spec
    # (commit 133b2db on wm/gh1697), the real incident named in this
    # script's own module docstring, not a stand-in for it.
    proc = subprocess.run(
        ["git", "show", "133b2db6a5cc1e192d15cbd324918d26b7b84122:"
         "tests/e2e/smoke/entry-point-reachability.spec.ts"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=30,
    )
    if proc.returncode != 0:
        print(
            "  WARN  could not recover PR #1720's original commit 133b2db from local git "
            "history (git show exit %d: %s) -- skipping the real-world regression check. "
            "This is an environment limitation (shallow clone / commit not fetched), not a "
            "detector failure; the fixture-based checks above already covered self_test()."
            % (proc.returncode, proc.stderr.strip()[:200])
        )
    else:
        real_buggy = HERE / "fixtures" / "_scratch-pr1720-original.spec.ts"
        real_buggy.write_text(proc.stdout, encoding="utf-8")
        try:
            violations, blocks = spy_order.scan_file(real_buggy, ROOT)
            spy_tokens = [v for v in violations if spy_order.VERDICT_TOKEN in v]
            check(
                "REAL PR #1720 original (commit 133b2db) rejected with >=6 "
                "SPY_UNVERIFIED violations (six money-path handlers, PR #1720 "
                "comment 5560323618)",
                len(spy_tokens) >= 6,
                True,
            )
        finally:
            real_buggy.unlink(missing_ok=True)

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
