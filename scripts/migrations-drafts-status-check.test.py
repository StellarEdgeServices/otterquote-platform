#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/migrations-drafts-status-check.py (gh-1438(a)).

Each assertion is paired with the mutation it must catch: a headed set passes;
a file with no header fails; a header missing one required line fails; a
missing README fails; an unknown status word fails. No network.

Run: python3 scripts/migrations-drafts-status-check.test.py
"""

import importlib.util
import pathlib
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("chk", HERE / "migrations-drafts-status-check.py")
chk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chk)

FAILS = 0


def ok(label, cond):
    global FAILS
    print(("PASS  " if cond else "FAIL  ") + label)
    if not cond:
        FAILS += 1


GOOD = (
    "-- STATUS (gh-1438, as of 2026-09-30T00:00Z): NOT APPLIED\n"
    "-- EVIDENCE: comment 1\n"
    "-- REPO COPY: none\n"
    "-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md\n"
    "select 1;\n"
)


def tree(files, readme=True):
    root = pathlib.Path(tempfile.mkdtemp())
    d = root / "supabase" / "migrations_drafts"
    d.mkdir(parents=True)
    if readme:
        (d / "README.md").write_text("rule\n")
    for n, t in files.items():
        (d / n).write_text(t)
    return str(root)


n, v = chk.check(tree({"a.sql": GOOD}))
ok("a fully headed file with a README passes", n == 1 and v == [])

n, v = chk.check(tree({"a.sql": "select 1;\n"}))
ok("a file with no header fails (4 missing lines)", n == 1 and len(v) == 4)

n, v = chk.check(tree({"a.sql": GOOD.replace("-- EVIDENCE: comment 1\n", "")}))
ok("a header missing EVIDENCE fails and names it", len(v) == 1 and "EVIDENCE" in v[0])

n, v = chk.check(tree({"a.sql": GOOD.replace("NOT APPLIED", "MAYBE")}))
ok("an unknown status word fails", len(v) == 1 and "STATUS" in v[0])

n, v = chk.check(tree({"a.sql": GOOD}, readme=False))
ok("a missing README fails", len(v) == 1 and "README.md" in v[0])

md = "<!--\n" + GOOD.replace("-- ", "").replace("select 1;\n", "") + "-->\n# Pre-flight\n"
n, v = chk.check(tree({"a_pre-flight.md": md}))
ok("an HTML-comment header on a .md file passes", n == 1 and v == [])

late = "\n" * 20 + GOOD
n, v = chk.check(tree({"a.sql": late}))
ok("a header buried below line 12 fails (must be at the top)", len(v) == 4)

print()
print("all assertions passed" if FAILS == 0 else f"{FAILS} assertion(s) FAILED")
sys.exit(1 if FAILS else 0)
