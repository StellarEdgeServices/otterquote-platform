#!/usr/bin/env python3
"""
Self-test / negative control for behavioural-ordering-check.py (gh-1840).

The house standard this repo set on gh-1738 and restated in gh-1840's own
closes-on: a detector is not trusted until it has been OBSERVED rejecting the
thing it exists to reject, beside a clean fixture it stays silent on. A check
that rejects both, or neither, is not a check.

So every case below is a PAIR. The RED fixture for CHECK A is PR #1720's actual
shape -- a spy installed on a target it does not first prove exists -- and the
GREEN fixture is the same helper with the `typeof ... !== 'function'` refusal
restored ahead of the assignment. The RED fixture for CHECK B is PR #1737's
shape -- a verification step that only runs if an earlier, unrelated
verification step did not crash -- and the GREEN fixture is the same workflow
with `if: always()` on the later step.
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GATE = os.path.join(HERE, "behavioural-ordering-check.py")

FAILS = []


def report(ok, label, detail=""):
    # `PASS <text>` / `FAIL <text>`, no colon: the repo's existing convention,
    # and the shape scripts/detector-negative-control-check.py's PASS_LINE_RE
    # requires before it will count a self-test as having asserted anything.
    print(("PASS " if ok else "FAIL ") + label + ((" -- " + detail) if detail else ""))
    if not ok:
        FAILS.append(label)


def run(root):
    p = subprocess.run([sys.executable, GATE, root], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


SPY_RED = """
// PR #1720's shape: the spy manufactures the binding the spec then asserts.
async function installSpy(page, name) {
  await page.evaluate((targetName) => {
    const wrapper = (...args) => { window.__oqSpyCalls.push([targetName, ...args]); };
    window[targetName] = wrapper;
  }, name);
}
"""

SPY_GREEN = """
// The fixed shape: refuse before replacing anything.
async function installSpy(page, name) {
  await page.evaluate((targetName) => {
    const original = window[targetName];
    if (typeof original !== 'function') {
      throw new Error(`installSpy('${targetName}') FAILED: target does not exist.`);
    }
    const wrapper = (...args) => { window.__oqSpyCalls.push([targetName, ...args]); return original(...args); };
    window[targetName] = wrapper;
  }, name);
}
"""

WF_RED = """
name: Two checks, one fuse
on: [push]
jobs:
  static-integrity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Spec file structural integrity check
        run: python scripts/check-spec-files-closed.py
      - name: Schema drift check
        run: python scripts/schema-column-lint.py
"""

WF_GREEN = """
name: Two checks, both observable
on: [push]
jobs:
  static-integrity:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Spec file structural integrity check
        run: python scripts/check-spec-files-closed.py
      - name: Schema drift check
        if: always()
        run: python scripts/schema-column-lint.py
"""

WF_SETUP_ONLY = """
name: Setup then one check
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm ci
      - name: Run Vitest unit tests
        run: npm test
"""


def case_spy_red():
    with tempfile.TemporaryDirectory() as root:
        write(root, "tests/e2e/smoke/reach.spec.ts", SPY_RED)
        write(root, ".github/workflows/noop.yml", WF_GREEN)
        code, out = run(root)
        report("SPY_CREATES_ITS_OWN_BINDING" in out,
               "CHECK A RED: PR #1720's spy-before-binding spec is REJECTED",
               "exit=%d" % code)
        report(code == 2, "CHECK A RED: exits non-zero (2=FAIL)", "exit=%d" % code)


def case_spy_green():
    with tempfile.TemporaryDirectory() as root:
        write(root, "tests/e2e/smoke/reach.spec.ts", SPY_GREEN)
        write(root, ".github/workflows/noop.yml", WF_GREEN)
        code, out = run(root)
        report("SPY_CREATES_ITS_OWN_BINDING" not in out,
               "CHECK A GREEN: the guarded installer is NOT flagged (the check discriminates)")
        report("CHECK A PASS" in out, "CHECK A GREEN: the guarded installer is positively reported, not merely silent")
        report(code == 0, "CHECK A GREEN: exits 0", "exit=%d" % code)


def case_step_red():
    with tempfile.TemporaryDirectory() as root:
        write(root, ".github/workflows/two-checks.yml", WF_RED)
        write(root, "tests/e2e/smoke/reach.spec.ts", SPY_GREEN)
        code, out = run(root)
        report("STEP_UNRUN_SHADOWED" in out,
               "CHECK B RED: PR #1737's shape is REJECTED")
        report("Schema drift check" in out and "UNRUN" in out,
               "CHECK B RED: names the LATER step and calls it UNRUN, not absent")
        report("Spec file structural integrity check" in out,
               "CHECK B RED: names the earlier step whose crash would shadow it")
        report(code == 2, "CHECK B RED: exits non-zero (2=FAIL)", "exit=%d" % code)


def case_step_green():
    with tempfile.TemporaryDirectory() as root:
        write(root, ".github/workflows/two-checks.yml", WF_GREEN)
        write(root, "tests/e2e/smoke/reach.spec.ts", SPY_GREEN)
        code, out = run(root)
        report("STEP_UNRUN_SHADOWED" not in out,
               "CHECK B GREEN: `if: always()` on the later step is silent (the check discriminates)")
        report(code == 0, "CHECK B GREEN: exits 0", "exit=%d" % code)


def case_setup_does_not_shadow():
    with tempfile.TemporaryDirectory() as root:
        write(root, ".github/workflows/setup.yml", WF_SETUP_ONLY)
        write(root, "tests/e2e/smoke/reach.spec.ts", SPY_GREEN)
        code, out = run(root)
        report("STEP_UNRUN_SHADOWED" not in out,
               "CHECK B narrowing: a crashing SETUP step is not a shadower (its red is unmistakable)")
        report(code == 0, "CHECK B narrowing: exits 0", "exit=%d" % code)


def case_unmeasured():
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(os.path.join(root, "docs"), exist_ok=True)
        code, out = run(root)
        report(code == 3 and "GATE: UNMEASURED" in out,
               "ZERO-DISCOVERY: a root with nothing to inspect is UNMEASURED, never PASS",
               "exit=%d" % code)


def case_real_repo():
    root = os.path.dirname(HERE)
    code, out = run(root)
    report(code in (0, 2) and ("GATE: PASS" in out or "GATE: FAIL" in out),
           "REAL REPO: the gate produces a verdict against this repository",
           "exit=%d" % code)
    report("CHECK A:" in out and "CHECK B:" in out,
           "REAL REPO: both checks report their own discovery counts (a zero is visible, not silent)")


if __name__ == "__main__":
    case_spy_red()
    case_spy_green()
    case_step_red()
    case_step_green()
    case_setup_does_not_shadow()
    case_unmeasured()
    case_real_repo()
    print("")
    if FAILS:
        print("SELF-TEST FAILED: %d assertion(s): %s" % (len(FAILS), "; ".join(FAILS)))
        sys.exit(1)
    print("SELF-TEST PASSED: all assertions, both RED fixtures rejected and both GREEN fixtures silent.")
