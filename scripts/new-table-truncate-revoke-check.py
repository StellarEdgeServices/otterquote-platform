#!/usr/bin/env python3
r"""
new-table-truncate-revoke-check.py -- gh-3256 CI gate: fail a migration that
CREATEs a new `public` table without, later in the SAME file, revoking
TRUNCATE on it from BOTH `anon` and `authenticated`.

WHY THIS EXISTS (gh-3256, follow-up to #3240 / PR #3252)
---------------------------------------------------------
Production `pg_default_acl` (read-only, 2026-10-30, project
yeszghaspzwwstvsrioa) gives every new table in `public` `arwdDxtm` for anon
and authenticated, for both default-ACL owners `postgres` and
`supabase_admin`. `D` is TRUNCATE, which RLS does not police. A table created
after #3252 therefore gets client TRUNCATE back.

The draft migration supabase/migrations_drafts/gh3256_default_privs_no_client_truncate.sql
fixes the `postgres` defaults (`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN
SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated`). It CANNOT
fix `supabase_admin`'s. The migration role `postgres` is not a superuser and
is not a member of `supabase_admin` (pg_has_role = false in production), and
ALTER DEFAULT PRIVILEGES FOR ROLE x requires membership in x. The throwaway
proof shows the 42501. Any table created as `supabase_admin` (or created
before the draft is applied) still inherits `D`. #3256 names this gate as the
fallback for exactly that case.

RULE
----
For every `CREATE [UNLOGGED] TABLE [IF NOT EXISTS] [public.]name` (including
`PARTITION OF`) that a PR's diff newly adds to `supabase/migrations/**/*.sql`
(TEMP tables exempt; other schemas out of scope), each of `anon` and
`authenticated` must end the file revoked, meaning that after the CREATE:
  - some REVOKE whose privilege list includes TRUNCATE or ALL [PRIVILEGES],
    on that table (exact name, public or bare, quoted or not) or on
    `ALL TABLES IN SCHEMA public`, lists the role in its FROM clause; and
  - no LATER GRANT whose privilege list includes TRUNCATE or ALL, on that
    table or on `ALL TABLES IN SCHEMA public`, names that role or PUBLIC
    (that would hand TRUNCATE back).
`REVOKE GRANT OPTION FOR ...` does not count: it leaves the privilege.
A REVOKE placed BEFORE the CREATE does not count: the table did not exist.
`ALTER DEFAULT PRIVILEGES ...` statements are not table statements, so they
neither satisfy nor break the rule.

Ratchet, not a scanner: same diff scoping and SQL stripping as
permissions-ratchet.py and new-table-service-role-grant-check.py (imported),
so the repo's existing migrations are never failed retroactively.

USAGE
    python scripts/new-table-truncate-revoke-check.py --self-test
    python scripts/new-table-truncate-revoke-check.py --base <ref> --head <ref> [--root PATH] [--json]
    python scripts/new-table-truncate-revoke-check.py --check-file PATH [PATH ...] [--json]

EXIT
    0  GATE: PASS
    1  GATE: FAIL -- at least one new public table leaves TRUNCATE with anon or authenticated.
    2  Usage error.
"""
import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pr = _load("permissions_ratchet", "permissions-ratchet.py")
srg = _load("new_table_service_role_grant_check", "new-table-service-role-grant-check.py")

CLIENT_ROLES = ("anon", "authenticated")
ALTER_DEFAULT_RE = re.compile(r"^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b", re.I)
GRANT_OPTION_FOR_RE = re.compile(r"^\s*REVOKE\s+GRANT\s+OPTION\s+FOR\b", re.I)
# privileges ... ON target ... TO|FROM roles
REVOKE_SHAPE_RE = re.compile(
    r"^\s*REVOKE\s+(?P<privs>.+?)\s+ON\s+(?:TABLE\s+)?(?P<target>.+?)\s+FROM\s+(?P<roles>.+?)\s*(?:\b(?:CASCADE|RESTRICT)\b\s*)?;?\s*$",
    re.I | re.S,
)
GRANT_SHAPE_RE = re.compile(
    r"^\s*GRANT\s+(?P<privs>.+?)\s+ON\s+(?:TABLE\s+)?(?P<target>.+?)\s+TO\s+(?P<roles>.+?)\s*(?:\bWITH\s+GRANT\s+OPTION\b\s*)?;?\s*$",
    re.I | re.S,
)
TRUNCATE_OR_ALL_RE = re.compile(r"\b(TRUNCATE|ALL)\b", re.I)


