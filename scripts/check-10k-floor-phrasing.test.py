#!/usr/bin/env python3
"""
Self-test for scripts/check-10k-floor-phrasing.py (gh-1738 Detector Negative
Control Gate; added by PR #2222's legal-read fix, comment 5849208388 L1).

Same convention as check-clarity-page-gate.test.py: invokes the target
script's own `--self-test` mode (planted-fixture suite covering both the
positive control -- a page carrying the exact D-301/D-305 approved fee
sentence -- and the negative control -- the PR #2222 defect itself, a
non-approved paraphrase on a fee-mentioning page) and forwards its verdict.

USAGE
    python3 scripts/check-10k-floor-phrasing.test.py
"""
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
TARGET = HERE / "check-10k-floor-phrasing.py"


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
            "FAIL  check-10k-floor-phrasing.py --self-test produced no PASS/FAIL "
            "assertion lines at all -- a test that asserts nothing proves nothing"
        )
        return 1

    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
