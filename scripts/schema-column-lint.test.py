#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/schema-column-lint.py's PENDING mechanism
(gh-1314 / PR #1856 REVIEW blocker 2).

WHY THIS FILE EXISTS. The linter is fail-hard on the money path, and this change
gives it a way to NOT fail: a declared, pending column. Any such escape hatch is
worth exactly as much as the tests that show it cannot be widened by accident. So
every assertion below is paired with the mutation it must catch:

  - an UNDECLARED bad column must still fail (the hatch is not a mute button);
  - a declaration naming a migration file that does not exist must fail;
  - a STALE declaration -- the column exists in the snapshot now -- must fail, so
    a gap cannot outlive itself;
  - a declared, genuinely-pending column must PASS and must print a PENDING line.

This file also removes scripts/schema-column-lint.py from LEGACY_EXEMPT in
scripts/detector-negative-control-check.py, per that gate's own instruction
("When one of these gains a <name>.test.py, remove it from here").

No network. Run: python3 scripts/schema-column-lint.test.py
"""

import json
import os
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
LINT = HERE / "schema-column-lint.py"

failures: list[str] = []


def check(name: str, got, want) -> None:
    if got != want:
        failures.append(f"{name}: got {got!r}, want {want!r}")
        print(f"FAIL  {name}: got {got!r}, want {want!r}")
    else:
        print(f"PASS  {name}")


def run_case(*, snapshot: dict, pending: dict | None, source: str, migration: bool):
    """Build a throwaway repo and run the real linter over it."""
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        (root / "sql").mkdir()
        (root / "sql" / "schema-snapshot.json").write_text(json.dumps(snapshot))
        if pending is not None:
            (root / "sql" / "schema-pending.json").write_text(json.dumps(pending))
        if migration:
            (root / "supabase" / "migrations_drafts").mkdir(parents=True)
            (root / "supabase" / "migrations_drafts" / "m.sql").write_text("-- draft\n")
        (root / "app.js").write_text(source)
        proc = subprocess.run(
            [sys.executable, str(LINT), "--root", str(root)],
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout + proc.stderr


SNAPSHOT = {"claims": ["id", "status"]}
WRITE = 'await sb.from("claims").update({ id: x, brand_new_col: y });\n'
DECL = {"claims": {"brand_new_col": {"migration": "supabase/migrations_drafts/m.sql", "issue": "#1314"}}}

print("gh-1314 / PR #1856: schema-column-lint PENDING mechanism, proof of detection")

# 1. NEGATIVE CONTROL — no declaration at all. The linter must still fail hard.
code, out = run_case(snapshot=SNAPSHOT, pending=None, source=WRITE, migration=False)
check("an UNDECLARED unknown column still FAILS the lint", code, 1)
check("... and is reported as FAIL, not PENDING", "FAIL  app.js" in out, True)

# 2. The hatch works for a real, declared gap.
code, out = run_case(snapshot=SNAPSHOT, pending=DECL, source=WRITE, migration=True)
check("a DECLARED pending column passes", code, 0)
check("... and prints a loud PENDING line", "PENDING  app.js" in out, True)
check("... naming the migration that closes it", "migrations_drafts/m.sql" in out, True)
check("... and says plainly the migration is not applied", "not applied" in out, True)

# 3. A declaration pointing at a migration that does not exist is a config error.
code, out = run_case(snapshot=SNAPSHOT, pending=DECL, source=WRITE, migration=False)
check("a declaration naming a MISSING migration fails (exit 2)", code, 2)
check("... and says why", "does not exist" in out, True)

# 4. A declaration that has gone stale must fail, so a gap cannot outlive itself.
landed = {"claims": ["id", "status", "brand_new_col"]}
code, out = run_case(snapshot=landed, pending=DECL, source=WRITE, migration=True)
check("a STALE declaration fails once the column exists", code, 2)
check("... and tells the operator to delete the entry", "STALE declaration" in out, True)

# 5. A malformed entry cannot be a silent no-op.
bad = {"claims": {"brand_new_col": {"issue": "#1314"}}}
code, _ = run_case(snapshot=SNAPSHOT, pending=bad, source=WRITE, migration=True)
check("an entry with no 'migration' key fails", code, 2)

# 6. The repo's own declarations are well-formed and every one is still pending.
repo_root = HERE.parent
decl_path = repo_root / "sql" / "schema-pending.json"
if decl_path.exists():
    snap = json.loads((repo_root / "sql" / "schema-snapshot.json").read_text())
    decl = json.loads(decl_path.read_text())
    stale = [
        f"{t}.{c}" for t, cols in decl.items() if not t.startswith("_")
        for c in cols if c in set(snap.get(t, []))
    ]
    check("no declaration in this repo has gone stale", stale, [])
    missing = [
        e["migration"] for t, cols in decl.items() if not t.startswith("_")
        for e in cols.values() if not (repo_root / e["migration"]).exists()
    ]
    check("every declared migration file exists in this repo", missing, [])

if failures:
    print(f"\n{len(failures)} assertion(s) failed")
    sys.exit(1)
print("\nall assertions passed")