def _roles(text):
    out = []
    for tok in re.split(r"[,\s]+", text):
        tok = tok.strip().strip('"').strip().lower()
        if tok and tok not in ("cascade", "restrict", "granted", "by"):
            out.append(tok)
    return out


def _covers_truncate(privs):
    # strip any column list "(a, b)" -- a column privilege is never TRUNCATE
    return bool(TRUNCATE_OR_ALL_RE.search(re.sub(r"\([^)]*\)", " ", privs)))


def find_new_tables_keeping_client_truncate(file_rel, old_text, new_text):
    findings, pass_notes = [], []
    added = pr.diff_added_line_numbers(old_text or "", new_text)
    if not added:
        return findings, pass_notes
    new_tables = []
    for stmt in pr.statements_touched_by_diff(new_text, added):
        m = srg.CREATE_TABLE_RE.match(stmt.stripped)
        if not m or m.group("temp"):
            continue
        schema = m.group("schema")
        if schema is not None and schema.strip('"').lower() != "public":
            continue
        new_tables.append((m.group("table"), stmt.line_no, m.group("parent_table") is not None))
    if not new_tables:
        return findings, pass_notes

    events = []  # (line_no, kind 'revoke'|'grant', target, roles)
    for stmt in pr.split_statements(new_text, pr.strip_noise(new_text)):
        s = stmt.stripped
        if ALTER_DEFAULT_RE.match(s):
            continue
        if re.match(r"^\s*REVOKE\b", s, re.I):
            if GRANT_OPTION_FOR_RE.match(s):
                continue
            rm = REVOKE_SHAPE_RE.match(s)
            if rm and _covers_truncate(rm.group("privs")):
                events.append((stmt.line_no, "revoke", rm.group("target"), _roles(rm.group("roles"))))
        elif re.match(r"^\s*GRANT\b", s, re.I):
            gm = GRANT_SHAPE_RE.match(s)
            if gm and _covers_truncate(gm.group("privs")):
                events.append((stmt.line_no, "grant", gm.group("target"), _roles(gm.group("roles"))))

    for table, line_no, is_partition in new_tables:
        state = {r: False for r in CLIENT_ROLES}
        for ev_line, kind, target, roles in sorted(events, key=lambda e: e[0]):
            if ev_line <= line_no or not srg._target_matches_table(target, table):
                continue
            for r in CLIENT_ROLES:
                if kind == "revoke" and r in roles:
                    state[r] = True
                elif kind == "grant" and (r in roles or "public" in roles):
                    state[r] = False
        missing = [r for r in CLIENT_ROLES if not state[r]]
        label = "%s%s" % (table, " (partition)" if is_partition else "")
        if missing:
            findings.append(
                "FAIL  [new-table-client-truncate] %s:%d -- CREATE TABLE %s leaves TRUNCATE with %s. "
                "Production's default ACL hands every new public table arwdDxtm to anon and authenticated, "
                "and supabase_admin's defaults cannot be changed by the migration role (gh-3256). Add, after "
                "the CREATE (and after any GRANT ALL / GRANT TRUNCATE): "
                "REVOKE TRUNCATE ON public.%s FROM anon, authenticated;"
                % (file_rel, line_no, label, " and ".join(missing), table.strip('"'))
            )
        else:
            pass_notes.append(
                "PASS  [new-table-client-truncate] %s:%d -- CREATE TABLE %s: TRUNCATE revoked from anon and "
                "authenticated after the CREATE, and not granted back" % (file_rel, line_no, label)
            )
    return findings, pass_notes


def evaluate_file(file_rel, old_text, new_text):
    return find_new_tables_keeping_client_truncate(file_rel, old_text, new_text)


