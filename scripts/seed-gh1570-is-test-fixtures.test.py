#!/usr/bin/env python3
"""Tests for scripts/seed-gh1570-is-test-fixtures.py. No network, no credentials.
Run: python scripts/seed-gh1570-is-test-fixtures.test.py
"""
import importlib.util
import io
import os
import pathlib
import unittest
import contextlib
from datetime import datetime, timezone
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("seed", HERE / "seed-gh1570-is-test-fixtures.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)


class FakeClient:
    def __init__(self):
        self.profiles, self.claims, self.events = {}, [], []
        self.writes = []
        self.n = 0
        self.auth_users = {}        # email -> id (auth.users, incl. orphans)
        self.on_delete = None       # hook: called before each scoped delete (race injection)
        self.delete_log = []        # (table, uid, scope_col, scope_val)

    def find_profile(self, email):
        return self.profiles.get(email)

    def claims_for(self, uid):
        return [c for c in self.claims if c["user_id"] == uid]

    def events_for(self, uid):
        return [e for e in self.events if e["user_id"] == uid]

    def activity_for(self, uid):
        return [e for e in self.events if e["user_id"] == uid]

    def find_auth_user(self, email):
        uid = self.auth_users.get(email)
        return {"id": uid, "email": email} if uid else None

    def create_auth_user(self, email, name):
        self.writes.append("auth")
        if email in self.auth_users:
            raise RuntimeError("422 email_exists")
        self.n += 1
        uid = f"u{self.n}"
        self.auth_users[email] = uid
        self.profiles[email] = {"id": uid, "email": email, "is_test": False}
        return uid

    def mark_profile_test(self, uid):
        self.writes.append("profile")
        for p in self.profiles.values():
            if p["id"] == uid:
                p["is_test"] = True

    def insert(self, table, row):
        self.writes.append(table)
        self.n += 1
        rid = f"{table}{self.n}"
        (self.claims if table == "claims" else self.events).append(dict(row, id=rid))
        return rid

    def delete_scoped(self, table, uid, scope_col, scope_val):
        """Emulates the database: the scope filter is applied AT DELETE TIME."""
        if self.on_delete:
            hook, self.on_delete = self.on_delete, None
            hook(self)
        self.writes.append("del-" + table)
        self.delete_log.append((table, uid, scope_col, scope_val))
        keep = lambda r: not (r["user_id"] == uid and str(r.get(scope_col)).lower() == str(scope_val).lower())
        if table == "claims":
            self.claims = [c for c in self.claims if keep(c)]
        if table == "activity_log":
            self.events = [e for e in self.events if keep(e)]

    def delete_auth_user(self, uid):
        self.writes.append("del-auth")
        self.profiles = {k: v for k, v in self.profiles.items() if v["id"] != uid}
        self.auth_users = {k: v for k, v in self.auth_users.items() if v != uid}
        # cascade, as the real FK does
        self.claims = [c for c in self.claims if c["user_id"] != uid]
        self.events = [e for e in self.events if e["user_id"] != uid]


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, out=lambda *_: None, **k)


