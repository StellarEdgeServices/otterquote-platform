#!/usr/bin/env python3
"""Tests for tools/indexnow_submit.py (gh-2423). Run: python3 tools/indexnow_submit.test.py"""
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("indexnow_submit", os.path.join(HERE, "indexnow_submit.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

KEY = "0123456789abcdef" * 2  # fake test key
SITEMAP = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://otterquote.com/</loc></url>
  <url><loc>https://otterquote.com/faq.html</loc></url>
  <url><loc>https://otterquote.com/locations/a-county-oh/roofing/</loc></url>
  <url><loc>https://other.example/x.html</loc></url>
</urlset>"""


def run_main(argv, tmp):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(M, "REPO", tmp), redirect_stdout(out), redirect_stderr(err):
        code = M.main(argv)
    return code, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.tmp = self.d.name
        with open(os.path.join(self.tmp, "sitemap.xml"), "w") as f:
            f.write(SITEMAP)
        with open(os.path.join(self.tmp, KEY + ".txt"), "w") as f:
            f.write(KEY)
        self.sm = os.path.join(self.tmp, "sitemap.xml")

    def tearDown(self):
        self.d.cleanup()


class T(Base):
    def test_sitemap_parsing(self):
        self.assertEqual(len(M.parse_sitemap(self.sm)), 4)
        code, out, _ = run_main(["--sitemap", self.sm], self.tmp)
        self.assertEqual(code, 0)
        self.assertIn("DRY RUN: 3 URL(s)", out)  # other-host loc skipped

    def test_loc_to_sources(self):
        self.assertEqual(M.loc_to_sources("https://otterquote.com/"), ["index.html"])
        self.assertEqual(M.loc_to_sources("https://otterquote.com/faq.html"), ["faq.html"])
        self.assertEqual(M.loc_to_sources("https://otterquote.com/locations/a/roofing/"), ["locations/a/roofing/index.html"])

    def test_since_mapping(self):
        locs = [u for u in M.parse_sitemap(self.sm) if M.host_of(u) == M.HOST]
        changed = {"faq.html", "locations/a-county-oh/roofing/index.html", "not-in-sitemap.html", "tools/x.py"}
        with mock.patch.object(M, "changed_files", return_value=changed):
            self.assertEqual(M.urls_since(locs, "abc"), [
                "https://otterquote.com/faq.html", "https://otterquote.com/locations/a-county-oh/roofing/"])

    def test_since_real_git(self):
        sh = lambda *c: subprocess.run(c, cwd=self.tmp, check=True, capture_output=True)
        sh("git", "init", "-q"); sh("git", "config", "user.email", "t@t"); sh("git", "config", "user.name", "t")
        open(os.path.join(self.tmp, "faq.html"), "w").write("a")
        sh("git", "add", "-A"); sh("git", "commit", "-qm", "1")
        open(os.path.join(self.tmp, "faq.html"), "w").write("b")
        open(os.path.join(self.tmp, "index.html"), "w").write("b")
        sh("git", "add", "-A"); sh("git", "commit", "-qm", "2")
        locs = M.parse_sitemap(self.sm)
        self.assertEqual(M.urls_since(locs, "HEAD~1", self.tmp),
                         ["https://otterquote.com/", "https://otterquote.com/faq.html"])

    def test_host_refusal(self):
        code, out, err = run_main(["--urls", "https://evil.example/a.html"], self.tmp)
        self.assertNotEqual(code, 0)
        self.assertIn("REFUSED", err)
        self.assertNotIn("urlList", out)
        with self.assertRaises(M.Refusal):
            M.check_hosts(["https://otterquote.com.evil.example/x"])
        M.check_hosts(["https://otterquote.com/a.html"])

    def test_dry_run_sends_nothing(self):
        with mock.patch("urllib.request.urlopen") as uo:
            code, out, _ = run_main(["--sitemap", self.sm, "--dry-run"], self.tmp)
            code2, _, _ = run_main(["--sitemap", self.sm], self.tmp)
        self.assertEqual((code, code2), (0, 0))
        uo.assert_not_called()
        self.assertIn('"urlList"', out)

    def _resp(self, status, ctype, body):
        class R:
            def __init__(s):
                s.status, s.headers = status, {"Content-Type": ctype}
            def __enter__(s):
                return s
            def __exit__(s, *a):
                return False
            def read(s):
                return body.encode()
        return R()

    def test_key_mismatch_refuses_to_send(self):
        calls = []
        def fake(req, timeout=0):
            calls.append(req.full_url)
            return self._resp(200, "text/plain; charset=UTF-8", "wrong")
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            code, _, err = run_main(["--sitemap", self.sm, "--send"], self.tmp)
        self.assertNotEqual(code, 0)
        self.assertIn("does not match", err)
        self.assertEqual(calls, ["https://otterquote.com/%s.txt" % KEY])  # no POST made

    def test_wrong_content_type_and_404_refuse(self):
        with mock.patch("urllib.request.urlopen", return_value=self._resp(200, "text/html", KEY)):
            with self.assertRaises(M.Refusal):
                M.verify_live_key(KEY)
        import urllib.error
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("u", 404, "nf", {}, None)):
            with self.assertRaises(M.Refusal):
                M.verify_live_key(KEY)

    def test_missing_local_key_refuses(self):
        os.remove(os.path.join(self.tmp, KEY + ".txt"))
        with mock.patch("urllib.request.urlopen") as uo:
            code, _, err = run_main(["--sitemap", self.sm, "--send"], self.tmp)
        self.assertNotEqual(code, 0)
        self.assertIn("key file", err)
        uo.assert_not_called()

    def test_payload_shape_and_batching(self):
        p = M.build_payload(KEY, ["https://otterquote.com/"])
        self.assertEqual(p, {"host": "otterquote.com", "key": KEY,
                             "keyLocation": "https://otterquote.com/%s.txt" % KEY,
                             "urlList": ["https://otterquote.com/"]})
        self.assertEqual([len(b) for b in M.batches(list(range(25000)))], [10000, 10000, 5000])

    def test_send_success_and_failure_exit_codes(self):
        posts = []
        def fake(req, timeout=0):
            if req.get_method() == "POST":
                posts.append(req.data)
                return self._resp(202, "", "")
            return self._resp(200, "text/plain; charset=UTF-8", KEY)
        with mock.patch("urllib.request.urlopen", side_effect=fake):
            code, out, _ = run_main(["--sitemap", self.sm, "--send"], self.tmp)
        self.assertEqual(code, 0)
        self.assertIn("HTTP 202", out)
        self.assertEqual(len(posts), 1)
        with mock.patch.object(M, "verify_live_key"), mock.patch.object(M, "post", return_value=403):
            code, out, _ = run_main(["--sitemap", self.sm, "--send"], self.tmp)
        self.assertEqual(code, 1)
        self.assertIn("HTTP 403", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
