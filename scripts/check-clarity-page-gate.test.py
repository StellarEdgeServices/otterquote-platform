#!/usr/bin/env python3
"""
Self-test for scripts/check-clarity-page-gate.py (gh-1738 Detector Negative
Control Gate, gh-1964, PR #1978 D2 fix).

The Detector Negative Control Gate (scripts/detector-negative-control-check.py,
CHECK 1) requires every detector-shaped scripts/*.py file to have a sibling
<name>.test.py that runs, exits 0, and self-reports at least one PASS/FAIL
assertion line -- this repo's own convention (see that script's module
docstring). This file is that sibling: it simply invokes
check-clarity-page-gate.py's own `--self-test` mode (which carries the real
planted-fixture suite -- see that script's module docstring for what each
fixture proves) and forwards its verdict, translating its "PASS <name> --
..." / "FAIL <name> -- ..." lines directly (they already match this repo's
own convention) so the negative-control gate can count them without this
file duplicating any fixture logic of its own.

USAGE
    python3 scripts/check-clarity-page-gate.test.py
"""
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE / "check-clarity-page-gate.py"


def main() -> int:
    proc = subprocess.run(
        [sys.executable, str(TARGET), "--self-test"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr)

    if "PASS" not in proc.stdout and "FAIL" not in proc.stdout:
        print(
            "FAIL  check-clarity-page-gate.py --self-test produced no PASS/FAIL "
            "assertion lines at all -- a test that asserts nothing proves nothing"
        )
        return 1

    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
