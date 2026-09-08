#!/usr/bin/env python3
"""
Unit tests for scripts/is-test-cross-table-check.py (gh-1763).

Loaded via importlib.util (not a plain `import`) because the module's
filename contains hyphens -- same pattern as
scripts/ci-test-function-parity.test.py and
scripts/edge-function-drift-check.test.py.

No network access and no credentials required: `find_disagreements` is a
pure client-side join over fixture lists, and `run()` is exercised only
through a stubbed `urlopen`, never a real one.

Run: python scripts/is-test-cross-table-check.test.py
"""

import importlib.util
import json
import io
import pathlib
import sys
import unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guard", HERE / "is-test-cross-table-check.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class FindDisagreementsTests(unittest.TestCase):
    """Pure join+compare -- no I/O, no network. Mirrors the issue body's SQL predicate."""

    def test_clean_tree_no_offenders(self):
        contractors = [{"id": "c1", "user_id": "p1", "is_test": True, "company_name": "A"}]
        profiles = [{"id": "p1", "is_test": True, "role": "contractor"}]
        self.assertEqual(guard.find_disagreements(contractors, profiles), [])

    def test_gh1763_exact_shape_profile_false_contractor_true(self):
        contractors = [{"id": "c1", "user_id": "p1", "is_test": True, "company_name": "PFW Walk Roofing LLC"}]
        profiles = [{"id": "p1", "is_test": False, "role": "contractor"}]
        offenders = guard.find_disagreements(contractors, profiles)
        self.assertEqual(len(offenders), 1)
        self.assertEqual(offenders[0]["profile_id"], "p1")
        self.assertEqual(offenders[0]["contractor_id"], "c1")
        self.assertFalse(offenders[0]["profile_is_test"])
        self.assertTrue(offenders[0]["contractor_is_test"])

    def test_reverse_disagreement_also_caught(self):
        """The issue's finding was all one direction (profile=false/contractor=true), but
        the guard must not be direction-blind -- it should catch the mirror case too."""
        contractors = [{"id": "c1", "user_id": "p1", "is_test": False, "company_name": "A"}]
        profiles = [{"id": "p1", "is_test": True, "role": "contractor"}]
        offenders = guard.find_disagreements(contractors, profiles)
        self.assertEqual(len(offenders), 1)

    def test_contractor_with_no_matching_profile_is_not_an_offender(self):
        """Mirrors the SQL INNER JOIN -- a contractor whose user_id has no profiles row
        (or whose profile isn't role='contractor', so it's absent from the profiles
        fetch) simply drops out, same as the join would drop it."""
        contractors = [{"id": "c1", "user_id": "missing", "is_test": True, "company_name": "A"}]
        profiles = []
        self.assertEqual(guard.find_disagreements(contractors, profiles), [])

    def test_multiple_offenders_all_reported(self):
        contractors = [
            {"id": "c1", "user_id": "p1", "is_test": True, "company_name": "A"},
            {"id": "c2", "user_id": "p2", "is_test": True, "company_name": "B"},
            {"id": "c3", "user_id": "p3", "is_test": True, "company_name": "C"},
        ]
        profiles = [
            {"id": "p1", "is_test": False, "role": "contractor"},
            {"id": "p2", "is_test": True, "role": "contractor"},
            {"id": "p3", "is_test": False, "role": "contractor"},
        ]
        offenders = guard.find_disagreements(contractors, profiles)
        self.assertEqual({o["contractor_id"] for o in offenders}, {"c1", "c3"})


class RunTests(unittest.TestCase):
    """run() exercised end-to-end against a stubbed urlopen -- no real network."""

    def _fake_urlopen_factory(self, contractors_payload, profiles_payload):
        def fake_urlopen(req, timeout=30):
            url = req.full_url
            if "/rest/v1/contractors" in url:
                body = json.dumps(contractors_payload).encode("utf-8")
            elif "/rest/v1/profiles" in url:
                body = json.dumps(profiles_payload).encode("utf-8")
            else:
                raise AssertionError(f"unexpected URL in test: {url}")
            return _FakeResponse(body)
        return fake_urlopen

    def test_run_clean_exits_0(self):
        contractors = [{"id": "c1", "user_id": "p1", "is_test": True, "company_name": "A"}]
        profiles = [{"id": "p1", "is_test": True, "role": "contractor"}]
        fake = self._fake_urlopen_factory(contractors, profiles)
        with patch("sys.stdout", new_callable=io.StringIO):
            code = guard.run("https://example.supabase.co", "fake-key", urlopen=fake)
        self.assertEqual(code, 0)

    def test_run_with_disagreement_exits_1(self):
        contractors = [{"id": "c1", "user_id": "p1", "is_test": True, "company_name": "PFW Walk Roofing LLC"}]
        profiles = [{"id": "p1", "is_test": False, "role": "contractor"}]
        fake = self._fake_urlopen_factory(contractors, profiles)
        with patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
            code = guard.run("https://example.supabase.co", "fake-key", urlopen=fake)
        self.assertEqual(code, 1)

    def test_run_missing_credentials_exits_3(self):
        with patch("sys.stderr", new_callable=io.StringIO):
            code = guard.run("", "", urlopen=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not fetch")))
        self.assertEqual(code, 3)

    def test_run_unreachable_api_exits_3_not_0(self):
        """UNMEASURED must never look like a clean pass (gh-1419)."""
        def fake_urlopen(req, timeout=30):
            raise guard.urllib.error.URLError("connection refused")
        with patch("sys.stderr", new_callable=io.StringIO):
            code = guard.run("https://example.supabase.co", "fake-key", urlopen=fake_urlopen)
        self.assertEqual(code, 3)


class SelfTestProdGuardTests(unittest.TestCase):
    """The --self-test fixture-write path must refuse production outright, before
    making any network call at all."""

    def test_self_test_refuses_production_url(self):
        def fake_urlopen(req, timeout=30):
            raise AssertionError("self-test must not make any network call against a production URL")
        with patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
            code = guard.self_test(
                f"https://{guard.PRODUCTION_PROJECT_REF}.supabase.co", "fake-key", urlopen=fake_urlopen
            )
        self.assertEqual(code, 2)

    def test_self_test_allows_non_production_url(self):
        """Sanity check that the guard only trips on the literal prod ref, not on
        every URL -- proven by getting past the refusal into the (stubbed) network
        path, which raises for an unrelated reason instead (a self-test setup
        failure, exit 1 -- NOT the prod-refusal code, 2)."""
        def fake_urlopen(req, timeout=30):
            raise guard.urllib.error.URLError("stub -- proves we got past the prod guard")
        with patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
            code = guard.self_test("https://zsdvaqilfdclwosmiheh.supabase.co", "fake-key", urlopen=fake_urlopen)
        self.assertNotEqual(code, 2, "must not be misreported as a prod-refusal")
        self.assertEqual(code, 1)


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    unittest.main()
