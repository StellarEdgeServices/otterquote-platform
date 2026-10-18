#!/usr/bin/env python3
"""Unit tests for scripts/gh1411-synthetic-e2e.py (gh-1411). No network: an in-memory fake PostgREST.
Run: python scripts/gh1411-synthetic-e2e.test.py"""
import copy
import importlib.util
import pathlib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("syn", HERE / "gh1411-synthetic-e2e.py")
syn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(syn)

OID = "3b4622fb-65bd-4b04-b056-1eab4b59a187"
NOW = "2026-10-14T08:00:00Z"


def fixtures():
    return {
        "hover_orders": [{"id": OID, "claim_id": syn.CLAIM_ID, "product_code": "roof_upgrade_detailed",
                          "status": "awaiting_fulfillment", "report_url": None, "measurements_json": None,
                          "fulfilled_at": None, "requested_by_contractor_id": syn.BUYER_CONTRACTOR_ID}],
        "claims": [{"id": syn.CLAIM_ID, "is_test": True, "measurement_shape": None,
                    "live_charge_authorized_at": "2026-09-05 19:26:43+00", "hover_measurements": {"squares": 63.05}}],
        "contractors": [{"id": syn.BUYER_CONTRACTOR_ID, "is_test": True}],
    }


class FakeRest:
    def __init__(self, db):
        self.db, self.writes = db, []

    def get(self, table, cols, flt):
        return [copy.deepcopy(r) for r in self.db[table] if all(str(r.get(k)) == v for k, v in flt.items())]

    def patch(self, table, flt, patch):
        rows = [r for r in self.db[table] if all(str(r.get(k)) == v for k, v in flt.items())]
        assert len(rows) == 1
        rows[0].update(patch)
        self.writes.append((table, flt, patch))
        return copy.deepcopy(rows[0])


def go(db, execute, ruling):
    f, lines = FakeRest(db), []
    rc = syn.run(f, execute, ruling, NOW, out=lines.append)
    return rc, f, lines


class T(unittest.TestCase):
    def test_plan_mode_writes_nothing(self):
        rc, f, _ = go(fixtures(), False, None)
        self.assertEqual((rc, f.writes), (0, []))

    def test_execute_without_ruling_refused_no_write(self):
        rc, f, lines = go(fixtures(), True, None)
        self.assertEqual((rc, f.writes), (3, []))
        self.assertTrue(any("REFUSED" in l for l in lines))

    def test_execute_happy_path_marker_cleared_first_and_state_after(self):
        db = fixtures()
        rc, f, _ = go(db, True, syn.RULING)
        self.assertEqual(rc, 0)
        self.assertEqual(f.writes[0][2], {"live_charge_authorized_at": None})  # ruling addition 1: FIRST
        self.assertEqual([w[0] for w in f.writes], ["claims", "hover_orders", "claims"])
        self.assertEqual(db["claims"][0]["measurement_shape"], "full")
        self.assertIsNone(db["claims"][0]["live_charge_authorized_at"])
        self.assertEqual(db["hover_orders"][0]["status"], "completed")
        self.assertEqual(db["claims"][0]["hover_measurements"]["squares"], 63.05)  # tier does not move

    def test_non_test_claim_refused_before_any_write(self):  # NEGATIVE CONTROL
        db = fixtures(); db["claims"][0]["is_test"] = False
        rc, f, lines = go(db, True, syn.RULING)
        self.assertEqual((rc, f.writes), (2, []))
        self.assertTrue(any("claim.is_test" in l for l in lines))

    def test_non_test_buyer_refused(self):
        db = fixtures(); db["contractors"][0]["is_test"] = None
        self.assertEqual(go(db, True, syn.RULING)[0], 2)

    def test_already_delivered_or_flipped_refused(self):
        for mut in (lambda d: d["hover_orders"][0].update(status="completed"),
                    lambda d: d["claims"][0].update(measurement_shape="full"),
                    lambda d: d["hover_orders"][0].update(product_code="roof_basic")):
            db = fixtures(); mut(db)
            rc, f, _ = go(db, True, syn.RULING)
            self.assertEqual((rc, f.writes), (2, []))

    def test_missing_squares_refused(self):
        db = fixtures(); db["claims"][0]["hover_measurements"] = None
        self.assertEqual(go(db, True, syn.RULING)[0], 2)

    def test_never_touches_second_contractor_or_other_tables(self):
        db = fixtures()
        db["contractors"].append({"id": "986ce2b6-0000-0000-0000-000000000000", "is_test": True})
        _, f, _ = go(db, True, syn.RULING)
        self.assertTrue(all(w[0] in ("claims", "hover_orders") for w in f.writes))
        self.assertNotIn("986ce2b6", repr(f.writes))

    def test_after_check_catches_a_silent_miss(self):
        self.assertTrue(syn.check_after({"status": "awaiting_fulfillment"}, {"measurement_shape": None}))


