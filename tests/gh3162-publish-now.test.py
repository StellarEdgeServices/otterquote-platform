#!/usr/bin/env python3
"""Unit test for tools/publish-now.py pure functions (gh-3162). No network. Run: python3 tests/gh3162-publish-now.test.py"""
import importlib.util, os, unittest
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pn", os.path.join(here, "..", "tools", "publish-now.py"))
pn = importlib.util.module_from_spec(spec); spec.loader.exec_module(pn)
SHA = "a" * 40

class T(unittest.TestCase):
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
        self.assertTrue(pn.review_ok([P("PASS", SHA), P("FAIL", OLD)], SHA))            # FAIL on another head is irrelevant
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