class SeedTests(unittest.TestCase):
    def test_dry_run_writes_nothing_but_plans_everything(self):
        c = FakeClient()
        actions = quiet(seed.run_seed, c, False, NOW)
        self.assertEqual(c.writes, [])
        kinds = [a[0] for a in actions]
        self.assertEqual(kinds.count("auth_user+profile"), 3)
        self.assertEqual(kinds.count("claim"), 3)
        self.assertEqual(kinds.count("activity_log"), 2)  # draft derives from columns

    def test_apply_creates_only_is_test_rows(self):
        c = FakeClient()
        quiet(seed.run_seed, c, True, NOW)
        self.assertEqual(len(c.claims), 3)
        self.assertTrue(all(x["is_test"] is True for x in c.claims))
        self.assertTrue(all(e["is_test"] is True for e in c.events))
        self.assertTrue(all(p["is_test"] is True for p in c.profiles.values()))
        self.assertTrue(all(e.endswith("@otterquote-internal.test") for e in c.profiles))

    def test_roles_match_the_closes_on_shapes(self):
        c = FakeClient()
        quiet(seed.run_seed, c, True, NOW)
        by = {x["homeowner_name"].split()[1]: x for x in c.claims}
        # control isolates the Submit predicate: eligible status + already submitted
        self.assertEqual(by["control"]["status"], "documents_needed")
        self.assertEqual((by["draft"]["status"], by["draft"]["ready_for_bids"]), ("draft", False))
        self.assertEqual((by["stalled"]["status"], by["stalled"]["ready_for_bids"]), ("documents_needed", False))
        self.assertTrue(by["control"]["ready_for_bids"])
        # checklist completed more than 2 h ago
        self.assertGreater((NOW - datetime.fromisoformat(by["stalled"]["updated_at"])).total_seconds(), 2 * 3600)

    def test_idempotent_second_apply_inserts_nothing(self):
        c = FakeClient()
        quiet(seed.run_seed, c, True, NOW)
        before = len(c.writes)
        actions = quiet(seed.run_seed, c, True, NOW)
        self.assertEqual(actions, [])
        self.assertEqual(len(c.writes), before)

    def test_refuses_existing_non_test_profile(self):
        c = FakeClient()
        c.profiles[seed.fixture_email(seed.FIXTURES[0])] = {"id": "real", "email": "x", "is_test": False}
        with self.assertRaises(RuntimeError):
            quiet(seed.run_seed, c, True, NOW)
        self.assertEqual(c.writes, [])

    def test_cleanup_dry_run_then_apply(self):
        c = FakeClient()
        quiet(seed.run_seed, c, True, NOW)
        n = len(c.writes)
        self.assertEqual(len(quiet(seed.run_cleanup, c, False)), 3)
        self.assertEqual(len(c.writes), n)
        quiet(seed.run_cleanup, c, True)
        self.assertEqual(c.profiles, {})
        self.assertEqual(c.claims, [])

    def test_cleanup_refuses_non_test_claim_negative_control(self):
        c = FakeClient()
        quiet(seed.run_seed, c, True, NOW)
        c.claims[0]["is_test"] = False
        n = len(c.writes)
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertEqual(len(c.writes), n)


def seeded():
    c = FakeClient()
    quiet(seed.run_seed, c, True, NOW)
    return c


def uid_of(c, slug):
    return c.profiles[f"{slug}@otterquote-internal.test"]["id"]


class CleanupSafetyTests(unittest.TestCase):
    def test_p2_real_client_delete_urls_are_scoped(self):
        calls = []

        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return b""

        def fake_urlopen(req, timeout=0):
            calls.append((req.get_method(), req.full_url))
            return R()

        cl = seed.Client("https://x.supabase.co", "k" * 40)
        with patch.object(seed.urllib.request, "urlopen", fake_urlopen):
            cl.delete_scoped("claims", "U1", "is_test", "true")
            cl.delete_scoped("activity_log", "U1", "is_test", "true")
            cl.delete_scoped("notifications", "U1", "recipient", "gh1570-draft@otterquote-internal.test")
        urls = [u for m, u in calls if m == "DELETE"]
        self.assertEqual(len(urls), 3)
        self.assertTrue(urls[0].endswith("/rest/v1/claims?user_id=eq.U1&is_test=eq.true"), urls[0])
        self.assertTrue(urls[1].endswith("/rest/v1/activity_log?user_id=eq.U1&is_test=eq.true"), urls[1])
        self.assertIn("&recipient=eq.gh1570-draft@otterquote-internal.test", urls[2])
        # negative control: no unscoped delete helper remains
        self.assertFalse(hasattr(seed.Client, "delete_where"))

    def test_p2_run_cleanup_only_issues_scoped_deletes(self):
        c = seeded()
        quiet(seed.run_cleanup, c, True)
        self.assertEqual(len(c.delete_log), 9)  # 3 tables x 3 fixtures
        for table, _uid, col, val in c.delete_log:
            if table in ("claims", "activity_log"):
                self.assertEqual((col, val), ("is_test", "true"))
            else:
                self.assertEqual(col, "recipient")

    def test_p3_non_test_claim_inserted_between_check_and_delete_survives(self):
        c = seeded()
        victim = uid_of(c, "gh1570-draft")
        race = {}

        def inject(cl):
            cl.claims.append({"id": "RACE", "user_id": victim, "is_test": False, "status": "draft"})
            race["done"] = True

        c.on_delete = inject  # fires after plan_cleanup validated, before the first DELETE
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertTrue(race.get("done"))
        self.assertIn("RACE", [x["id"] for x in c.claims])      # the non-test claim survived
        self.assertIn(victim, c.auth_users.values())            # and its user was not deleted
        self.assertIn("gh1570-draft@otterquote-internal.test", c.profiles)
        self.assertNotIn("del-auth", c.writes[-1:])             # stopped before deleting that auth user

    def test_p4_non_test_activity_row_refuses_up_front(self):
        c = seeded()
        c.events.append({"id": "AL", "user_id": uid_of(c, "gh1570-stalled"), "is_test": False,
                         "event_type": "x"})
        before = (len(c.writes), len(c.claims), len(c.events), dict(c.profiles))
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertEqual((len(c.writes), len(c.claims), len(c.events), c.profiles), before)

    def test_p4_activity_row_inserted_late_survives(self):
        c = seeded()
        victim = uid_of(c, "gh1570-stalled")
        c.on_delete = lambda cl: cl.events.append(
            {"id": "ALRACE", "user_id": victim, "is_test": False, "event_type": "x"})
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertIn("ALRACE", [e["id"] for e in c.events])

    def test_p6_refusal_leaves_every_fixture_intact(self):
        c = seeded()
        c.claims[-1]["is_test"] = False  # the LAST fixture (control) is the offender
        before = (list(c.writes), list(c.claims), list(c.events), dict(c.profiles), dict(c.auth_users))
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertEqual((c.writes, c.claims, c.events, c.profiles, c.auth_users), before)
        self.assertEqual(len(c.profiles), 3)
        self.assertEqual(c.delete_log, [])

    def test_p6_non_test_profile_refuses_with_nothing_deleted(self):
        c = seeded()
        c.profiles["gh1570-control@otterquote-internal.test"]["is_test"] = False
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertEqual(c.delete_log, [])
        self.assertEqual(len(c.auth_users), 3)

    def test_cleanup_dry_run_validates_too(self):
        c = seeded()
        c.claims[0]["is_test"] = False
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, False)


