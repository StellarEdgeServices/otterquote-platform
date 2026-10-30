#!/usr/bin/env python3
"""
new-table-truncate-revoke-check.test.py -- sibling test for scripts/new-table-truncate-revoke-check.py (gh-3256), per the
detector convention (scripts/detector-negative-control-check.py CHECK 1). Runs the fixture self-test (with its negative
control), then exercises evaluate_file's diff scoping and the git diff mode against a throwaway repository.
"""
import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("new_table_truncate_revoke_check", HERE / "new-table-truncate-revoke-check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

results = []


def report(ok, msg_ok, msg_fail):
    print(("PASS  " + msg_ok) if ok else ("FAIL  " + msg_fail))
    results.append(ok)


def test_self_test():
    report(check.self_test() == 0, "self_test() exits 0 (fixtures, negative control fires)", "self_test() failed")


def test_pre_existing_table_not_rechecked():
    # a table created in the OLD text is not new in this diff: only an unrelated added line -> no finding
    old = "CREATE TABLE public.legacy (id int);\n"
    new = old + "COMMENT ON TABLE public.legacy IS 'x';\n"
    f, _ = check.evaluate_file("v1.sql", old, new)
    report(f == [], "diff scoping: a CREATE that is not in the diff is not checked", "pre-existing CREATE flagged: %r" % f)


def test_added_create_without_revoke_fails():
    old = "SELECT 1;\n"
    new = old + "CREATE TABLE public.fresh (id int);\n"
    f, _ = check.evaluate_file("v2.sql", old, new)
    report(len(f) == 1 and "anon and authenticated" in f[0], "added CREATE without REVOKE -> 1 finding naming both roles",
           "unexpected findings %r" % f)


def test_revoke_in_untouched_region_counts():
    # the REVOKE may sit anywhere after the CREATE in the same file, not only on added lines
    old = "-- header\nREVOKE TRUNCATE ON public.fresh FROM anon, authenticated;\n"
    new = "-- header\nCREATE TABLE public.fresh (id int);\nREVOKE TRUNCATE ON public.fresh FROM anon, authenticated;\n"
    f, _ = check.evaluate_file("v3.sql", old, new)
    report(f == [], "a REVOKE after the CREATE counts even when it is not an added line", "flagged: %r" % f)


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@example.invalid", "PATH": "/usr/bin:/bin:/usr/local/bin"})


def test_diff_mode():
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "supabase/migrations").mkdir(parents=True)
        _git(root, "init", "-q", "-b", "main")
        (root / "supabase/migrations/20260101000000_old.sql").write_text("CREATE TABLE public.old_t (id int);\n")
        _git(root, "add", "-A"); _git(root, "commit", "-q", "-m", "base")
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
        (root / "supabase/migrations/20260102000000_bad.sql").write_text("CREATE TABLE public.new_bad (id int);\n")
        (root / "supabase/migrations/20260103000000_good.sql").write_text(
            "CREATE TABLE public.new_good (id int);\nREVOKE TRUNCATE ON public.new_good FROM anon, authenticated;\n")
        _git(root, "add", "-A"); _git(root, "commit", "-q", "-m", "head")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True).stdout.strip()
        f, notes, files = check.run_diff_mode(root, base, head)
        ok = (len(f) == 1 and "new_bad" in f[0] and any("new_good" in n for n in notes)
              and not any("old_t" in x for x in f + notes))
        report(ok, "diff mode: flags only the new table without a REVOKE; the base migration is never re-checked",
               "diff mode: findings=%r notes=%r files=%r" % (f, notes, files))


if __name__ == "__main__":
    test_self_test()
    test_pre_existing_table_not_rechecked()
    test_added_create_without_revoke_fails()
    test_revoke_in_untouched_region_counts()
    test_diff_mode()
    print("%d/%d passed" % (sum(results), len(results)))
    sys.exit(0 if all(results) else 1)
