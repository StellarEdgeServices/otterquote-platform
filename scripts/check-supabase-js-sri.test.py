#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/check-supabase-js-sri.py (gh-1841).

check-supabase-js-sri.py itself shipped in this lane's PR #1830 tonight with
no self-test -- detector-shaped, no negative control, the exact shape gh-1841
was filed to close, and (per gh-1841's own body) one of the two brand-new
detectors that walked straight past the #1738/#1742 gate. This file closes
it: run the real checker against a stubbed fixture tree and observe it
actually reject an unpinned/uninstrumented @supabase/supabase-js CDN load,
not merely assert that it "should."

Three runs against an isolated tmp fixture tree (module.REPO is monkeypatched
so this never touches the real repo's actual root *.html pages):
  1. FLOATING VERSION -- `@supabase/supabase-js@2` (no integrity= at all).
     Must FAIL (exit 1, both defects named).
  2. MISSING INTEGRITY -- exact version pinned, integrity= omitted.
     Must FAIL (exit 1).
  3. CLEAN -- exact version pinned AND a matching integrity= present.
     Must PASS (exit 0).

Runs 1 and 2 are the negative controls -- a test that only ever fed the
detector a clean, fully-pinned tag would prove nothing about whether it can
actually catch the thing it exists to catch.

Run: python scripts/check-supabase-js-sri.test.py
"""
import contextlib
import importlib.util
import io
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_supabase_js_sri", HERE / "check-supabase-js-sri.py")
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


def write_fixture(tmp_root: pathlib.Path, script_tag: str):
    fixture = tmp_root / "negative-control-fixture.html"
    fixture.write_text(
        f"<html><head>{script_tag}</head><body></body></html>",
        encoding="utf-8",
    )
    return fixture


def main():
    tmp_root = pathlib.Path(tempfile.mkdtemp(prefix="supabasesri-test-"))
    try:
        print("negative control 1: floating major version, no integrity=")
        write_fixture(
            tmp_root,
            '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
        )
        code, output = run_against(tmp_root)
        check("floating-version tree exit code", code, 1)
        check_true("floating-version tree names floating version", "floating/unpinned version" in output)
        check_true("floating-version tree names missing integrity", "missing integrity=" in output)

        print()
        print("negative control 2: exact version pinned, integrity= omitted")
        write_fixture(
            tmp_root,
            '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.1/dist/umd/supabase.js"></script>',
        )
        code, output = run_against(tmp_root)
        check("missing-integrity tree exit code", code, 1)
        check_true("missing-integrity tree does not claim floating", "floating/unpinned version" not in output)
        check_true("missing-integrity tree names missing integrity", "missing integrity=" in output)

        print()
        print("positive control: exact version pinned AND matching integrity= present")
        write_fixture(
            tmp_root,
            '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.1/dist/umd/supabase.js" '
            'integrity="sha384-0000000000000000000000000000000000000000000000000000000000000000000000000000" '
            'crossorigin="anonymous"></script>',
        )
        code, output = run_against(tmp_root)
        check("clean tree exit code", code, 0)
        check_true("clean tree reports OK banner", output.strip().startswith("check-supabase-js-sri: OK"))
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("check-supabase-js-sri: all assertions passed (both negative controls observed FAILING; clean tree observed PASSING).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
