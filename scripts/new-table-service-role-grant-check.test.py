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


def test_quoted_cli_style_no_grant_fails():
    # PR #2201 review 5839752411, finding 1, exact repro shape: `supabase
    # db diff` emits CREATE TABLE with each identifier quoted separately,
    # "public"."foo", not one quoted span across the dot; a SEPARATE,
    # unrelated table's grant (`GRANT ALL ON public.bar TO service_role`)
    # is also present. At 9b32febd this false-PASSed: the schema-then-dot
    # group failed to match as a whole, the regex fell through to
    # capturing "public" itself as the table name, and the unrelated
    # grant's schema-qualified target (`public.bar`) word-matched "public"
    # -- so the real new table `foo`, which has no grant of its own, read
    # as covered.
    old_text = ""
    new_text = (
        'BEGIN;\n\n'
        'CREATE TABLE "public"."foo" (\n'
        '  "id" uuid NOT NULL DEFAULT gen_random_uuid()\n'
        ');\n\n'
        'grant select, insert, update, delete on public.bar to service_role;\n\n'
        'COMMIT;\n'
    )
    findings, _pass_notes = check.evaluate_file("v999-quoted-foo.sql", old_text, new_text)
    ok = len(findings) == 1 and "new-table-missing-service-role-grant" in findings[0] and "TABLE foo " in findings[0]
    print("PASS  diff-mode: CLI-quoted \"public\".\"foo\" plus an unrelated public.bar "
          "grant -> 1 finding naming foo (not credited by bar's grant)"
          if ok else "FAIL  quoted-no-grant case: findings=%r" % findings)
    return ok


def test_quoted_cli_style_with_grant_passes():
    old_text = ""
    new_text = (
        'BEGIN;\n\n'
        'CREATE TABLE "public"."foo" (\n'
        '  "id" uuid NOT NULL DEFAULT gen_random_uuid()\n'
        ');\n\n'
        'grant select, insert, update, delete on "public"."foo" to service_role;\n\n'
        'COMMIT;\n'
    )
    findings, pass_notes = check.evaluate_file("v999-quoted-foo.sql", old_text, new_text)
    ok = len(findings) == 0 and len(pass_notes) == 1
    print("PASS  diff-mode: CLI-quoted \"public\".\"foo\" with matching service_role grant -> 0 findings"
          if ok else "FAIL  quoted-with-grant case: findings=%r pass_notes=%r" % (findings, pass_notes))
    return ok


def test_name_collision_suffix_grant_fails():
    # PR #2201 review 5839752411, finding 2: grant matching must be
    # anchored to the exact identifier. At 9b32febd, `GRANT ... ON
    # public.foo_bar TO service_role` false-satisfied a check for a new
    # table literally named `bar`, because `_target_matches_table` did a
    # plain substring/word search instead of matching the full target name.
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.bar (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "grant select, insert, update, delete on public.foo_bar to service_role;\n\n"
        "COMMIT;\n"
    )
    findings, _pass_notes = check.evaluate_file("v999-bar.sql", old_text, new_text)
    ok = len(findings) == 1 and "TABLE bar " in findings[0]
    print("PASS  diff-mode: new table `bar` credited only by a `bar`-exact grant, "
          "not by unrelated `foo_bar` -> 1 finding"
          if ok else "FAIL  suffix-collision case: findings=%r" % findings)
    return ok


def test_schema_wide_grant_before_create_fails():
    # gh-2145 follow-up (Ben's REVIEW PASS 5839898750): `ALL TABLES IN
    # SCHEMA public` only reaches tables that already exist when it runs.
    # Placed BEFORE the CREATE, it does not cover this table -- and does
    # not error either, so a detector that ignores statement order would
    # false-PASS this silently-broken shape.
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;\n\n"
        "CREATE TABLE IF NOT EXISTS public.foo_bar (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "COMMIT;\n"
    )
    findings, _pass_notes = check.evaluate_file("v999-order.sql", old_text, new_text)
    ok = len(findings) == 1 and "new-table-missing-service-role-grant" in findings[0]
    print("PASS  diff-mode: schema-wide grant BEFORE the CREATE -> 1 finding "
          "(grant does not retroactively cover it)"
          if ok else "FAIL  grant-before-create case: findings=%r" % findings)
    return ok


