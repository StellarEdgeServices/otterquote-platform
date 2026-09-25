#!/usr/bin/env python3
r"""
new-table-service-role-grant-check.py -- gh-2145 CI gate: fail a migration that
CREATEs a new `public` schema table without an explicit GRANT naming
`service_role` for that table (or a schema-wide `ALL TABLES IN SCHEMA public`
grant covering it), in the SAME migration file.

WHY THIS EXISTS (gh-2145)
--------------------------
Supabase vendor notice (received 2026-09-23, noreply@supabase.com): on
2026-10-30 Supabase stops auto-granting Data API (PostgREST) access to any
NEW table created in `public`. Existing tables keep whatever they already
have. The vendor's own required shape for a table that still needs Data API
reach is:

    grant select on public.your_table to anon;
    grant select, insert, update, delete on public.your_table to authenticated;
    grant select, insert, update, delete on public.your_table to service_role;

PREMISE CHECK, READ-ONLY, PROD (yeszghaspzwwstvsrioa) -- re-verified
2026-09-25 against PR #2201 review 5839752411, which correctly flagged the
first version of this docstring's "44 of 48, only 2 narrow" claim as false
(it conflated "has SELECT" with "has every DML privilege"). Re-measured via
the Management API (`POST
https://api.supabase.com/v1/projects/yeszghaspzwwstvsrioa/database/query`,
`read_only: true`) using `aclexplode(pg_class.relacl)` grouped per
table/grantee/privilege (query and full raw counts, plus the
information_schema.role_table_grants discrepancy, are in
Docs/sql-migration-conventions.md's "Premise correction" section --
summary here):

  - 48 public tables currently carry an explicit anon/authenticated/
    service_role ACL entry at all (most tables get the full default grant
    silently and never show up as "explicit" in this sense).
  - anon: SELECT on 44 of those, but full SELECT/INSERT/UPDATE/DELETE on
    only 16. authenticated: full DML on 44, at least SELECT on 46.
    service_role: an explicit grant on all 48, full DML on 47. So roughly
    two-thirds of tables with any explicit anon grant are ALREADY narrowed
    below full DML -- RLS is not the only fence for most tables, contrary
    to this docstring's original claim.
  - `partner_onboarding_sends` -- named in this issue's own body as an
    example of a table "RLS on and no policies, so it is service-role only
    anyway" -- was checked directly and does NOT match that description: it
    holds the full unrestricted default grant to anon AND authenticated
    AND service_role. It reads as service-role-only only because its RLS
    policies (or lack thereof) currently deny everything at the RLS layer,
    not because its grants are narrow. That premise in the issue body is
    corrected here rather than carried forward uncorrected into this
    detector's design. (This part of the original write-up was and remains
    correct -- only the 44/2 tally above was wrong.)

The practical implication: TODAY, a new table's default grant to
anon/authenticated is real at the GRANT layer only until narrowed, and many
tables already ARE narrowed by an explicit grant rather than by relying on
RLS alone. Come 2026-10-30, the default itself disappears for tables created
after the cutover -- a net security improvement for any new table that
would otherwise have inherited the old wide-open default -- but is a NET
AVAILABILITY REGRESSION for `service_role`: Edge Functions and any other
server-side caller that reaches Postgres through the Data API (PostgREST)
with the service-role key depend on `service_role` holding real table
privileges, and after the cutover a new table simply will not have them
unless a migration says so explicitly. `service_role` is also the one role
every single one of this repo's tables needs in practice (backend writes,
cron jobs, admin tooling), unlike anon/authenticated which are genuinely
optional per table and already gated by RLS/grant design decisions this
detector has no business second-guessing.

SCOPE OF THIS DETECTOR (deliberately narrower than the vendor's 3-role
template)
--------------------------------------------------------------------------
This detector requires an explicit `service_role` grant on every new public
table and nothing more, for two reasons:

  1. `service_role` is universally needed (see above) and is the one role
     on scripts/permissions-ratchet.py's ALLOWLISTED_GRANT_ROLES -- a
     migration granting only service_role NEVER needs the
     `permissions-ratchet: reviewed` bypass label and never produces a
     BYPASSED finding there. Anon/authenticated are genuinely optional
     per-table product decisions (whether the Data API should reach a
     table directly vs. only through an Edge Function using service_role)
     that this repo's migration authors make case by case; a blanket "every
     new table must GRANT anon+authenticated too" rule would be WRONG for
     any table that is meant to be service-role-only (the correct shape
     post-cutover is to grant NOTHING to anon/authenticated at all, not to
     grant and then rely on RLS the way the pre-cutover default silently
     did).
  2. When a migration DOES grant anon or authenticated, that is
     permissions-ratchet's rule 1 job to gate (allowlist / bypass label) --
     duplicating that gate here would be two detectors disagreeing about
     the same statement. This detector only ever asserts a MINIMUM
     (service_role present), never a maximum, so the two gates cannot
     contradict each other on the same PR.

RATCHET, NOT A SCANNER -- same scope discipline as permissions-ratchet.py
(gh-1767): only CREATE TABLE statements a PR's diff newly ADDS to
`supabase/migrations/**/*.sql` are inspected; the repo's 150+ pre-existing
migrations are never retroactively failed. Reuses permissions-ratchet.py's
own comment/string-stripping, statement-splitting, and git-diff machinery
directly (imported via importlib, since its filename is not a valid Python
module identifier) rather than re-implementing SQL parsing a second time --
any correctness fix to that stripping logic benefits both gates for free.

WHAT COUNTS AS "explicit service_role grant covering this table"
-------------------------------------------------------------------------
A GRANT statement anywhere in the SAME new/changed migration file (not
required to be one of the diff-added lines itself -- a table created fresh
in this file has its whole CREATE TABLE block newly added anyway, and this
avoids a false negative if a GRANT line happens to sit just outside the
difflib-computed added range for formatting reasons) whose:
  - role list (parsed the same way as permissions-ratchet's extract_roles)
    includes `service_role`, AND
  - target (the text between GRANT ... ON [TABLE] and TO) either names the
    new table directly (schema-qualified or bare, quoted or not) or is a
    schema-wide `ALL TABLES IN SCHEMA public` grant, AND
  - the GRANT statement's own line is AFTER the CREATE TABLE statement's
    line in the same file (see "ORDERING MATTERS" below).
REVOKE statements are never treated as satisfying this (a REVOKE FROM
service_role would be a bug this detector has no opinion on beyond "still
not a satisfying GRANT").

ORDERING MATTERS (gh-2145 follow-up, Ben's REVIEW PASS 5839898750)
-------------------------------------------------------------------------
`GRANT ... ON ALL TABLES IN SCHEMA public TO service_role;` only ever
applies, per Postgres semantics, to tables that ALREADY EXIST at the
moment that statement runs. A schema-wide grant placed BEFORE a
`CREATE TABLE` in the same file therefore does NOT cover that table --
Postgres does not retroactively apply it, and the statement does not
error either, so this is a silent gap, not something the migration itself
would fail on. A grant that names the new table directly has the same
requirement in principle (`GRANT ... ON public.foo` errors outright if
`foo` does not exist yet, so in practice this case would already surface
as a broken migration) -- ordering is still checked for both forms, for
one uniform rule and because a fixed migration file is not a place to
special-case "this GRANT shape errors first, this one fails silently".
Concretely: a covering GRANT's own statement line number must be strictly
greater than the CREATE TABLE statement's line number, in the same file.

UNLOGGED / TEMP / PARTITION OF (gh-2145 follow-up)
-------------------------------------------------------------------------
  - `CREATE UNLOGGED TABLE ...` is treated exactly like a normal
    `CREATE TABLE` -- UNLOGGED only changes WAL durability, not the
    Data-API grant story, so it still needs an explicit service_role
    grant (or schema-wide coverage) like any other new table.
  - `CREATE [GLOBAL|LOCAL] {TEMP|TEMPORARY} TABLE ...` is EXEMPT --
    temp tables live in a per-session `pg_temp` schema, are invisible to
    other sessions/roles including the Data API, and are gone at
    session/transaction end, so a Data-API grant on one is meaningless.
    These are never added to `new_tables` and never produce a finding.
  - `CREATE TABLE foo PARTITION OF parent ...` is NOT exempt, and a grant
    that names only the PARENT table does NOT cover the partition:
    Postgres privileges are per-relation, and a partition is its own
    relation with its own ACL, distinct from its parent's. A partition
    needs its own explicit `GRANT ... ON <partition> TO service_role` (a
    schema-wide `ALL TABLES IN SCHEMA public` grant still covers it, same
    as any other table in that schema, since that form names no specific
    relation at all).

USAGE
    python scripts/new-table-service-role-grant-check.py --self-test
    python scripts/new-table-service-role-grant-check.py --base <ref> --head <ref> [--root PATH] [--json]
    python scripts/new-table-service-role-grant-check.py --check-file PATH [PATH ...] [--json]

EXIT
    0  GATE: PASS -- every new public table has an explicit service_role grant.
    1  GATE: FAIL -- at least one new public table is missing one.
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

# ---------------------------------------------------------------------------
# Reuse permissions-ratchet.py's parsing/diff machinery directly rather than
# re-implementing SQL-comment/string stripping and statement-splitting a
# second time. Loaded via importlib because "permissions-ratchet" (hyphens)
# is not an importable module name.
# ---------------------------------------------------------------------------
_PR_PATH = HERE / "permissions-ratchet.py"
_spec = importlib.util.spec_from_file_location("permissions_ratchet", _PR_PATH)
pr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pr)

MIGRATIONS_PATH_RE = pr.MIGRATIONS_PATH_RE

# ---------------------------------------------------------------------------
# Detector-specific regexes
# ---------------------------------------------------------------------------
DELIM_RE = r'[A-Za-z_][A-Za-z0-9_]*'
CREATE_TABLE_RE = re.compile(
    r'^\s*CREATE\s+'
    # Optional TEMP/TEMPORARY (with an optional GLOBAL/LOCAL prefix, both
    # no-ops in modern Postgres but still legal syntax) or UNLOGGED --
    # mutually exclusive modifiers between CREATE and TABLE. `temp` is
    # checked by the caller to exempt session-local tables entirely;
    # `unlogged` is captured only so callers can see it was present, since
    # UNLOGGED tables are otherwise treated exactly like a normal table.
    r'(?:(?:GLOBAL|LOCAL)\s+)?'
    r'(?:(?P<temp>TEMP(?:ORARY)?)\s+|(?P<unlogged>UNLOGGED)\s+)?'
    r'TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?'
    # Optional schema qualifier: quoted or bare identifier, then a dot.
    # The closing quote (if any) on the schema part must land BEFORE the
    # dot -- "public"."foo" quotes each identifier separately, it is not
    # one quoted span covering "public"."foo". Matching the quote and the
    # dot as one contiguous group (the old regex's bug) let a CLI-quoted
    # `"public"."foo"` skip the whole schema group as a non-match and then
    # capture "public" itself as the table name.
    r'(?:"?(?P<schema>%s)"?\s*\.\s*)?'
    r'"?(?P<table>%s)"?'
    # `CREATE TABLE foo PARTITION OF parent ...` -- captured so the caller
    # can tell a partition from a plain table; the parent's own name is
    # captured too, purely for diagnostics/pass-note text (a parent's
    # grant does NOT cover the partition -- see module docstring -- so
    # this detector never uses parent_table to satisfy coverage).
    r'(?:\s+PARTITION\s+OF\s+'
    r'(?:"?(?P<parent_schema>%s)"?\s*\.\s*)?"?(?P<parent_table>%s)"?)?'
    % (DELIM_RE, DELIM_RE, DELIM_RE, DELIM_RE),
    re.I,
)
# A GRANT target list can hold multiple comma-separated objects
# (`GRANT ... ON foo, bar TO service_role`); each one is matched against
# this per-target regex, never as one big substring search, so a name that
# merely contains the table name as a substring (foo_bar vs bar) or lives
# in a different schema/object-kind never counts as a match.
TARGET_NAME_RE = re.compile(
    r'^\s*(?:"?(?P<schema>%s)"?\s*\.\s*)?"?(?P<name>%s)"?\s*$' % (DELIM_RE, DELIM_RE),
    re.I,
)
NON_TABLE_TARGET_PREFIX_RE = re.compile(
    r'^\s*(SEQUENCE|FUNCTION|PROCEDURE|SCHEMA|DATABASE|VIEW|MATERIALIZED\s+VIEW)\b',
    re.I,
)
GRANT_TARGET_RE = re.compile(
    r"\bGRANT\b.*?\bON\s+(?:TABLE\s+)?(?P<target>.+?)\bTO\b", re.I | re.S
)
ALL_TABLES_SCHEMA_RE = re.compile(
    r"\bALL\s+TABLES\s+IN\s+SCHEMA\s+public\b", re.I
)


def _target_matches_table(target_text: str, table: str) -> bool:
    if ALL_TABLES_SCHEMA_RE.search(target_text):
        return True
    if NON_TABLE_TARGET_PREFIX_RE.match(target_text):
        # `GRANT ... ON SEQUENCE public.foo_id_seq TO service_role` (or a
        # FUNCTION/SCHEMA/etc. grant) is not a table grant at all, even if
        # the sequence/function happens to be named after the table.
        return False
    # A target list is comma-separated objects, each matched exactly --
    # never a substring search, so `foo_bar` never satisfies `bar` and a
    # bare name is only accepted when its schema (if any) is public/absent.
    for raw in target_text.split(","):
        m = TARGET_NAME_RE.match(raw)
        if not m:
            continue
        schema = m.group("schema")
        if schema is not None and schema.strip('"').lower() != "public":
            continue
        if m.group("name").strip('"').lower() == table.strip('"').lower():
            return True
    return False


def find_new_tables_missing_service_role_grant(file_rel: str, old_text: str, new_text: str):
    """Returns (findings: list[str], pass_notes: list[str])."""
    findings = []
    pass_notes = []

    added_lines = pr.diff_added_line_numbers(old_text or "", new_text)
    if not added_lines:
        return findings, pass_notes

    touched = pr.statements_touched_by_diff(new_text, added_lines)

    new_tables = []
    for stmt in touched:
        m = CREATE_TABLE_RE.match(stmt.stripped)
        if not m:
            continue
        if m.group("temp"):
            # Session-local temp tables are invisible outside the creating
            # session (including to the Data API), so a service_role grant
            # on one is meaningless. Exempt entirely -- never added to
            # new_tables, never produces a finding or a pass note.
            continue
        schema = m.group("schema")
        if schema is not None and schema.strip('"').lower() != "public":
            # Out of scope: this detector only ever asserted the public
            # schema (see module docstring); a schema-qualified
            # CREATE TABLE naming some other schema is not this gate's
            # business and must never be checked under its own name.
            continue
        is_partition = m.group("parent_table") is not None
        new_tables.append((m.group("table"), stmt.line_no, is_partition))

    if not new_tables:
        return findings, pass_notes

    # Look at every GRANT statement in the WHOLE new file (not only the
    # diff-touched subset -- a pre-existing GRANT in an already-landed
    # migration is irrelevant here since the table itself is brand-new in
    # THIS file by definition; scanning the whole file just means a GRANT
    # placed slightly outside difflib's computed added-range still counts).
    # Each grant's own line_no is kept alongside its target so coverage can
    # be denied when the GRANT sits BEFORE the CREATE TABLE it would need
    # to cover (see "ORDERING MATTERS" in the module docstring) -- this
    # matters most for `ALL TABLES IN SCHEMA public`, which only reaches
    # tables that already exist when it runs.
    stripped_full = pr.strip_noise(new_text)
    all_statements = pr.split_statements(new_text, stripped_full)

    granted_service_role_targets = []
    for stmt in all_statements:
        if pr.REVOKE_RE.search(stmt.stripped):
            continue
        if not pr.GRANT_RE.search(stmt.stripped):
            continue
        roles = [r.lower() for r in pr.extract_roles(stmt)]
        if "service_role" not in roles:
            continue
        tm = GRANT_TARGET_RE.search(stmt.stripped)
        if not tm:
            continue
        granted_service_role_targets.append((tm.group("target"), stmt.line_no))

    for table, line_no, is_partition in new_tables:
        # A partition is its own relation with its own ACL -- a grant that
        # names only the parent table does NOT satisfy this. Since
        # `_target_matches_table` matches the partition's own name (never
        # the parent's), a parent-only grant simply never matches here;
        # nothing extra is needed to enforce that beyond capturing the
        # partition's own name as `table` above.
        covered = any(
            grant_line_no > line_no and _target_matches_table(target, table)
            for target, grant_line_no in granted_service_role_targets
        )
        if covered:
            pass_notes.append(
                "PASS  [new-table-service-role-grant] %s:%d -- CREATE TABLE %s "
                "%shas an explicit service_role grant in this file (after "
                "the CREATE, per Postgres ordering)"
                % (file_rel, line_no, table, "(partition) " if is_partition else "")
            )
        else:
            reason = (
                "no explicit `GRANT ... TO service_role` (or `ALL TABLES IN "
                "SCHEMA public`) AFTER this CREATE in this migration -- a "
                "GRANT before the CREATE, or one naming only a parent table "
                "for this partition, does not cover it"
                if is_partition
                else
                "no explicit `GRANT ... TO service_role` (or `ALL TABLES IN "
                "SCHEMA public`) AFTER this CREATE in this migration -- a "
                "schema-wide grant placed BEFORE the CREATE does not cover "
                "a table that does not exist yet"
            )
            findings.append(
                "FAIL  [new-table-missing-service-role-grant] %s:%d -- CREATE "
                "TABLE %s%s has %s. Starting 2026-10-30 Supabase stops "
                "auto-granting Data API access to new public tables "
                "(gh-2145) -- service_role needs an explicit grant in this "
                "same file, after the CREATE, or Edge Functions/backend "
                "callers reaching this table via the Data API will get "
                "permission-denied."
                % (file_rel, line_no, table, " (partition)" if is_partition else "", reason)
            )

    return findings, pass_notes


def evaluate_file(file_rel: str, old_text: str, new_text: str):
    return find_new_tables_missing_service_role_grant(file_rel, old_text, new_text)


def run_diff_mode(root: Path, base: str, head: str):
    files = pr.changed_migration_files(root, base, head)
    all_findings = []
    all_pass_notes = []
    files_inspected = []
    for f in files:
        old_text = pr.git_show(root, base, f) or ""
        new_text = pr.git_show(root, head, f)
        if new_text is None:
            continue
        files_inspected.append(f)
        findings, pass_notes = evaluate_file(f, old_text, new_text)
        all_findings.extend(findings)
        all_pass_notes.extend(pass_notes)
    return all_findings, all_pass_notes, files_inspected


def run_check_file_mode(paths):
    all_findings = []
    all_pass_notes = []
    files_inspected = []
    for p in paths:
        path = Path(p)
        text = path.read_text(encoding="utf-8")
        rel = path.name
        files_inspected.append(rel)
        findings, pass_notes = evaluate_file(rel, "", text)
        all_findings.extend(findings)
        all_pass_notes.extend(pass_notes)
    return all_findings, all_pass_notes, files_inspected


def build_result(findings, pass_notes, files_inspected):
    verdict = "FAIL" if findings else "PASS"
    return {
        "verdict": verdict,
        "code": 1 if findings else 0,
        "files_inspected": files_inspected,
        "fail_count": len(findings),
        "findings": findings,
        "pass_notes": pass_notes,
    }


def print_report(result: dict):
    print("=" * 78)
    print("new-table-service-role-grant-check (gh-2145) -- new public tables")
    print("must GRANT service_role explicitly (Supabase Data-API default-grant")
    print("cutover, 2026-10-30)")
    print("=" * 78)
    print("files inspected: %d -- %s" % (
        len(result["files_inspected"]), ", ".join(result["files_inspected"]) or "(none)"
    ))
    for line in result["pass_notes"]:
        print(line)
    if result["findings"]:
        print("-" * 78)
        for line in result["findings"]:
            print(line)
    print("-" * 78)
    print("fail_count=%d" % result["fail_count"])
    print("GATE: %s" % result["verdict"])


# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------
FIXTURES_DIR = HERE / "new-table-service-role-grant-fixtures"
FIXTURE_META_RE = re.compile(
    r"^--\s*GRANT-CHECK-FIXTURE:\s*EXPECT=(PASS|FAIL)\s*$", re.M
)


def load_fixture(path: Path):
    text = path.read_text(encoding="utf-8")
    m = FIXTURE_META_RE.search(text)
    if not m:
        raise ValueError(
            "%s missing a '-- GRANT-CHECK-FIXTURE: EXPECT=PASS|FAIL' marker line" % path
        )
    return m.group(1), text


def self_test():
    if not FIXTURES_DIR.is_dir():
        print("FAIL  no fixtures directory found at %s" % FIXTURES_DIR)
        return 1

    total = 0
    failures = 0
    saw_fail_verdict = False
    for path in sorted(FIXTURES_DIR.glob("*.sql")):
        total += 1
        try:
            expect, text = load_fixture(path)
        except ValueError as exc:
            print("FAIL  %s" % exc)
            failures += 1
            continue

        findings, _pass_notes = evaluate_file(path.name, "", text)
        actual = "FAIL" if findings else "PASS"
        if actual == "FAIL":
            saw_fail_verdict = True

        if actual == expect:
            print(
                "PASS  %-55s expected=%s actual=%s (findings=%d)"
                % (path.name, expect, actual, len(findings))
            )
        else:
            failures += 1
            print(
                "FAIL  %-55s expected=%s actual=%s -- self-test mismatch:"
                % (path.name, expect, actual)
            )
            for f in findings:
                print("      " + f)

    # Detector Negative Control Gate (gh-1738): this self-test must actually
    # OBSERVE the detector reject its own bad fixture at least once, not
    # merely assert PASS==PASS on every fixture by construction.
    if not saw_fail_verdict:
        failures += 1
        print(
            "FAIL  negative control never fired -- no fixture produced a FAIL "
            "verdict; this self-test would pass even if the detector always "
            "returned PASS"
        )

    print("-" * 78)
    print("self-test: %d fixture(s), %d mismatch(es), negative_control_fired=%s"
          % (total, failures, saw_fail_verdict))
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
        findings, pass_notes, files_inspected = run_check_file_mode(args.check_file)
    elif args.base and args.head:
        root = Path(args.root).resolve()
        findings, pass_notes, files_inspected = run_diff_mode(root, args.base, args.head)
    else:
        parser.error(
            "must pass either --self-test, --check-file PATH..., or --base REF --head REF"
        )
        return 2

    result = build_result(findings, pass_notes, files_inspected)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result)
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
