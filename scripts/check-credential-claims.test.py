#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/check-credential-claims.py (gh-1841).

gh-1841 found this detector shipped (gh-1617) with no self-test at all --
detector-shaped, no negative control, invisible to the gate #1742/#1738
built specifically to catch that shape. This file closes it the same way
scripts/credential-sweep.test.py and scripts/check-legal-surface-links.test.py
already do for their own detectors: run the real checker against a stubbed
fixture tree and observe it actually reject a D-104 credential claim, not
merely assert that it "should."

Two runs against an isolated tmp fixture tree (module.REPO is monkeypatched
so this never touches the real repo or its real ALLOWLIST entries):
  1. DIRTY tree -- one HTML file carrying an un-allowlisted "licensed,
     insured contractors" claim. Must FAIL (exit 1, hit reported).
  2. CLEAN tree -- same file with the claim removed. Must PASS (exit 0).

A test that only ever fed the detector clean input would prove nothing
(the class of gap gh-1841 exists to close); the dirty-tree run is the
negative control.

Run: python scripts/check-credential-claims.test.py
"""
import contextlib
import importlib.util
import io
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_credential_claims", HERE / "check-credential-claims.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def check_true(label, cond):
    check(label, bool(cond), True)


def run_against(tmp_root: pathlib.Path):
    """Run main() with module.REPO pointed at tmp_root, capturing stdout."""
    original_repo = mod.REPO
    mod.REPO = tmp_root
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            code = mod.main()
    finally:
        mod.REPO = original_repo
    return code, buf.getvalue()


def main():
    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="credclaims-test-"))
    try:
        print("negative control: un-allowlisted D-104 credential claim in a fresh fixture file")
        dirty = tmp_root / "negative-control-fixture.html"
        dirty.write_text(
            "<html><body><p>Our licensed, insured contractors are ready to help "
            "with your roofing project today.</p></body></html>",
            encoding="utf-8",
        )
        code, output = run_against(tmp_root)
        check("dirty tree exit code", code, 1)
        check_true("dirty tree reports FAIL banner", "FAIL: contractor credential/screening claim found" in output)
        check_true(
            "dirty tree names the fixture file and matched phrase",
            "negative-control-fixture.html" in output and "licensed, insured contractors" in output,
        )
        dirty.unlink()

        print()
        print("positive control: same tree with the claim removed")
        clean = tmp_root / "negative-control-fixture.html"
        clean.write_text(
            "<html><body><p>Contractors compete for your project; you confirm "
            "credentials before hiring.</p></body></html>",
            encoding="utf-8",
        )
        code, output = run_against(tmp_root)
        check("clean tree exit code", code, 0)
        check_true("clean tree reports PASS banner", output.strip().startswith("PASS: check-credential-claims"))
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("check-credential-claims: all assertions passed (negative control observed FAILING; clean tree observed PASSING).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