class OrphanTests(unittest.TestCase):
    EMAIL = "gh1570-stalled@otterquote-internal.test"

    def test_seed_reports_orphan_and_writes_nothing(self):
        c = FakeClient()
        c.auth_users[self.EMAIL] = "orph1"
        with self.assertRaises(RuntimeError) as cm:
            quiet(seed.run_seed, c, True, NOW)
        self.assertIn("ORPHANED AUTH USER", str(cm.exception))
        self.assertIn("--cleanup", str(cm.exception))
        self.assertEqual(c.writes, [])

    def test_cleanup_deletes_orphan_auth_user(self):
        c = FakeClient()
        c.auth_users[self.EMAIL] = "orph1"
        self.assertEqual(quiet(seed.run_cleanup, c, False), ["orph1"])
        self.assertEqual(c.writes, [])  # dry run
        quiet(seed.run_cleanup, c, True)
        self.assertEqual(c.auth_users, {})
        # and seed works again afterwards
        quiet(seed.run_seed, c, True, NOW)
        self.assertEqual(len(c.claims), 3)

    def test_cleanup_refuses_auth_user_off_the_fixture_list(self):
        c = FakeClient()
        c.find_auth_user = lambda email: {"id": "real", "email": "someone@gmail.com"}
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertEqual(c.writes, [])

    def test_cleanup_refuses_orphan_that_owns_a_non_test_claim(self):
        c = FakeClient()
        c.auth_users[self.EMAIL] = "orph1"
        c.claims.append({"id": "k", "user_id": "orph1", "is_test": False, "status": "draft"})
        with self.assertRaises(RuntimeError):
            quiet(seed.run_cleanup, c, True)
        self.assertEqual(c.writes, [])


class MainTests(unittest.TestCase):
    def test_no_credentials_exit_2_and_no_client(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(seed, "Client") as cl, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(seed.main([]), 2)
            cl.assert_not_called()

    def test_url_with_embedded_credential_refused(self):
        env = {"SUPABASE_URL": "https://user:pw@x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k" * 40}
        with patch.dict(os.environ, env, clear=True), patch.object(seed, "Client") as cl, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(seed.main([]), 2)
            cl.assert_not_called()

    def test_default_is_dry_run(self):
        env = {"SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k" * 40}
        fake = FakeClient()
        with patch.dict(os.environ, env, clear=True), patch.object(seed, "Client", return_value=fake), \
                contextlib.redirect_stdout(io.StringIO()) as buf:
            self.assertEqual(seed.main([]), 0)
        self.assertEqual(fake.writes, [])
        self.assertIn("DRY-RUN", buf.getvalue())
        self.assertNotIn("k" * 40, buf.getvalue())

    def test_key_not_accepted_on_argv(self):
        with self.assertRaises(SystemExit):
            with contextlib.redirect_stderr(io.StringIO()):
                seed.main(["--key", "abc"])


if __name__ == "__main__":
    unittest.main()
