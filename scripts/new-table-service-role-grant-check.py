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

PREMISE CHECK, READ-ONLY, PROD (yeszghaspzwwstvsrioa), 2026-09-25 -- this
repo's actual current grant shape, enumerated via
`aclexplode(pg_class.relacl)` (information_schema.role_table_grants returned
zero rows for the same query -- it only shows grants visible to the querying
role, whereas aclexplode over pg_class sees everything):

  - 48 public tables currently carry an explicit anon/authenticated/
    service_role ACL entry at all (most tables get the full default grant
    silently and never show up as "explicit" in this sense).
  - Of those, 44 have BOTH anon and authenticated holding every DML
    privilege (SELECT/INSERT/UPDATE/DELETE/...) -- the Postgres-level
    default grant, unrestricted -- with RLS policies doing 100% of the real
    access control. Only 2 (ad_sharing_suppressions, lead_consents) are
    service_role-only at the grant level.
  - `partner_onboarding_sends` -- named in this issue's own body as an
    example of a table "RLS on and no policies, so it is service-role only
    anyway" -- was checked directly and does NOT match that description: it
    holds the full unrestricted default grant to anon AND authenticated
    AND service_role. It reads as service-role-only only because its RLS
    policies (or lack thereof) currently deny everything at the RLS layer,
    not because its grants are narrow. That premise in the issue body is
    corrected here rather than carried forward uncorrected into this
    detector's design.

The practical implication: TODAY, every new table's default-granted anon/
authenticated access is real at the GRANT layer and is only ever narrowed by
RLS. Come 2026-10-30, that default disappears for tables created after the
cutover -- which is a NET SECURITY IMPROVEMENT for the anon/authenticated
side (no more accidental full-table grant sitting behind RLS as the only
line of defense) but is a NET AVAILABILITY REGRESSION for `service_role`:
Edge Functions and any other server-side caller that reaches Postgres
through the Data API (PostgREST) with the service-role key depend on
`service_role` holding real table privileges, and after the cutover a new
table simply will not have them unless a migration says so explicitly.
`service_role` is also the one role every single one of this repo's tables
needs in practice (backend writes, cron jobs, admin tooling), unlike anon/
authenticated which are genuinely optional per table and already gated by
RLS design decisions this detector has no business second-guessing.

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
    schema-wide `ALL TABLES IN SCHEMA public` grant.
REVOKE statements are never treated as satisfying this (a REVOKE FROM
service_role would be a bug this detector has no opinion on beyond "still
not a satisfying GRANT").

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
CREATE_TABLE_RE = re.compile(
    r'^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?'
    r'"?(?:public\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?',
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
    # Bare or schema-qualified, quoted or not: public.table / "table" / table
    name_re = re.compile(
        r'(?:\bpublic\s*\.\s*)?"?%s"?\b' % re.escape(table), re.I
    )
    return bool(name_re.search(target_text))


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
        if m:
            new_tables.append((m.group(1), stmt.line_no))

    if not new_tables:
        return findings, pass_notes

    # Look at every GRANT statement in the WHOLE new file (not only the
    # diff-touched subset -- a pre-existing GRANT in an already-landed
    # migration is irrelevant here since the table itself is brand-new in
    # THIS file by definition; scanning the whole file just means a GRANT
    # placed slightly outside difflib's computed added-range still counts).
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
        granted_service_role_targets.append(tm.group("target"))

    for table, line_no in new_tables:
        covered = any(
            _target_matches_table(target, table)
            for target in granted_service_role_targets
        )
        if covered:
            pass_notes.append(
                "PASS  [new-table-service-role-grant] %s:%d -- CREATE TABLE %s "
                "has an explicit service_role grant in this file"
                % (file_rel, line_no, table)
            )
        else:
            findings.append(
                "FAIL  [new-table-missing-service-role-grant] %s:%d -- CREATE "
                "TABLE %s has no explicit `GRANT ... TO service_role` (or "
                "`ALL TABLES IN SCHEMA public`) in this migration. Starting "
                "2026-10-30 Supabase stops auto-granting Data API access to "
                "new public tables (gh-2145) -- service_role needs an "
                "explicit grant in this same file or Edge Functions/backend "
                "callers reaching this table via the Data API will get "
                "permission-denied." % (file_rel, line_no, table)
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
