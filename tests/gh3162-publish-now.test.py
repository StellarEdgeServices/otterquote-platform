#!/usr/bin/env python3
"""Unit test for tools/publish-now.py pure functions (gh-3162). No network. Run: python3 tests/gh3162-publish-now.test.py"""
import importlib.util, os, unittest
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pn", os.path.join(here, "..", "tools", "publish-now.py"))
pn = importlib.util.module_from_spec(spec); spec.loader.exec_module(pn)
SHA = "a" * 40

class T(unittest.TestCase):
    def test_clean_pass_real_shas(self):
        H = "0243951a8e6777a6d39c76ef9d7bb5e4a716ea46"; O = "18ae16fa827884520e3539caf0145cdd3b006674"
        ok = "REVIEW: PASS\nhead: %s\n\nSee 6505286731 and 6504914587; the code is defaced-free.\nprior head %s was reviewed" % (H, H[:7])
        self.assertTrue(pn.clean_pass(ok, H, "REVIEW"))
        bad = "REVIEW: PASS\nhead: %s\n\nAlso compared against %s" % (H, O)
        self.assertTrue(pn.clean_pass(bad, H, "REVIEW"))  # round 4: other shas in a PASS body are allowed
        bad2 = "REVIEW: PASS\nhead: %s\n\nshort other sha %s" % (H, O[:9])
        self.assertTrue(pn.clean_pass(bad2, H, "REVIEW"))

    def test_step_merge_stub(self):
        """Round 5 (6505893965): step_merge must run end to end against a stub GitHub (no UnboundLocalError)."""
        H = "0243951a8e6777a6d39c76ef9d7bb5e4a716ea46"; who = {"login": "dustinstohler1-dotcom", "type": "User"}
        def mk(i, t, body): return {"id": i, "created_at": t, "updated_at": t, "body": body, "user": who, "author_association": "OWNER"}
        PASS = "REVIEW: PASS\nhead: " + H + "\n\nok"
        class Stub:
            def __init__(s, comments, reviews=(), inline=()):
                s.c, s.r, s.i, s.enq = comments, list(reviews), list(inline), 0
            def gh(s, m, path, body=None):
                if path.endswith("/pulls/3202"): return 200, {"merged": s.enq > 0, "state": "open", "head": {"sha": H}, "labels": [], "title": "t", "merge_commit_sha": "f" * 40}, ""
                import re as _re; m = _re.search(r"[?&]page=(\d+)", path); pg = int(m.group(1)) if m else 1
                if "/issues/3202/comments" in path: return 200, (s.c if pg == 1 else []), ""
                if "/pulls/3202/reviews" in path: return 200, (s.r if pg == 1 else []), ""
                if "/pulls/3202/comments" in path: return 200, (s.i if pg == 1 else []), ""
                if "/check-runs" in path: return 200, {"check_runs": [{"name": k, "status": "completed", "conclusion": "success", "started_at": "1"} for k in pn.REQUIRED_CHECKS]}, ""
                raise AssertionError(path)
            def gql(s, q, v=None):
                if "mutation" in q: s.enq += 1; return 200, {"data": {"enqueuePullRequest": {"mergeQueueEntry": {"id": "x"}}}}
                return 200, {"data": {"repository": {"pullRequest": {"id": "PR_x", "isInMergeQueue": False}}}}
        orig_sleep = pn.time.sleep; pn.time.sleep = lambda x: None
        try:
            st = Stub([mk(1, "2026-10-29T18:00:00Z", PASS)])
            self.assertEqual(pn.step_merge(st, 3202), "f" * 40); self.assertEqual(st.enq, 1)
            for blocked in (Stub([mk(1, "2026-10-29T18:00:00Z", PASS), mk(2, "2026-10-29T18:30:00Z", "REVIEW: FAIL\nhead: " + H)]),
                            Stub([mk(1, "2026-10-29T18:00:00Z", PASS)], reviews=[{"id": 9, "state": "COMMENTED", "body": "REVIEW: FAIL", "submitted_at": "2026-10-29T18:40:00Z", "user": who, "author_association": "OWNER"}]),
                            Stub([mk(1, "2026-10-29T18:00:00Z", PASS)], inline=[{"id": 8, "body": "review: fail here", "created_at": "2026-10-29T18:41:00Z", "user": who, "author_association": "OWNER"}])):
                with self.assertRaises(SystemExit) as cm:
                    pn.step_merge(blocked, 3202)
                self.assertEqual(cm.exception.code, 2); self.assertEqual(blocked.enq, 0)
        finally:
            pn.time.sleep = orig_sleep

    def test_sites(self):
        self.assertEqual(pn.sites_for_files(["news/x.html"]), {"jade"})
        self.assertEqual(pn.sites_for_files(["react-app/src/a.tsx"]), {"app"})
        self.assertEqual(pn.sites_for_files(["news/x.html", "react-app/src/a.tsx"]), {"jade", "app"})
        self.assertEqual(pn.sites_for_files(["react-app/app/lib/attribution-core.ts"]), {"app", "jade"})
        self.assertEqual(pn.sites_for_files(["tests/a.mjs", "README.md", "tools/x.py", ".github/workflows/a.yml", "sql/1.sql"]), set())
        self.assertEqual(pn.sites_for_files(["css/site.css"]), {"jade"})
    def test_urls(self):
        self.assertEqual(pn.url_for_path("news/roof-buying-season.html"), "https://otterquote.com/news/roof-buying-season.html")
        self.assertEqual(pn.url_for_path("index.html"), "https://otterquote.com/")
        self.assertEqual(pn.url_for_path("locations/in/index.html"), "https://otterquote.com/locations/in/")
        self.assertIsNone(pn.url_for_path("tools/publish-now.py"))
        self.assertIsNone(pn.url_for_path("_redirects"))
        self.assertIsNone(pn.url_for_path("react-app/a.html"))
        self.assertEqual(pn.expand_paths("a.html,b/", ["b/1.html", "b/2.html", "c/3.html"]), ["a.html", "b/1.html", "b/2.html"])
    def test_sitemap(self):
        x = "<urlset><url><loc>https://otterquote.com/a.html</loc></url><url><loc> https://otterquote.com/ </loc></url></urlset>"
        locs = pn.sitemap_locs(x)
        self.assertTrue(pn.listed_in_sitemap("https://otterquote.com/a.html", locs))
        self.assertTrue(pn.listed_in_sitemap("https://otterquote.com/", locs))
        self.assertFalse(pn.listed_in_sitemap("https://otterquote.com/b.html", locs))
    def test_format(self):
        self.assertEqual(pn.format_line(True, "https://otterquote.com/a.html", 200, "yes"), "PASS https://otterquote.com/a.html 200 sitemap=yes")
        self.assertEqual(pn.format_line(False, "https://otterquote.com/z.html", 404, "n/a"), "FAIL https://otterquote.com/z.html 404 sitemap=n/a")
        self.assertEqual(pn.judge_url(200, True, True), (True, "yes"))
        self.assertEqual(pn.judge_url(200, True, False), (False, "no"))
        self.assertEqual(pn.judge_url(404, False, False), (False, "n/a"))
        self.assertEqual(pn.judge_url(200, False, False), (True, "n/a"))
    def test_gates(self):
        P = lambda v, h, pre="REVIEW": "%s: %s\nhead: %s\nStamp: x" % (pre, v, h)
        OLD = "b" * 40
        self.assertTrue(pn.review_ok([P("PASS", SHA)], SHA))
        self.assertFalse(pn.review_ok([P("PASS", OLD)], SHA))
        self.assertFalse(pn.review_ok(["note REVIEW: PASS\nhead: " + SHA], SHA))
        self.assertFalse(pn.review_ok(["REVIEW: PASS head " + SHA], SHA))  # no `head:` line
        # B1: newest ruling on the exact head wins
        self.assertFalse(pn.review_ok([P("PASS", SHA), P("FAIL", SHA)], SHA))           # PASS then FAIL -> refuse
        self.assertTrue(pn.review_ok([P("FAIL", SHA), P("PASS", SHA)], SHA))            # FAIL then PASS -> allow
        self.assertFalse(pn.review_ok([P("PASS", OLD) + "\nre-review pending for " + SHA[:7]], SHA))  # short sha mention
        self.assertFalse(pn.review_ok(["REVIEW: PASS\nhead: " + SHA[:12]], SHA))        # short sha in head line
        self.assertFalse(pn.review_ok([P("PASS", SHA), P("FAIL", OLD)], SHA))           # fail-closed: FAIL on an old head AFTER the PASS blocks
        self.assertEqual(pn.r177_pair([P("PASS", SHA, "LEGAL-READ"), "R-177 SIGNED: pr=5 sha=" + SHA], 5, SHA), (True, True))
        self.assertEqual(pn.r177_pair([P("PASS", SHA, "LEGAL-READ"), P("FAIL", SHA, "LEGAL-READ")], 5, SHA), (False, False))
        self.assertEqual(pn.r177_pair([P("QUESTION FOR DUSTIN", SHA, "LEGAL-READ"), P("PASS", SHA, "LEGAL-READ")], 5, SHA)[0], True)
        self.assertEqual(pn.r177_pair([P("PASS", SHA, "LEGAL-READ") + " " + SHA[:7]], 5, SHA)[0], True)
        self.assertEqual(pn.r177_pair([P("PASS", OLD, "LEGAL-READ") + "\n" + SHA], 5, SHA), (False, False))
        self.assertEqual(pn.r177_pair(["R-177 SIGNED: Ben, CEO\nHead: " + SHA], 5, SHA), (False, True))
        self.assertEqual(pn.r177_pair(["R-177 SIGNED: pr=5 sha=" + SHA[:7]], 5, SHA), (False, False))  # short sha
        self.assertEqual(pn.r177_pair(["R-177 SIGNED: Ben\nHead: " + SHA[:7]], 5, SHA), (False, False))
        self.assertTrue(pn.needs_r177("x", ["r177:legal-read"]))
        self.assertFalse(pn.needs_r177("x", []))
        self.assertFalse(pn.trusted_human({"user": {"login": "x", "type": "User"}, "author_association": "NONE"}))
        self.assertFalse(pn.trusted_human({"user": {"login": "github-actions[bot]", "type": "Bot"}, "author_association": "MEMBER"}))
    def test_b1prime_adversarial(self):
        H = "bd6813d37b7955baf56f6996d7ef715920acffc2"; O = "e0e6e0d64d0b2cfca7b266a95a9e698d8eb94bb9"
        P = lambda h=H, x="": "REVIEW: PASS\nhead: %s%s\nbody" % (h, x)
        F = lambda h=H, x="": "REVIEW: FAIL\nhead: %s%s\nbody" % (h, x)
        cases = [
            ("PASS then FAIL", [P(), F()], False),
            ("FAIL then PASS", [F(), P()], True),
            ("PASS old, mentions short new", ["REVIEW: PASS\nhead: %s\nre-review for bd6813d" % O], False),
            ("PASS short head line", ["REVIEW: PASS\nhead: bd6813d"], False),
            ("PASS head trailing chars", [P(x=" (fix)")], False),
            ("PASS then FAIL head trailing chars", [P(), F(x=" (re-review)")], False),
            ("PASS then FAIL em-dash", [P(), "REVIEW: FAIL \u2014 B1\nhead: %s" % H], False),
            ("PASS then bold FAIL", [P(), "**REVIEW: FAIL**\nhead: %s" % H], False),
            ("PASS then backtick/quote FAIL", [P(), "> `REVIEW: FAIL`\nhead: %s" % H], False),
            ("PASS then lowercase fail", [P(), "REVIEW: fail\nhead: %s" % H], False),
            ("PASS then QUESTION", [P(), "REVIEW: QUESTION\nhead: %s" % H], False),
            ("PASS then FAIL head on line 7", [P(), "REVIEW: FAIL\na\nb\nc\nd\ne\nhead: %s" % H], False),
            ("PASS then FAIL naming H only in prose", [P(), "REVIEW: FAIL on %s" % H], False),
            ("two head lines H,O PASS", ["REVIEW: PASS\nhead: %s\nhead: %s" % (H, O)], False),
            ("two head lines O,H PASS", ["REVIEW: PASS\nhead: %s\nhead: %s" % (O, H)], False),
            ("PASS then FAIL heads O,H", [P(), "REVIEW: FAIL\nhead: %s\nhead: %s" % (O, H)], False),
            ("PASS uppercase sha", ["REVIEW: PASS\nhead: %s" % H.upper()], True),
            ("PASS 41-hex", ["REVIEW: PASS\nhead: %sa" % H], False),
            ("PASS then FAIL 41-hex", [P(), "REVIEW: FAIL\nhead: %sa" % H], False),
            ("PASS leading blank line", ["  \nREVIEW: PASS\nhead: %s" % H], True),
            ("PASS not first line", ["note\nREVIEW: PASS\nhead: %s" % H], False),
            ("PASS trailing text", ["REVIEW: PASS with nits\nhead: %s" % H], False),
            ("PASS lowercase verdict", ["REVIEW: pass\nhead: %s" % H], False),
            ("CRLF PASS", ["REVIEW: PASS\r\nhead: %s\r\n" % H], True),
            ("FAIL on OLD head after PASS blocks (fail-closed)", [P(), F(O)], False),
        ]
        for name, b, exp in cases:
            self.assertEqual(pn.review_ok(b, H), exp, name)
        L = lambda v, h=H: "LEGAL-READ: %s\nhead: %s" % (v, h)
        S = "R-177 SIGNED: pr=3202 sha=%s" % H
        self.assertEqual(pn.r177_pair([L("PASS"), L("QUESTION FOR DUSTIN"), S], "3202", H), (False, True))
        self.assertEqual(pn.r177_pair([L("PASS"), L("FAIL"), S], "3202", H), (False, True))
        self.assertEqual(pn.r177_pair([L("QUESTION FOR DUSTIN"), L("PASS"), S], "3202", H), (True, True))
        self.assertEqual(pn.r177_pair([L("PASS"), "LEGAL-READ: QUESTION\nhead: " + H, S], "3202", H)[0], False)
        self.assertEqual(pn.r177_pair([L("PASS"), "**LEGAL-READ: FAIL**\nhead: " + H, S], "3202", H)[0], False)
        self.assertEqual(pn.r177_pair([L("PASS"), "R-177 SIGNED: pr=3202 sha=bd6813d"], "3202", H), (True, False))
        self.assertEqual(pn.r177_pair([L("PASS"), "R-177 SIGNED: pr=3202 sha=%sab" % H], "3202", H), (True, False))
        self.assertEqual(pn.r177_pair([L("PASS"), "R-177 SIGNED: pr=32021 sha=%s" % H], "3202", H), (True, False))
        th = pn.trusted_human
        self.assertFalse(th({"author_association": "MEMBER", "user": {"login": "x", "type": "Bot"}}))
        self.assertFalse(th({"author_association": "OWNER", "user": {"login": "github-actions[bot]", "type": "User"}}))
        self.assertFalse(th({"author_association": "CONTRIBUTOR", "user": {"login": "x", "type": "User"}}))
        self.assertTrue(th({"author_association": "NONE", "user": {"login": "dustinstohler1-dotcom", "type": "User"}}))
        self.assertTrue(th({"author_association": "MEMBER", "user": {"login": "x", "type": "User"}}))
        # out-of-order list sorted by (created_at,id) the way step_merge does; bots ignored both ways
        mk = lambda i, t, b, typ="User", login="a": {"id": i, "created_at": t, "body": b, "author_association": "MEMBER", "user": {"login": login, "type": typ}}
        cs = [mk(3, "2026-10-29T18:30:00Z", F()), mk(1, "2026-10-29T18:00:00Z", P()), mk(2, "2026-10-29T18:10:00Z", P(), "Bot", "bot[bot]")]
        cs = sorted(cs, key=lambda c: (c.get("created_at") or "", c.get("id") or 0))
        self.assertFalse(pn.review_ok([c["body"] for c in cs if th(c)], H))
        cs = [mk(1, "2026-10-29T18:00:00Z", P()), mk(9, "2026-10-29T18:40:00Z", F(), "Bot", "evil[bot]")]
        self.assertTrue(pn.review_ok([c["body"] for c in cs if th(c)], H))
    def test_failclosed_round3(self):
        H = "a9536ca38c5be2d78bd267d444576e425da1ddcc"; O = "bd6813d37b7955baf56f6996d7ef715920acffc2"
        P = "REVIEW: PASS\nhead: %s\nbody" % H
        def F(first, h=H, pre=""): return "%s\n%shead: %s\nx" % (first, pre, h)
        Z = "\u200b"
        cases = [
            ("ZWSP inside prefix", [P, F("REVIEW" + Z + ": FAIL")], False),
            ("ZWSP before line", [P, F(Z + "REVIEW: FAIL")], False),
            ("BOM before line", [P, F("\ufeffREVIEW: FAIL")], False),
            ("ZWJ after colon", [P, F("REVIEW:\u200d FAIL")], False),
            ("fullwidth colon", [P, F("REVIEW\uff1a FAIL")], False),
            ("ratio colon", [P, F("REVIEW\u2236 FAIL")], False),
            ("Cyrillic E", [P, F("R\u0415VIEW: FAIL")], False),
            ("Cyrillic E, other unmapped letter", [P, F("R\u04d5VIEW: FAIL")], False),
            ("NBSP after colon", [P, F("REVIEW:\u00a0FAIL")], False),
            ("heading", [P, F("## REVIEW: FAIL")], False),
            ("list", [P, F("- REVIEW: FAIL")], False),
            ("strike", [P, F("~~REVIEW: FAIL~~")], False),
            ("85 stars", [P, F("*" * 85 + "REVIEW: FAIL")], False),
            ("FAIL short sha only", [P, F("REVIEW: FAIL", h=H[:7])], False),
            ("FAIL 12-char sha", [P, F("REVIEW: FAIL", h=H[:12])], False),
            ("FAIL no sha at all", [P, "REVIEW: FAIL"], False),
            ("FAIL head on line 13", [P, F("REVIEW: FAIL", pre="l\n" * 11)], False),
            ("FAIL sha with ZWSP inside", [P, F("REVIEW: FAIL", h=H[:20] + Z + H[20:])], False),
            ("FAIL sha as URL", [P, "REVIEW: FAIL\nhead: https://github.com/x/y/commit/%s" % H], False),
            ("PASS + other sha after line 12 (allowed, round 4)", ["REVIEW: PASS\nhead: %s\n" % H + "l\n" * 12 + "```\n%s\n```" % O], True),
            ("PASS + other sha line 5 (allowed, round 4)", ["REVIEW: PASS\nhead: %s\na\nb\nprev %s" % (H, O)], True),
            ("PASS + own short sha anywhere", ["REVIEW: PASS\nhead: %s\n\n\nsee %s" % (H, H[:9])], True),
            ("PASS trailing space line1", ["REVIEW: PASS \nhead: %s" % H], True),
            ("PASS ZWSP after PASS", ["REVIEW: PASS" + Z + "\nhead: %s" % H], False),
            ("PASS ZWSP in head line", ["REVIEW: PASS\nhead: %s%s" % (H, Z)], False),
            ("huge FAIL body", [P, F("REVIEW: FAIL") + "y" * 5000000], False),
            ("huge first line", [P, "REVIEW: FAIL " + "z" * 2000000 + "\nhead: " + H], False),
            ("u2028 FAIL", [P, "REVIEW: FAIL\u2028head: " + H], False),
            ("quoted PASS in FAIL", [P, "> REVIEW: PASS\n> head: %s\nREVIEW: FAIL" % H], False),
            ("Review in lowercase prose first line", [P, "my review: not great\nhead: " + H], False),
            ("sentence containing review in first 40", [P, "Please see the REVIEW above"], False),
            ("clean PASS newest", [F("REVIEW: FAIL"), P], True),
            ("PASS then unrelated comment", [P, "thanks, merging after CI\nSee aaaaaaaa"], True),
            ("PASS then LEGAL-READ comment is not a REVIEW comment", [P, "LEGAL-READ: FAIL\nhead: " + H], True),
            ("FAIL on old head after PASS", [P, F("REVIEW: FAIL", h=O)], False),
            ("no review at all", ["hello"], False),
            ("empty list", [], False),
        ]
        for name, b, exp in cases:
            self.assertEqual(pn.review_ok(b, H), exp, name)
        L = "LEGAL-READ: PASS\nhead: " + H; S = "R-177 SIGNED: pr=3202 sha=" + H
        for name, bad in [("ZWSP", "LEGAL" + Z + "-READ: QUESTION FOR DUSTIN\nhead: " + H),
                          ("fullwidth colon", "LEGAL-READ\uff1a FAIL\nhead: " + H),
                          ("en dash", "LEGAL\u2013READ: FAIL\nhead: " + H),
                          ("no sha", "LEGAL-READ: FAIL"),
                          ("short sha", "legal-read: fail " + H[:7]),
                          ("old head", "LEGAL-READ: FAIL\nhead: " + "b" * 40)]:
            self.assertEqual(pn.r177_pair([L, bad, S], "3202", H), (False, True), name)
        self.assertEqual(pn.r177_pair([L, S], "3202", H), (True, True))
    def test_ordering_and_reviews(self):
        H = "a" * 40
        P = "REVIEW: PASS\nhead: %s" % H
        mk = lambda i, c, b, u=None: {"id": i, "created_at": c, "updated_at": u or c, "body": b}
        ok = lambda cs: pn.gate(cs, H, "REVIEW")
        # list order is irrelevant; created_at/id decide
        self.assertTrue(ok([mk(2, "2026-10-29T18:10:00Z", P), mk(1, "2026-10-29T18:00:00Z", "REVIEW: FAIL")])[0])
        self.assertEqual(ok([mk(2, "2026-10-29T18:10:00Z", "REVIEW: FAIL"), mk(1, "2026-10-29T18:00:00Z", P)])[:2], (False, 2))
        # tie on created_at -> higher id is newer
        t = "2026-10-29T18:00:00Z"
        self.assertEqual(ok([mk(5, t, P), mk(6, t, "REVIEW: FAIL")])[:2], (False, 6))
        self.assertTrue(ok([mk(6, t, "REVIEW: FAIL"), mk(7, t, P)])[0])
        # FAIL edited after the PASS is ordered by updated_at -> blocks
        self.assertEqual(ok([mk(1, "2026-10-29T18:00:00Z", "REVIEW: FAIL", "2026-10-29T19:00:00Z"),
                             mk(2, "2026-10-29T18:30:00Z", P)])[:2], (False, 1))
        # round 4 (6505483986): PASS edited after a later FAIL must NOT overtake it (PASS orders by created_at)
        self.assertFalse(ok([mk(1, "2026-10-29T18:00:00Z", P, "2026-10-29T19:00:00Z"),
                             mk(2, "2026-10-29T18:30:00Z", "REVIEW: FAIL")])[0])
        # round 4: a FAIL hidden below a letterless / HTML-comment / @mention first line still blocks
        for pre in ("---\n", "<!-- x -->\n", "@dustinstohler1-dotcom\n", "\U0001F534\n"):
            self.assertFalse(ok([mk(1, "2026-10-29T18:00:00Z", P), mk(2, "2026-10-29T18:30:00Z", pre + "REVIEW: FAIL")])[0], pre)
        # blocker id printed for a refusal; none when no review-ish comment
        self.assertEqual(ok([mk(9, t, "hi")]), (False, None, ""))
        # formal reviews
        good, bid, ts = ok([mk(1, "2026-10-29T18:00:00Z", P)])
        self.assertTrue(good)
        self.assertEqual(pn.reviews_block([{"id": 7, "state": "CHANGES_REQUESTED", "submitted_at": "2026-10-29T18:05:00Z"}], ts), 7)
        self.assertIsNone(pn.reviews_block([{"id": 7, "state": "CHANGES_REQUESTED", "submitted_at": "2026-10-29T17:59:00Z"}], ts))
        self.assertIsNone(pn.reviews_block([{"id": 8, "state": "APPROVED", "submitted_at": "2026-10-29T18:05:00Z"},
                                            {"id": 9, "state": "DISMISSED", "submitted_at": "2026-10-29T18:06:00Z"}], ts))
        # trusted filter still applies before the gate
        th = pn.trusted_human
        bot = {"id": 3, "created_at": "2026-10-29T19:00:00Z", "body": "REVIEW: FAIL", "author_association": "MEMBER", "user": {"login": "x[bot]", "type": "Bot"}}
        self.assertTrue(ok([c for c in [mk(1, "2026-10-29T18:00:00Z", P), bot] if th(c) or "user" not in c])[0])
        self.assertIn("reviews?per_page=100&page=%d", __import__("inspect").getsource(pn.step_merge))
    def test_n1_n2_wiring(self):
        import inspect
        self.assertIn("page=%d", inspect.getsource(pn.step_merge))
        self.assertEqual(inspect.signature(pn.Ctx.nl).parameters["timeout"].default, 60)
        self.assertEqual(inspect.getsource(pn.publish_site).count("timeout=15"), 4)
    def test_s2_s3_s6(self):
        ents = [{"filename": "a.html", "status": "modified"}, {"filename": "gone.html", "status": "removed"},
                {"filename": "new.html", "status": "renamed", "previous_filename": "old.html"}]
        allp, chk = pn.split_pr_files(ents)
        self.assertEqual(chk, ["a.html", "new.html"])
        self.assertEqual(sorted(allp), ["a.html", "gone.html", "new.html", "old.html"])
        self.assertEqual(pn.sites_for_files(["netlify.toml"]), {"jade"})
        self.assertEqual(pn.sites_for_files(["_headers"]), {"jade"})
        self.assertEqual(pn.sites_for_files(["react-app/netlify.toml"]), {"app"})
        self.assertEqual(pn.check_urls(["netlify.toml", "_redirects"]), ["https://otterquote.com/"])
        self.assertEqual(pn.check_urls(["netlify.toml", "a.html"]), ["https://otterquote.com/a.html", "https://otterquote.com/"])
        self.assertEqual(pn.check_urls(["a.html"]), ["https://otterquote.com/a.html"])
        self.assertEqual(pn.url_for_path(".well-known/security.txt"), "https://otterquote.com/.well-known/security.txt")
        self.assertIsNone(pn.url_for_path(".github/workflows/a.yml"))
        self.assertEqual(pn.sites_for_files([".well-known/security.txt"]), {"jade"})
        self.assertEqual(pn.empty_dirs("a.html,news/,x/", ["news/1.html"]), ["x/"])
        self.assertEqual(pn.empty_dirs("news/", []), ["news/"])
    def test_s4_redirect_guard(self):
        import urllib.request
        h = pn._SameOriginAuthRedirect()
        req = urllib.request.Request("https://api.github.com/x", headers={"Authorization": "Bearer t"})
        n1 = h.redirect_request(req, None, 302, "Found", {}, "https://objects.example.com/y")
        self.assertFalse(any(k.lower() == "authorization" for k in list(n1.headers) + list(n1.unredirected_hdrs)))
        n2 = h.redirect_request(req, None, 302, "Found", {}, "https://api.github.com/z")
        self.assertTrue(any(k.lower() == "authorization" for k in list(n2.headers) + list(n2.unredirected_hdrs)))
    def test_pick(self):
        ds = [{"id": "1", "state": "ready", "branch": "main", "commit_ref": "m1"}, {"id": "2", "state": "building", "branch": "main", "commit_ref": "m2"}]
        self.assertEqual(pn.pick_deploy(ds, "m1")["id"], "1")
        self.assertIsNone(pn.pick_deploy(ds, "m2"))
if __name__ == "__main__":
    unittest.main(verbosity=2)