def run_diff_mode(root, base, head):
    applied = pr.load_applied_versions(root, base)
    findings, notes, files = [], [], []
    for new_path, old_path in pr.changed_migration_files(root, base, head, applied):
        old_text = pr.git_show(root, base, old_path or new_path) or ""
        new_text = pr.git_show(root, head, new_path)
        if new_text is None:
            continue
        files.append(new_path)
        f, n = evaluate_file(new_path, old_text, new_text)
        findings.extend(f)
        notes.extend(n)
    return findings, notes, files


def run_check_file_mode(paths):
    findings, notes, files = [], [], []
    for p in paths:
        path = Path(p)
        files.append(path.name)
        f, n = evaluate_file(path.name, "", path.read_text(encoding="utf-8"))
        findings.extend(f)
        notes.extend(n)
    return findings, notes, files


def build_result(findings, notes, files):
    return {"verdict": "FAIL" if findings else "PASS", "code": 1 if findings else 0,
            "files_inspected": files, "fail_count": len(findings), "findings": findings, "pass_notes": notes}


def print_report(result):
    print("=" * 78)
    print("new-table-truncate-revoke-check (gh-3256) -- new public tables must")
    print("REVOKE TRUNCATE from anon and authenticated")
    print("=" * 78)
    print("files inspected: %d -- %s" % (len(result["files_inspected"]), ", ".join(result["files_inspected"]) or "(none)"))
    for line in result["pass_notes"]:
        print(line)
    if result["findings"]:
        print("-" * 78)
        for line in result["findings"]:
            print(line)
    print("-" * 78)
    print("fail_count=%d" % result["fail_count"])
    print("GATE: %s" % result["verdict"])


FIXTURES_DIR = HERE / "new-table-truncate-revoke-fixtures"
FIXTURE_META_RE = re.compile(r"^--\s*TRUNCATE-CHECK-FIXTURE:\s*EXPECT=(PASS|FAIL)\s*$", re.M)


def self_test():
    if not FIXTURES_DIR.is_dir():
        print("FAIL  no fixtures directory found at %s" % FIXTURES_DIR)
        return 1
    total = failures = 0
    saw_fail = saw_pass = False
    for path in sorted(FIXTURES_DIR.glob("*.sql")):
        total += 1
        text = path.read_text(encoding="utf-8")
        m = FIXTURE_META_RE.search(text)
        if not m:
            print("FAIL  %s missing a '-- TRUNCATE-CHECK-FIXTURE: EXPECT=PASS|FAIL' marker" % path.name)
            failures += 1
            continue
        expect = m.group(1)
        findings, _ = evaluate_file(path.name, "", text)
        actual = "FAIL" if findings else "PASS"
        saw_fail |= actual == "FAIL"
        saw_pass |= actual == "PASS"
        if actual == expect:
            print("PASS  %-55s expected=%s actual=%s (findings=%d)" % (path.name, expect, actual, len(findings)))
        else:
            failures += 1
            print("FAIL  %-55s expected=%s actual=%s -- self-test mismatch:" % (path.name, expect, actual))
            for f in findings:
                print("      " + f)
    # Detector Negative Control Gate (gh-1738): the detector must be OBSERVED rejecting a bad fixture.
    if not saw_fail:
        failures += 1
        print("FAIL  negative control never fired -- no fixture produced a FAIL verdict")
    if not saw_pass:
        failures += 1
        print("FAIL  no fixture produced a PASS verdict -- a detector that always fails is not a detector")
    print("-" * 78)
    print("self-test: %d fixture(s), %d mismatch(es), negative_control_fired=%s" % (total, failures, saw_fail))
    print("GATE: %s" % ("FAIL" if failures or total == 0 else "PASS"))
    return 1 if (failures or total == 0) else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--check-file", nargs="+", default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.check_file:
        findings, notes, files = run_check_file_mode(args.check_file)
    elif args.base and args.head:
        findings, notes, files = run_diff_mode(Path(args.root).resolve(), args.base, args.head)
    else:
        parser.error("must pass either --self-test, --check-file PATH..., or --base REF --head REF")
        return 2
    result = build_result(findings, notes, files)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result)
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