def test_schema_wide_grant_after_create_passes():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.foo_bar (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;\n\n"
        "COMMIT;\n"
    )
    findings, pass_notes = check.evaluate_file("v999-order.sql", old_text, new_text)
    ok = len(findings) == 0 and len(pass_notes) == 1
    print("PASS  diff-mode: schema-wide grant AFTER the CREATE -> 0 findings"
          if ok else "FAIL  grant-after-create case: findings=%r pass_notes=%r" % (findings, pass_notes))
    return ok


def test_unlogged_table_needs_grant_like_any_other():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE UNLOGGED TABLE IF NOT EXISTS public.scratch_pad (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "COMMIT;\n"
    )
    findings, _pass_notes = check.evaluate_file("v999-unlogged.sql", old_text, new_text)
    ok = len(findings) == 1 and "new-table-missing-service-role-grant" in findings[0]
    print("PASS  diff-mode: UNLOGGED table with no grant -> 1 finding (UNLOGGED "
          "does not exempt it)"
          if ok else "FAIL  unlogged-no-grant case: findings=%r" % findings)
    return ok


def test_unlogged_table_with_grant_passes():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE UNLOGGED TABLE IF NOT EXISTS public.scratch_pad (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.scratch_pad TO service_role;\n\n"
        "COMMIT;\n"
    )
    findings, pass_notes = check.evaluate_file("v999-unlogged.sql", old_text, new_text)
    ok = len(findings) == 0 and len(pass_notes) == 1
    print("PASS  diff-mode: UNLOGGED table with its own service_role grant -> 0 findings"
          if ok else "FAIL  unlogged-with-grant case: findings=%r pass_notes=%r" % (findings, pass_notes))
    return ok


def test_temp_table_exempt_even_with_no_grant():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TEMP TABLE staging_scratch (\n"
        "  id UUID PRIMARY KEY DEFAULT gen_random_uuid()\n"
        ");\n\n"
        "COMMIT;\n"
    )
    findings, pass_notes = check.evaluate_file("v999-temp.sql", old_text, new_text)
    ok = len(findings) == 0 and len(pass_notes) == 0
    print("PASS  diff-mode: TEMP table, zero grants -> 0 findings, 0 pass_notes "
          "(exempt, never evaluated at all)"
          if ok else "FAIL  temp-exempt case: findings=%r pass_notes=%r" % (findings, pass_notes))
    return ok


def test_partition_parent_only_grant_fails():
    # gh-2145 follow-up: Postgres privileges are per-relation -- a grant
    # naming only the PARENT table does not cover a new partition, which
    # is its own distinct relation with its own ACL.
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.events_2027_01\n"
        "  PARTITION OF public.events\n"
        "  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');\n\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.events TO service_role;\n\n"
        "COMMIT;\n"
    )
    findings, _pass_notes = check.evaluate_file("v999-partition.sql", old_text, new_text)
    ok = (
        len(findings) == 1
        and "new-table-missing-service-role-grant" in findings[0]
        and "events_2027_01" in findings[0]
    )
    print("PASS  diff-mode: partition, grant on parent only -> 1 finding naming "
          "the partition (parent's grant does not cover it)"
          if ok else "FAIL  partition-parent-only-grant case: findings=%r" % findings)
    return ok


def test_partition_own_grant_passes():
    old_text = ""
    new_text = (
        "BEGIN;\n\n"
        "CREATE TABLE IF NOT EXISTS public.events_2027_01\n"
        "  PARTITION OF public.events\n"
        "  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');\n\n"
        "GRANT SELECT, INSERT, UPDATE, DELETE ON public.events_2027_01 TO service_role;\n\n"
        "COMMIT;\n"
    )
    findings, pass_notes = check.evaluate_file("v999-partition.sql", old_text, new_text)
    ok = len(findings) == 0 and len(pass_notes) == 1
    print("PASS  diff-mode: partition with its own service_role grant -> 0 findings"
          if ok else "FAIL  partition-own-grant case: findings=%r pass_notes=%r" % (findings, pass_notes))
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
        test_quoted_cli_style_no_grant_fails(),
        test_quoted_cli_style_with_grant_passes(),
        test_name_collision_suffix_grant_fails(),
        test_schema_wide_grant_before_create_fails(),
        test_schema_wide_grant_after_create_passes(),
        test_unlogged_table_needs_grant_like_any_other(),
        test_unlogged_table_with_grant_passes(),
        test_temp_table_exempt_even_with_no_grant(),
        test_partition_parent_only_grant_fails(),
        test_partition_own_grant_passes(),
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
