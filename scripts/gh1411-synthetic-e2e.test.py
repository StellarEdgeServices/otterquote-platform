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

PITCHES = [{"pitch": "%d/12" % p, "area_sf": 100.0 * p, "squares": float(p), "pct": None}
           for p in (1, 4, 6, 8, 12, 18, 24)]  # the hand-entered 7-row table (manual_entry)
OID = "3b4622fb-65bd-4b04-b056-1eab4b59a187"
NOW = "2026-10-14T08:00:00Z"


def fixtures():
    return {
        "hover_orders": [{"id": OID, "claim_id": syn.CLAIM_ID, "product_code": "roof_upgrade_detailed",
                          "status": "awaiting_fulfillment", "report_url": None, "measurements_json": None,
                          "fulfilled_at": None, "requested_by_contractor_id": syn.BUYER_CONTRACTOR_ID}],
        "claims": [{"id": syn.CLAIM_ID, "is_test": True, "measurement_shape": None,
                    "live_charge_authorized_at": "2026-09-05 19:26:43+00",
                    "hover_measurements": {"source": "manual_entry", "squares": 63.05, "predominant_pitch": "8/12",
                                           "areas_by_pitch": copy.deepcopy(PITCHES)}}],
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
        self.assertEqual(db["claims"][0]["hover_measurements"]["areas_by_pitch"], PITCHES)  # gh-1411 must-fix (b)

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

    def test_missing_or_empty_pitch_table_refused(self):
        for bad in (None, [], "6/12"):
            db = fixtures(); db["claims"][0]["hover_measurements"]["areas_by_pitch"] = bad
            rc, f, lines = go(db, True, syn.RULING)
            self.assertEqual((rc, f.writes), (2, []), bad)
            self.assertTrue(any("areas_by_pitch" in l for l in lines))

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
        self.assertTrue(syn.check_after({"status": "awaiting_fulfillment"}, {"measurement_shape": None},
                                        fixtures()["claims"][0]))


class MustFixB(unittest.TestCase):
    """gh-1411 must-fix (b): the run must not overwrite the claim's hand-entered pitch table.
    Each test fails against main d66ede2f (synthetic_measurements hard-coded one 6/12 row)."""

    def test_plan_2_and_3_objects_carry_the_same_seven_rows(self):  # NEGATIVE CONTROL
        db = fixtures()
        steps = syn.build_steps(db["hover_orders"][0], db["claims"][0], NOW)
        order_obj = steps[1][3]["measurements_json"]
        claim_obj = steps[2][3]["hover_measurements"]
        self.assertEqual(len(PITCHES), 7)
        self.assertEqual(order_obj["areas_by_pitch"], PITCHES)
        self.assertEqual(claim_obj["areas_by_pitch"], PITCHES)
        self.assertEqual(claim_obj["predominant_pitch"], "8/12")
        self.assertEqual((claim_obj["source"], claim_obj["prior_source"]), ("synthetic_e2e_gh1411", "manual_entry"))
        self.assertEqual(claim_obj["squares"], 63.05)

    def test_copy_is_deep(self):
        db = fixtures()
        m = syn.synthetic_measurements(db["claims"][0]["hover_measurements"], NOW)
        m["areas_by_pitch"][0]["pitch"] = "mutated"
        self.assertEqual(db["claims"][0]["hover_measurements"]["areas_by_pitch"], PITCHES)

    def test_after_check_fails_when_pitch_table_replaced(self):  # NEGATIVE CONTROL
        db = fixtures()
        before = copy.deepcopy(db["claims"][0])
        steps = syn.build_steps(db["hover_orders"][0], db["claims"][0], NOW)
        order = dict(db["hover_orders"][0], status="completed", fulfilled_at=NOW, measurements_json=steps[1][3]["measurements_json"])
        claim = dict(before, live_charge_authorized_at=None, measurement_shape="full",
                     hover_measurements=steps[2][3]["hover_measurements"])
        self.assertEqual(syn.check_after(order, claim, before), [])
        clobbered = copy.deepcopy(claim)
        clobbered["hover_measurements"]["areas_by_pitch"] = [{"pitch": "6/12", "area_sf": 6305.0, "squares": 63.05, "pct": None}]
        self.assertTrue(any("areas_by_pitch changed" in b for b in syn.check_after(order, clobbered, before)))

    def test_run_returns_4_if_a_write_clobbers_the_table(self):
        class Clobber(FakeRest):
            def patch(self, table, flt, patch):
                if table == "claims" and "hover_measurements" in patch:
                    patch = dict(patch, hover_measurements=dict(patch["hover_measurements"], areas_by_pitch=[{"pitch": "6/12"}]))
                return super().patch(table, flt, patch)
        f, lines = Clobber(fixtures()), []
        self.assertEqual(syn.run(f, True, syn.RULING, NOW, out=lines.append), 4)
        self.assertTrue(any("areas_by_pitch changed" in l for l in lines))


def _b64(d):
    import base64
    import json
    return base64.urlsafe_b64encode(json.dumps(d, separators=(",", ":")).encode()).rstrip(b"=").decode()


# Fake credentials are ASSEMBLED AT RUN TIME so no secret-shaped literal is committed
# (Credential Shape Sweep and GitGuardian both flag a committed JWT-shaped string).
SECRETISH = "sb_" + "secret_" + "TESTONLY" + "abcdef0123456789"
JWTISH = ".".join([_b64({"alg": "HS256"}), _b64({"role": "service_role"}), "TESTONLY" + "sig"])


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
        """Must FAIL against the pre-fix script: main has to refuse the argv by position,
        before reading the environment, building a client or touching the network."""
        import contextlib
        import io
        import os
        from unittest import mock
        for argv in (["--execute", SECRETISH], [JWTISH], ["--ruling", SECRETISH]):
            buf = io.StringIO()
            env = {"SUPABASE_URL": "https://abcdefgh.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "k" * 8}
            with mock.patch.dict(os.environ, env), \
                 mock.patch.object(syn, "load_service_key", side_effect=AssertionError("env read after bad argv")), \
                 mock.patch.object(syn, "Rest", side_effect=AssertionError("client built after bad argv")), \
                 contextlib.redirect_stdout(buf):
                rc = syn.main(argv)
            out = buf.getvalue()
            self.assertEqual(rc, 1, argv)
            self.assertIn("REFUSED: unexpected command-line argument #", out)
            self.assertIn("values not shown", out)
            self.assertNotIn(SECRETISH, out)
            self.assertNotIn(JWTISH, out)

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
        with self.assertRaises(RuntimeError):  # the mock returns [] so PATCH matches 0 rows
            rest.patch("claims", {"id": "1"}, {"measurement_shape": "full"})
        self.assertEqual(len(seen), 2)
        self.assertTrue(all(SECRETISH not in u for u in seen))

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
        self.assertEqual(syn.load_service_key(env, opener), SECRETISH)  # legacy-only list: the fallback
        self.assertTrue(all("sbp_TESTONLY" not in u and SECRETISH not in u for u in seen))
        self.assertIsNone(syn.load_service_key({"SUPABASE_URL": "https://abcdefgh.supabase.co"}, opener))

    def test_management_api_prefers_secret_type_key_over_legacy_service_role(self):  # NEGATIVE CONTROL
        """gh-1411 must-fix (a). Fails against main d66ede2f, which returns the legacy value."""
        legacy = "LEGACY" + "JWTISH" + "TESTONLY"
        secret = "sb_" + "secret_" + "TESTONLY" + "rotated0123456789"
        listing = [{"name": "anon", "type": "legacy", "api_key": "anon-" + "TESTONLY"},
                   {"name": "service_role", "type": "legacy", "api_key": legacy},
                   {"name": "default", "type": "publishable", "api_key": "sb_" + "publishable_" + "TESTONLY"},
                   {"name": "rotated_x", "type": "secret", "api_key": secret}]
        import json
        body = json.dumps(listing).encode()

        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return body
        seen, noted = [], []
        env = {"SUPABASE_ACCESS_TOKEN": "sbp_" + "TESTONLY" + "token0123456789", "SUPABASE_URL": "https://abcdefgh.supabase.co"}

        def opener(req, timeout=0):
            seen.append(req.full_url)
            return R()
        self.assertEqual(syn.load_service_key(env, opener, note=noted.append), secret)
        self.assertEqual(noted, ["rotated_x"])  # the NAME only
        self.assertNotIn(secret, repr(noted))
        self.assertTrue(all(secret not in u and legacy not in u for u in seen))

    def test_secret_key_pick_is_first_in_api_order_and_skips_empty(self):
        keys = [{"name": "service_role", "type": "legacy", "api_key": "L"},
                {"name": "empty", "type": "secret", "api_key": ""},
                {"name": "first_secret", "type": "secret", "api_key": "S1"},
                {"name": "second_secret", "type": "secret", "api_key": "S2"}]
        self.assertEqual(syn.pick_api_key(keys), ("first_secret", "S1"))
        self.assertEqual(syn.pick_api_key(list(reversed(keys))), ("second_secret", "S2"))

    def test_legacy_service_role_is_only_a_fallback(self):
        keys = [{"name": "anon", "type": "legacy", "api_key": "A"},
                {"name": "service_role", "type": "legacy", "api_key": "L"}]
        self.assertEqual(syn.pick_api_key(keys), ("service_role", "L"))
        self.assertIsNone(syn.pick_api_key([{"name": "anon", "type": "legacy", "api_key": "A"}]))
        self.assertIsNone(syn.pick_api_key([]))

    def test_main_prints_key_name_never_value(self):
        import contextlib
        import io
        import os
        from unittest import mock
        buf = io.StringIO()
        keys = [{"name": "rotated_x", "type": "secret", "api_key": SECRETISH}]
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "https://abcdefgh.supabase.co",
                                          "SUPABASE_ACCESS_TOKEN": "sbp_" + "TESTONLY" + "token0123456789"}, clear=True), \
             mock.patch.object(syn, "open_no_redirect", side_effect=AssertionError("unused")), \
             mock.patch.object(syn, "pick_api_key", wraps=syn.pick_api_key), \
             mock.patch.object(syn.urllib.request, "Request", wraps=syn.urllib.request.Request), \
             mock.patch.object(syn, "run", return_value=0), \
             contextlib.redirect_stdout(buf):
            def fake_opener(req, timeout=0):
                import json as _j

                class R:
                    def __enter__(s): return s
                    def __exit__(s, *a): return False
                    def read(s): return _j.dumps(keys).encode()
                return R()
            orig = syn.load_service_key
            with mock.patch.object(syn, "load_service_key", lambda e, note=None: orig(e, fake_opener, note)):
                self.assertEqual(syn.main([]), 0)
        self.assertIn("rotated_x", buf.getvalue())
        self.assertNotIn(SECRETISH, buf.getvalue())

    def test_source_has_no_secret_on_cli_patterns(self):
        import re
        src = (HERE / "gh1411-synthetic-e2e.py").read_text()
        self.assertIsNone(re.search(r"(eyJ[A-Za-z0-9_-]{10,}\.|sb_secret_|sbp_[A-Za-z0-9]{10,})", src))
        self.assertNotIn("sys.argv[", src.replace("main(sys.argv[1:])", ""))