SECRETISH = "sb_secret_TESTONLYabcdef0123456789"
JWTISH = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.TESTONLYsig"


class SecretHygiene(unittest.TestCase):
    """gh-2582: no secret-shaped value in argv, a URL, the docstring, or printed output."""

    def test_argv_with_secret_shaped_value_refused(self):  # NEGATIVE CONTROL
        for argv in (["--execute", "--ruling", "6050104990", SECRETISH], [JWTISH],
                     ["SUPABASE_SERVICE_ROLE_KEY=" + SECRETISH], ["--key", SECRETISH], ["--ruling", SECRETISH]):
            self.assertTrue(syn.bad_argv(argv), argv)
            self.assertNotIn(SECRETISH, repr(syn.bad_argv(argv)))

    def test_allowed_argv_passes(self):
        self.assertEqual(syn.bad_argv(["--execute", "--ruling", "6050104990"]), [])
        self.assertEqual(syn.bad_argv([]), [])

    def test_main_refuses_secret_argv_without_echo(self):
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = syn.main(["--execute", SECRETISH])
        self.assertEqual(rc, 1)
        self.assertNotIn(SECRETISH, buf.getvalue())

    def test_docstring_usage_has_no_inline_secret(self):
        import re
        self.assertIsNone(re.search(r"SUPABASE_SERVICE_ROLE_KEY=\S", syn.__doc__ or ""))
        self.assertIsNone(re.search(r"SUPABASE_ACCESS_TOKEN=\S", syn.__doc__ or ""))

    def test_key_never_in_url_or_output(self):
        seen = []

        class R:
            def __init__(s, body): s.body = body
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return s.body

        def opener(req, timeout=0):
            seen.append(req.full_url)
            return R(b"[]")
        rest = syn.Rest("https://abc.supabase.co", SECRETISH, opener)
        rest.get("claims", "id", {"id": "1"})
        rest.patch  # noqa: B018
        self.assertTrue(seen and all(SECRETISH not in u for u in seen))

    def test_load_key_precedence_and_management_api_url_has_no_token(self):
        self.assertEqual(syn.load_service_key({"SUPABASE_SERVICE_ROLE_KEY": SECRETISH}), SECRETISH)
        seen = []

        class R:
            def __init__(s, body): s.body = body
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return s.body

        def opener(req, timeout=0):
            seen.append(req.full_url)
            return R(('[{"name":"anon","api_key":"x"},{"name":"service_role","api_key":"%s"}]' % SECRETISH).encode())
        env = {"SUPABASE_ACCESS_TOKEN": "sbp_TESTONLYtoken0123456789", "SUPABASE_URL": "https://abcdefgh.supabase.co"}
        self.assertEqual(syn.load_service_key(env, opener), SECRETISH)
        self.assertTrue(all("sbp_TESTONLY" not in u and SECRETISH not in u for u in seen))
        self.assertIsNone(syn.load_service_key({"SUPABASE_URL": "https://abcdefgh.supabase.co"}, opener))

    def test_source_has_no_secret_on_cli_patterns(self):
        import re
        src = (HERE / "gh1411-synthetic-e2e.py").read_text()
        self.assertIsNone(re.search(r"(eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|sbp_[A-Za-z0-9]{10,})", src))
        self.assertNotIn("sys.argv[", src.replace("main(sys.argv[1:])", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
