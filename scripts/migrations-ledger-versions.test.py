#!/usr/bin/env python3
"""
migrations-ledger-versions.test.py -- gh-1438 part 4 regression test.

Pins the part-4 reconciliation to what production's ledger recorded
(supabase_migrations.schema_migrations, read-only, 2026-10-05T20:57Z):

  1. RENAMED: 14 Direction-2 files (a repo file with no ledger row) now carry their REAL applied ledger version.
     The old filename is gone, the new one exists, the new version is in the baseline's applied_versions and the old
     one is not.
  2. FILED: three draft sets that were applied since the last measurement (gh1314, gh1961, gh2154) are filed in
     supabase/migrations/ under their ledger version.
  3. The drafts' STATUS headers say APPLIED for those three sets (they said NOT APPLIED / unversioned before).
  4. The baseline manifest is not stale: its repo_file_no_applied_versions equals what the tree actually holds
     (a tree-vs-manifest comparison; the ledger half is the manifest's recorded query).

Negative control: run with --root pointing at origin/main before this change; every check above FAILS
(exit 1). Run:  python3 scripts/migrations-ledger-versions.test.py [--root .]
"""
import argparse, json, os, re, sys

RENAMED = [
    ("20260904132600", "20260908175940", "gh1532_claims_status_check"),
    ("20260904233727", "20260908180021", "gh1532_accept_bid_payment_guard"),
    ("20260914195746", "20260914200612", "gh1932_notify_admin_new_homeowner_triggers"),
    ("20260924160000", "20260924195135", "gh2154_p2_partner_attribution_activation"),
    ("20260924195639", "20260925012137", "gh2121_lead_goal_writeback"),
    ("20260924210000", "20260925180541", "gh2154_p4_partner_onboarding_ledger"),
    ("20260924211500", "20260925180647", "gh2154_p4_partner_onboarding_cron"),
    ("20260925012956", "20260925140409", "gh2155_hi0b_agreement_v3"),
    ("20260925020000", "20260925131220", "gh2121_lead_next_step_reminder"),
    ("20260925090000", "20260925131729", "gh2121_lead_next_step_reminder_cron"),
    ("20260925183000", "20260925185056", "gh2154_p4_switchon_retry_cap_uncertain_alert"),
    ("20260927133100", "20260927143746", "gh2238_measurement_shape_guard"),
    ("20260927133501", "20260927150342", "gh1529_r3_contractor_can_bid_and_onboarding_sends"),
    ("20260927170000", "20260928170147", "gh1883_auth_uniform_rate_limit"),
]
FILED = [
    ("20260928115913", "gh1314_persist_signed_price"),
    ("20260927183251", "gh1961_profiles_is_test_at_creation"),
    ("20260927235229", "gh2154_register_partner_rate_limit_fix"),
]
HEADERED_APPLIED = ["gh1314_persist_signed_price", "gh1961_profiles_is_test_at_creation", "gh2154_register_partner_rate_limit_fix"]
EXCLUDED = ("_rollback.sql", "_pre-flight.md")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    root = os.path.abspath(ap.parse_args().root)
    M = os.path.join(root, "supabase", "migrations")
    base = json.load(open(os.path.join(root, "supabase", "migrations-reconciliation-baseline.json"), encoding="utf-8"))
    applied = set(base["applied_versions"])
    fails = []

    def check(name, cond):
        print(("PASS: " if cond else "FAIL: ") + name)
        if not cond:
            fails.append(name)

    for old, new, slug in RENAMED:
        check(f"{slug}: old file {old}_ is gone", not os.path.exists(os.path.join(M, f"{old}_{slug}.sql")))
        check(f"{slug}: file exists at ledger version {new}", os.path.exists(os.path.join(M, f"{new}_{slug}.sql")))
        check(f"{slug}: {new} is a recorded ledger version and {old} is not", new in applied and old not in applied)
    for ver, slug in FILED:
        check(f"{slug}: filed at ledger version {ver}", os.path.exists(os.path.join(M, f"{ver}_{slug}.sql")) and ver in applied)
    for slug in HEADERED_APPLIED:
        head = open(os.path.join(root, "supabase", "migrations_drafts", slug + ".sql"), encoding="utf-8").read(400)
        check(f"drafts/{slug}.sql header says APPLIED", re.match(r"-- STATUS \(gh-1438, as of [^)]*\): APPLIED", head) is not None)

    repo = set()
    for f in os.listdir(M):
        m = re.match(r"^(\d{14})_.*\.sql$", f)
        if m and not f.endswith(EXCLUDED):
            repo.add(m.group(1))
    check("baseline repo_file_no_applied_versions equals the tree (manifest not stale)",
          sorted(repo - applied) == sorted(base["repo_file_no_applied_versions"]))
    check("repo_file_no_applied is at most 36 (it was 50 on origin/main f97f8f12)", len(repo - applied) <= 36)
    print(f"\n{len(fails)} failed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