class StripeLiveGuard(unittest.TestCase):
    """Synthetic only: Stripe TEST mode, never live. Fails against main d66ede2f (no guard)."""
    LIVE = ("sk_" + "live_" + "TESTONLY" + "abcdef0123456789", "rk_" + "live_" + "TESTONLY" + "abcdef0123456789",
            "pk_" + "live_" + "TESTONLY" + "abcdef0123456789", "Bearer sk_" + "live_" + "TESTONLY" + "abcdef")
    TEST = ("sk_" + "test_" + "TESTONLY" + "abcdef0123456789", "pk_" + "test_" + "TESTONLY" + "abcdef0123456789")

    def test_live_vars_detected_by_name_only(self):  # NEGATIVE CONTROL
        for i, v in enumerate(self.LIVE):
            self.assertEqual(syn.live_stripe_vars({"STRIPE_SECRET_KEY": v, "OTHER": "x"}), ["STRIPE_SECRET_KEY"], i)
        for v in self.TEST + ("", "ask_live_nope", "task_live_x"):
            self.assertEqual(syn.live_stripe_vars({"STRIPE_SECRET_KEY": v}), [], v)

    def test_main_refuses_before_reading_any_key_or_touching_network(self):
        import contextlib
        import io
        import os
        from unittest import mock
        for v in self.LIVE:
            buf = io.StringIO()
            env = {"SUPABASE_URL": "https://abcdefgh.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": SECRETISH,
                   "STRIPE_SECRET_KEY": v}
            with mock.patch.dict(os.environ, env, clear=True), \
                 mock.patch.object(syn, "load_service_key", side_effect=AssertionError("key read with live Stripe key")), \
                 mock.patch.object(syn, "Rest", side_effect=AssertionError("client built with live Stripe key")), \
                 contextlib.redirect_stdout(buf):
                rc = syn.main(["--execute", "--ruling", syn.RULING])
            out = buf.getvalue()
            self.assertEqual(rc, 1)
            self.assertIn("REFUSED: a live-mode Stripe key", out)
            self.assertIn("STRIPE_SECRET_KEY", out)
            self.assertNotIn(v, out)
            self.assertNotIn(SECRETISH, out)

    def test_test_mode_stripe_key_does_not_block(self):
        import contextlib
        import io
        import os
        from unittest import mock
        buf = io.StringIO()
        env = {"SUPABASE_URL": "https://abcdefgh.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": SECRETISH,
               "STRIPE_SECRET_KEY": self.TEST[0]}
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(syn, "run", return_value=0), contextlib.redirect_stdout(buf):
            self.assertEqual(syn.main([]), 0)

    def test_script_never_references_stripe_api(self):
        src = (HERE / "gh1411-synthetic-e2e.py").read_text()
        self.assertNotIn("api.stripe.com", src)
        self.assertNotIn("import stripe", src)


