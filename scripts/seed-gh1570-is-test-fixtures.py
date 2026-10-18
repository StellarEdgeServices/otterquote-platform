#!/usr/bin/env python3
"""
seed-gh1570-is-test-fixtures.py -- is_test fixtures for the #1570 documents_needed stall test.

Refs #1570. Ben's ruling (comment 6202791900): Marty may seed THREE is_test
fixtures once, record every created id on the issue, and no email may go to a
real address. The fixtures let one send-homeowner-next-steps cron tick be
observed against the closes-on criterion (comment 5764786813, widened by
5965042243):

  draft   claim, status 'draft', checklist complete BY COLUMNS (cash:
          has_measurements + has_material_selection), last updated 3 h ago.
          Expected in the function's dry_run preview: selected for the
          checklist-stage nudge (checklist_complete_would_send).
  stalled claim, status 'documents_needed', ready_for_bids false, a
          checklist_complete activity_log row 3 h old.
          Expected in the dry_run preview: selected for the checklist-stage
          nudge.
  control claim, status 'documents_needed' (an ELIGIBLE status, so the claim
          is not dropped earlier for its status), ready_for_bids true
          (clicked Submit for Bids), same 3 h old checklist_complete row.
          Expected in the dry_run preview: NOT selected; the checklist-stage
          screen skips it with reason already_submitted, the one gate that
          isolates the Submit predicate.

WHAT IS OBSERVABLE (corrected, PR #2861 REVIEW: FAIL 6255357846 item 6): a
real cron tick scans is_test=false only (index.ts scanIsTest =
candidateIsTestFlag(dryRun), dry-run.ts), so it never sees these fixtures and
sends nothing to them. The observation is the function's dry_run preview,
which scans is_test=true, sends nothing and writes nothing. Call it, after
seeding, with a service-role or cron-secret credential (never printed here):
    curl -sS -X POST "$SUPABASE_URL/functions/v1/send-homeowner-next-steps" \
      -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
      -H "Content-Type: application/json" -d '{"dry_run": true}'
(or X-Cron-Secret: $CRON_SECRET instead of the Bearer header). Look in
checklist_complete_would_send for the draft and stalled claim ids and confirm
the control claim id is absent (checklist_complete_results carries its
skipped_reason). dry_run must be the literal JSON true; test_send_claim_ids
cannot be combined with it and rejects *.test recipients.

SAFETY PROPERTIES (each has a test in seed-gh1570-is-test-fixtures.test.py):
  * Only is_test rows. Every profile, claim and activity_log row is written
    with is_test = true; emails are <slug>@otterquote-internal.test (no inbox).
  * DRY-RUN BY DEFAULT. Nothing is written unless --apply is passed, and the
    dry run prints exactly what would be inserted. A dry run still READS the
    target (to say what already exists); it never writes.
  * IDEMPOTENT. A fixture whose auth user already exists is not recreated and
    its claim / checklist row are only added if missing. Running --apply twice
    inserts nothing the second time.
  * CREDENTIALS FROM ENV ONLY: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. No
    argv, no URL-embedded key, never printed. Anything echoed is redacted.
  * CLEANUP MODE (--cleanup, also dry-run until --apply): removes only auth
    users whose email is one of the three fixture addresses and that own no
    non-test row we can see. The profile is read both by email and by id
    (profiles?id=eq.<uid>, so a profile whose email column drifted is still
    caught, including for an orphaned auth user), and contractors?user_id=eq.<uid>
    is read too. ALL three fixtures are validated BEFORE the first delete:
    any non-test profile (by email or by id), claim, activity_log or contractors
    row refuses the whole run with nothing deleted. Every DELETE is also scoped in its own URL (claims and
    activity_log by is_test=eq.true, notifications by recipient=<fixture
    email>), so a row that appears after the check cannot be deleted. Just
    before the auth delete (which cascades profiles, claims, activity_log and
    contractors) claims, activity_log, contractors and the profile (by email
    and by id) are read again; if any is non-test the auth user is kept and
    the run stops. Tables this script does not read are not checked. An orphaned auth user
    (no profile row) is found by email and deleted only if that email is on
    the fixture list and in the is_test domain.
  * The service role key is Dustin's production credential. This script is
    NOT run by CI and the PR that adds it does not run it. Running it against
    production needs Dustin's word in chat (block cto66-permission-layer).

Usage (dry run, safe):
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python3 scripts/seed-gh1570-is-test-fixtures.py
    ... --apply            write the fixtures
    ... --cleanup          show what cleanup would delete
    ... --cleanup --apply  delete them
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

EMAIL_DOMAIN = "otterquote-internal.test"
MARKER = "gh1570-seed"
AGE_HOURS = 3  # comfortably past CHECKLIST_COMPLETE_DELAY_MS (2 h)

FIXTURES = [
    {
        "slug": "gh1570-draft",
        "role": "draft",
        "status": "draft",
        "ready_for_bids": False,
        "event": False,  # draft completion is derived from columns, no event
    },
    {
        "slug": "gh1570-stalled",
        "role": "stalled",
        "status": "documents_needed",
        "ready_for_bids": False,
        "event": True,
    },
    {
        "slug": "gh1570-control",
        "role": "control",
        "status": "documents_needed",
        "ready_for_bids": True,
        "event": True,
    },
]


def fixture_email(f):
    return f"{f['slug']}@{EMAIL_DOMAIN}"


def build_claim_row(f, user_id, now):
    """The claim row for a fixture. Always is_test. Cash checklist complete."""
    stamp = (now - timedelta(hours=AGE_HOURS)).isoformat()
    return {
        "user_id": user_id,
        "status": f["status"],
        "ready_for_bids": f["ready_for_bids"],
        "is_test": True,
        "funding_type": "cash",
        "job_type": "retail",
        "damage_type": "roof",
        "trades": ["roofing"],
        "has_estimate": False,
        "has_measurements": True,
        "has_material_selection": True,
        "property_state": "IN",
        "homeowner_name": f"GH1570 {f['role']} (is_test)",
        "homeowner_notes": MARKER,
        "created_at": stamp,
        "updated_at": stamp,
    }


def build_event_row(f, user_id, claim_id, now):
    return {
        "user_id": user_id,
        "event_type": "checklist_complete",
        "title": "checklist_complete",
        "is_test": True,
        "metadata": {"claim_id": claim_id, "seed": MARKER},
        "created_at": (now - timedelta(hours=AGE_HOURS)).isoformat(),
    }


class Client:
    """Minimal Supabase REST client. Key is held in memory, sent only as a header."""

    def __init__(self, url, key):
        self.url = url.rstrip("/")
        self.key = key

    def _req(self, method, path, body=None, prefer=None):
        headers = {
            "apikey": self.key,
            "Authorization": "Bearer " + self.key,
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace").replace(self.key, "<REDACTED>")
            raise RuntimeError(f"{method} {path.split('?')[0]} -> HTTP {e.code}: {detail[:300]}") from None
        return json.loads(raw) if raw else None

    # reads
    def find_profile(self, email):
        q = urllib.parse.quote(email, safe="@")
        rows = self._req("GET", f"/rest/v1/profiles?email=eq.{q}&select=id,email,is_test")
        return rows[0] if rows else None

    def claims_for(self, user_id):
        return self._req("GET", f"/rest/v1/claims?user_id=eq.{user_id}&select=id,is_test,status")

    def events_for(self, user_id):
        return self._req(
            "GET",
            f"/rest/v1/activity_log?user_id=eq.{user_id}&event_type=eq.checklist_complete&select=id",
        )

    def activity_for(self, user_id):
        return self._req("GET", f"/rest/v1/activity_log?user_id=eq.{user_id}&select=id,is_test,event_type")

    def profile_by_id(self, user_id):
        """The profile row for an auth user id. Catches a profile whose email
        column no longer matches the fixture address."""
        rows = self._req("GET", f"/rest/v1/profiles?id=eq.{user_id}&select=id,email,is_test")
        return rows[0] if rows else None

    def contractors_for(self, user_id):
        return self._req("GET", f"/rest/v1/contractors?user_id=eq.{user_id}&select=id,is_test")

    def find_auth_user(self, email, per_page=200, max_pages=50):
        """Admin lookup by exact email (GoTrue has no reliable email filter)."""
        for page in range(1, max_pages + 1):
            r = self._req("GET", f"/auth/v1/admin/users?page={page}&per_page={per_page}")
            users = (r or {}).get("users", []) if isinstance(r, dict) else (r or [])
            for u in users:
                if (u.get("email") or "").lower() == email.lower():
                    return {"id": u["id"], "email": u["email"]}
            if len(users) < per_page:
                return None
        return None

    # writes
    def create_auth_user(self, email, full_name):
        r = self._req("POST", "/auth/v1/admin/users",
                      {"email": email, "email_confirm": True, "user_metadata": {"full_name": full_name}})
        return r["id"]

    def mark_profile_test(self, user_id):
        self._req("PATCH", f"/rest/v1/profiles?id=eq.{user_id}",
                  {"is_test": True, "address_state": "IN"}, prefer="return=minimal")

    def insert(self, table, row):
        r = self._req("POST", f"/rest/v1/{table}", row, prefer="return=representation")
        return r[0]["id"]

    def delete_scoped(self, table, user_id, scope_column, scope_value):
        """DELETE ... ?user_id=eq.<id>&<scope_column>=eq.<scope_value>. The scope
        is part of the URL, so it is enforced by the database at delete time,
        not only by an earlier read (no check-then-act race)."""
        q = urllib.parse.quote(str(scope_value), safe="@")
        self._req("DELETE", f"/rest/v1/{table}?user_id=eq.{user_id}&{scope_column}=eq.{q}",
                  prefer="return=minimal")

    def delete_auth_user(self, user_id):
        self._req("DELETE", f"/auth/v1/admin/users/{user_id}")


def run_seed(client, apply, now, out=print):
    """Returns list of created/planned actions. Writes only when apply is True."""
    actions = []
    # Orphan pre-pass (REVIEW item 4): an auth user with no profile row would
    # make create fail with 422 email_exists on every run. Report it, write nothing.
    for f in FIXTURES:
        email = fixture_email(f)
        if client.find_profile(email) is None:
            orphan = client.find_auth_user(email)
            if orphan is not None:
                raise RuntimeError(
                    f"ORPHANED AUTH USER: {email} exists in auth (id {orphan['id']}) with no profiles row. "
                    "Seed cannot create it again (422 email_exists). Nothing was written. "
                    "Run --cleanup (dry run, then --apply) to remove the orphan, then seed again.")
    for f in FIXTURES:
        email = fixture_email(f)
        prof = client.find_profile(email)
        if prof is not None and prof.get("is_test") is not True:
            raise RuntimeError(f"REFUSING: {email} exists with is_test != true; not touching it")
        uid = prof["id"] if prof else None
        if uid is None:
            actions.append(("auth_user+profile", email))
            out(f"  would create auth user + is_test profile {email}" if not apply else f"  creating {email}")
            if apply:
                uid = client.create_auth_user(email, f"GH1570 {f['role']} (is_test)")
                client.mark_profile_test(uid)
                got = client.find_profile(email)
                if not got or got.get("is_test") is not True:
                    raise RuntimeError(f"profile for {email} not is_test after write; stopping")
        else:
            out(f"  exists: profile {email} (is_test true) -> skip create")
        claims = client.claims_for(uid) if uid else []
        if any(c.get("is_test") is not True for c in claims):
            raise RuntimeError(f"REFUSING: {email} owns a non-test claim")
        claim_id = claims[0]["id"] if claims else None
        if claim_id is None:
            row = build_claim_row(f, uid or "<new-user-id>", now)
            actions.append(("claim", row))
            out(f"  {'would insert' if not apply else 'inserting'} claim: " + json.dumps(row, sort_keys=True))
            if apply:
                claim_id = client.insert("claims", row)
        else:
            out(f"  exists: claim {claim_id} -> skip insert")
        if f["event"]:
            has_event = bool(uid and client.events_for(uid))
            if not has_event:
                row = build_event_row(f, uid or "<new-user-id>", claim_id or "<new-claim-id>", now)
                actions.append(("activity_log", row))
                out(f"  {'would insert' if not apply else 'inserting'} activity_log: " + json.dumps(row, sort_keys=True))
                if apply:
                    client.insert("activity_log", row)
            else:
                out("  exists: checklist_complete row -> skip insert")
        if apply:
            out(f"  RECORD FOR #1570 CLEANUP: {f['role']} user_id={uid} claim_id={claim_id}")
    return actions


FIXTURE_EMAILS = {fixture_email(f) for f in FIXTURES}


def plan_cleanup(client, out=print):
    """Validate ALL fixtures; read-only. Raises RuntimeError on the first
    anything-not-test, before any caller has deleted a single row."""
    plan = []
    for f in FIXTURES:
        email = fixture_email(f)
        prof = client.find_profile(email)
        orphan = False
        if prof is not None:
            if prof.get("is_test") is not True:
                raise RuntimeError(f"REFUSING: {email} profile is not is_test; nothing deleted")
            uid = prof["id"]
        else:
            au = client.find_auth_user(email)
            if au is None:
                out(f"  nothing to clean for {email}")
                continue
            au_email = (au.get("email") or "").lower()
            if au_email not in FIXTURE_EMAILS or not au_email.endswith("@" + EMAIL_DOMAIN):
                raise RuntimeError(
                    f"REFUSING: auth user {au.get('email')} is not on the fixture list / is_test domain; nothing deleted")
            uid, orphan = au["id"], True
        by_id = client.profile_by_id(uid)
        if by_id is not None and by_id.get("is_test") is not True:
            raise RuntimeError(f"REFUSING: profile {uid} (fixture {email}) is not is_test; nothing deleted")
        if any(c.get("is_test") is not True for c in client.contractors_for(uid)):
            raise RuntimeError(f"REFUSING: {email} owns a non-test contractors row; nothing deleted")
        claims = client.claims_for(uid)
        if any(c.get("is_test") is not True for c in claims):
            raise RuntimeError(f"REFUSING: {email} owns a non-test claim; nothing deleted")
        activity = client.activity_for(uid)
        if any(a.get("is_test") is not True for a in activity):
            raise RuntimeError(f"REFUSING: {email} owns a non-test activity_log row; nothing deleted")
        plan.append({"email": email, "uid": uid, "orphan": orphan, "claims": claims, "activity": activity})
    return plan


def run_cleanup(client, apply, out=print):
    plan = plan_cleanup(client, out=out)  # all three checked before the first delete
    removed = []
    for p in plan:
        email, uid = p["email"], p["uid"]
        kind = "ORPHANED auth user (no profile)" if p["orphan"] else "user"
        out(f"  {'would delete' if not apply else 'deleting'} {kind} {uid} ({email}), {len(p['claims'])} claim(s), "
            f"{len(p['activity'])} activity_log row(s), and its notifications")
        removed.append(uid)
        if not apply:
            continue
        client.delete_scoped("notifications", uid, "recipient", email)
        client.delete_scoped("activity_log", uid, "is_test", "true")
        client.delete_scoped("claims", uid, "is_test", "true")
        # A row that appeared after the check survives the scoped deletes above.
        # Deleting the auth user would cascade it away, so stop instead.
        left = client.claims_for(uid) + client.activity_for(uid)
        prof_now = client.find_profile(email)
        prof_id_now = client.profile_by_id(uid)
        contractors_now = [c for c in client.contractors_for(uid) if c.get("is_test") is not True]
        if (left or contractors_now
                or (prof_now is not None and prof_now.get("is_test") is not True)
                or (prof_id_now is not None and prof_id_now.get("is_test") is not True)):
            raise RuntimeError(
                f"REFUSING: {email} gained a non-test row after the check "
                f"({len(left) + len(contractors_now)} row(s) remain, or a profile is not is_test); "
                "auth user kept, nothing further deleted")
        client.delete_auth_user(uid)  # cascades profiles
    return removed


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apply", action="store_true", help="actually write (default is a dry run)")
    ap.add_argument("--cleanup", action="store_true", help="remove the fixtures (dry run unless --apply)")
    args = ap.parse_args(argv)
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        print("UNMEASURED: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.",
              file=sys.stderr)
        return 2
    if not url.startswith("https://") or "@" in url or "key=" in url.lower():
        print("REFUSING: SUPABASE_URL must be a plain https URL with no embedded credentials.", file=sys.stderr)
        return 2
    client = Client(url, key)
    mode = "APPLY" if args.apply else "DRY-RUN (no writes)"
    print(f"seed-gh1570 {'CLEANUP' if args.cleanup else 'SEED'} -- {mode} -- target {url}")
    try:
        if args.cleanup:
            run_cleanup(client, args.apply)
        else:
            run_seed(client, args.apply, datetime.now(timezone.utc))
    except RuntimeError as e:
        print(str(e).replace(key, "<REDACTED>"), file=sys.stderr)
        return 1
    if not args.apply:
        print("Dry run complete. Re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
