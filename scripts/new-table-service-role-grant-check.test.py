#!/usr/bin/env python3
"""
new-table-service-role-grant-check.test.py -- sibling test file for
scripts/new-table-service-role-grant-check.py, per this repo's detector
convention (scripts/detector-negative-control-check.py CHECK 1: every
detector-shaped script needs a <name>.test.py that exits 0 and prints at
least one self-reported PASS/FAIL line).

Runs the detector's own --self-test (fixture-driven, includes a real
negative control -- see new-table-service-role-grant-fixtures/
new_table_no_grant_bad.sql) and additionally exercises the diff-mode path
directly against synthetic old/new file text, so this test does not rely
solely on the fixtures directory existing.
"""
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "new_table_service_role_grant_check", HERE / "new-table-service-role-grant-check.py"
)
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


def test_self_test_passes():
    code = check.self_test()
    ok = code == 0
    print("PASS  self_test() exits 0 (fixture-driven, negative control fires)"
          if ok else "FAIL  self_test() exited %d" % code)
    return ok


def test_bare_diff_missing_grant_fails():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.foo_bar (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "COMMIT;\n"
    )
    findings, _pass_notes = check.evaluate_file("v999-foo-bar.sql", old_text, new_text)
    ok = len(findings) == 1 and "new-table-missing-service-role-grant" in findings[0]
    print("PASS  diff-mode: new table with zero grants -> 1 finding"
          if ok else "FAIL  diff-mode missing-grant case: findings=%r" % findings)
    return ok


def test_bare_diff_with_grant_passes():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.foo_bar (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "grant select, insert, update, delete on public.foo_bar to service_role;\n\n"
        "COMMIT;\n"
    )
    findings, pass_notes = check.evaluate_file("v999-foo-bar.sql", old_text, new_text)
    ok = len(findings) == 0 and len(pass_notes) == 1
    print("PASS  diff-mode: new table with explicit service_role grant -> 0 findings"
          if ok else "FAIL  diff-mode with-grant case: findings=%r pass_notes=%r" % (findings, pass_notes))
    return ok


def test_existing_table_untouched_never_flagged():
    # A pre-existing CREATE TABLE line that is NOT part of the diff's added
    # lines (old_text already contains it identically) must never surface a
    # finding -- this ratchet only inspects what a PR newly adds.
    text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.foo_bar (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "COMMIT;\n"
    )
    findings, _pass_notes = check.evaluate_file("v999-foo-bar.sql", text, text)
    ok = len(findings) == 0
    print("PASS  no-op diff (old==new) on a pre-existing CREATE TABLE -> 0 findings"
          if ok else "FAIL  no-op diff case unexpectedly flagged: findings=%r" % findings)
    return ok


def main():
    results = [
        test_self_test_passes(),
        test_bare_diff_missing_grant_fails(),
        test_bare_diff_with_grant_passes(),
        test_existing_table_untouched_never_flagged(),
    ]
    ok = all(results)
    print("-" * 78)
    print("new-table-service-role-grant-check.test.py: %d/%d passed"
          % (sum(results), len(results)))
    print("GATE: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