class FakeHTTP:
    """An opener standing in for PostgREST over HTTP: records every request, serves the
    in-memory db, and applies PATCHes. Lets run() exercise the real Rest.patch path."""

    def __init__(self, db):
        self.db, self.reqs = db, []

    class _Resp:
        def __init__(s, body): s.body = body
        def __enter__(s): return s
        def __exit__(s, *a): return False
        def read(s): return s.body

    def __call__(self, req, timeout=0):
        import json
        import urllib.parse
        self.reqs.append(req)
        parts = urllib.parse.urlsplit(req.full_url)
        table = parts.path.rsplit("/", 1)[1]
        flt = {k: v[3:] for k, v in urllib.parse.parse_qsl(parts.query) if v.startswith("eq.")}
        rows = [r for r in self.db[table] if all(str(r.get(k)) == v for k, v in flt.items())]
        if req.get_method() == "PATCH":
            for r in rows:
                r.update(json.loads(req.data.decode()))
        return self._Resp(json.dumps(rows).encode())


class PatchPathAndGuards(unittest.TestCase):
    KEY = SECRETISH

    def test_patch_path_through_rest_with_mock_http(self):
        """The three PATCHes go out through the real Rest.patch: right method, right URL,
        key only in headers, never in a URL or a body, and run() reaches AFTER-STATE OK."""
        import json
        db = fixtures()
        http, lines = FakeHTTP(db), []
        rest = syn.Rest("https://abcdefgh.supabase.co", self.KEY, http)
        rc = syn.run(rest, True, syn.RULING, NOW, out=lines.append)
        self.assertEqual(rc, 0, lines)
        patches = [r for r in http.reqs if r.get_method() == "PATCH"]
        self.assertEqual(len(patches), 3)
        self.assertEqual([r.full_url.split("/rest/v1/")[1].split("?")[0] for r in patches],
                         ["claims", "hover_orders", "claims"])
        self.assertEqual(json.loads(patches[0].data.decode()), {"live_charge_authorized_at": None})
        for r in http.reqs:
            self.assertNotIn(self.KEY, r.full_url)
            self.assertTrue(r.full_url.startswith("https://abcdefgh.supabase.co/rest/v1/"))
            self.assertEqual(r.get_header("Apikey"), self.KEY)
            self.assertNotIn(self.KEY, (r.data or b"").decode())
        self.assertNotIn(self.KEY, "\n".join(lines))
        self.assertEqual(db["claims"][0]["measurement_shape"], "full")

    def test_patch_refuses_other_than_exactly_one_row(self):
        http = FakeHTTP(fixtures())
        rest = syn.Rest("https://abcdefgh.supabase.co", self.KEY, http)
        with self.assertRaises(RuntimeError):
            rest.patch("claims", {"id": "no-such-claim"}, {"measurement_shape": "full"})

    EVIL = ("https://realref.evil.example?.supabase.co", "https://realref.evil.example#.supabase.co",
            "https://realref.evil.example/?x=.supabase.co", "http://abcdefgh.supabase.co",
            "https://abcdefgh.supabase.co.evil.example", "https://abcdefgh.supabase.co@evil.example",
            "https://evil.example@abcdefgh.supabase.co", "https://abcdefgh.supabase.co:8443",
            "https://a.b.supabase.co", "https://supabase.co", "https://abcdefgh.supabase.co/x",
            "https://abcdefgh.supabase.co?x=1", "https://abcdefgh.supabase.co#f", "ftp://abcdefgh.supabase.co",
            "", "abcdefgh.supabase.co")

    def test_supabase_ref_accepts_only_exact_project_host(self):
        self.assertEqual(syn.supabase_ref("https://abcdefgh.supabase.co"), "abcdefgh")
        self.assertEqual(syn.supabase_ref("https://abcdefgh.supabase.co/"), "abcdefgh")
        for u in self.EVIL:
            self.assertIsNone(syn.supabase_ref(u), u)

    def test_old_host_check_was_spoofable_control(self):  # FAILING CONTROL for the guard above
        def old_ref(url):
            host = url.replace("https://", "").split("/")[0]
            return host.split(".")[0] if host.endswith(".supabase.co") else ""
        self.assertEqual(old_ref("https://realref.evil.example?.supabase.co"), "realref")
        self.assertIsNone(syn.supabase_ref("https://realref.evil.example?.supabase.co"))

    def test_load_key_makes_no_request_for_spoofed_url(self):
        calls = []
        def opener(req, timeout=0):
            calls.append(req.full_url)
            raise AssertionError("request made for a spoofed SUPABASE_URL")
        for u in self.EVIL:
            env = {"SUPABASE_ACCESS_TOKEN": "sbp_" + "TESTONLY" + "token0123456789", "SUPABASE_URL": u}
            self.assertIsNone(syn.load_service_key(env, opener), u)
        self.assertEqual(calls, [])

    def test_rest_and_main_refuse_spoofed_url(self):
        import contextlib
        import io
        import os
        from unittest import mock
        for u in self.EVIL:
            if u:
                with self.assertRaises(ValueError):
                    syn.Rest(u, self.KEY, FakeHTTP(fixtures()))
        for u in self.EVIL[:3]:
            buf = io.StringIO()
            with mock.patch.dict(os.environ, {"SUPABASE_URL": u, "SUPABASE_SERVICE_ROLE_KEY": self.KEY}), \
                 mock.patch.object(syn, "run", side_effect=AssertionError("run reached")), \
                 contextlib.redirect_stdout(buf):
                self.assertEqual(syn.main([]), 1)
            self.assertNotIn(self.KEY, buf.getvalue())
            self.assertNotIn(u, buf.getvalue())

    def test_ruling_accepts_ascii_digits_only(self):
        self.assertEqual(syn.bad_argv(["--execute", "--ruling", "6050104990"]), [])
        for bad in ("\uff11\uff12\uff13", "\u0661\u0662", "12 3", "-1", "1.5", "", "12\n"):
            self.assertTrue(syn.bad_argv(["--ruling", bad]), repr(bad))
        self.assertTrue("\uff11\uff12\uff13".isdigit())  # FAILING CONTROL: why isdigit() was not enough

    def _redirect_servers(self):
        import http.server
        import threading
        seen = {"target": [], "origin": 0}

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(h):
                seen["target"].append({k.lower(): v for k, v in h.headers.items()})
                h.send_response(200); h.end_headers(); h.wfile.write(b"[]")
            def log_message(h, *a): pass
        tgt = http.server.HTTPServer(("127.0.0.1", 0), Target)

        class Origin(http.server.BaseHTTPRequestHandler):
            def do_GET(h):
                seen["origin"] += 1
                h.send_response(302)
                h.send_header("Location", "http://127.0.0.1:%d/steal" % tgt.server_port)
                h.end_headers()
            def log_message(h, *a): pass
        org = http.server.HTTPServer(("127.0.0.1", 0), Origin)
        for srv in (tgt, org):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: [x.shutdown() or x.server_close() for x in (tgt, org)])
        return "http://127.0.0.1:%d/start" % org.server_port, seen

    def _credentialed_request(self, url):
        import urllib.request
        return urllib.request.Request(url, headers={"apikey": self.KEY, "Authorization": "Bearer " + self.KEY})

    def test_redirect_is_refused_and_credentials_not_forwarded(self):
        import urllib.error
        url, seen = self._redirect_servers()
        with self.assertRaises(urllib.error.HTTPError) as cm:
            syn.open_no_redirect(self._credentialed_request(url), timeout=5)
        self.assertEqual(cm.exception.code, 302)
        cm.exception.close()
        self.assertEqual((seen["origin"], seen["target"]), (1, []))

    def test_default_urlopen_forwards_credentials_on_redirect_control(self):  # FAILING CONTROL
        import urllib.request
        url, seen = self._redirect_servers()
        urllib.request.urlopen(self._credentialed_request(url), timeout=5).close()
        self.assertEqual(len(seen["target"]), 1)
        self.assertEqual(seen["target"][0].get("apikey"), self.KEY)

    def test_rest_and_load_key_default_to_no_redirect_opener(self):
        import inspect
        self.assertIs(syn.Rest("https://abcdefgh.supabase.co", self.KEY).opener, syn.open_no_redirect)
        self.assertIs(inspect.signature(syn.load_service_key).parameters["opener"].default, syn.open_no_redirect)


if __name__ == "__main__":
    unittest.main(verbosity=2)
