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

    def find_profile(self, email):
        return self.profiles.get(email)

    def claims_for(self, uid):
        return [c for c in self.claims if c["user_id"] == uid]

    def events_for(self, uid):
        return [e for e in self.events if e["user_id"] == uid]

    def create_auth_user(self, email, name):
        self.writes.append("auth")
        self.n += 1
        uid = f"u{self.n}"
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

    def delete_where(self, table, col, val):
        self.writes.append("del-" + table)
        if table == "claims":
            self.claims = [c for c in self.claims if c[col] != val]
        if table == "activity_log":
            self.events = [e for e in self.events if e[col] != val]

    def delete_auth_user(self, uid):
        self.writes.append("del-auth")
        self.profiles = {k: v for k, v in self.profiles.items() if v["id"] != uid}


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
