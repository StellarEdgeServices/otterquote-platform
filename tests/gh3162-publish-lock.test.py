#!/usr/bin/env python3
"""gh-3162 dry-run test: tools/publish-now.py publish_site() re-locks production on EVERY path.
Fake Netlify (no network, no credentials). Run: python3 tests/gh3162-publish-lock.test.py
Invariant under test: after publish_site returns or exits, the published deploy is locked, or the command exits
non-zero with the 'UNLOCKED' warning (never a silent unlocked site)."""
import contextlib, importlib.util, io, os, unittest
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("pn", os.path.join(here, "..", "tools", "publish-now.py"))
pn = importlib.util.module_from_spec(spec); spec.loader.exec_module(pn)
pn.time.sleep = lambda x: None
MERGE = "b" * 40


class FakeNetlify:
    """Models one site: a published deploy with a lock flag, plus a ready never-published main deploy for MERGE."""
    def __init__(self, fail_restore=None, raise_restore=False, fail_lock=False, old_locked=True, new_published=False):
        self.old = {"id": "old", "commit_ref": "a" * 40, "created_at": "2026-11-01T00:00:00Z", "locked": old_locked, "published_at": "x"}
        self.new = {"id": "new", "commit_ref": MERGE, "created_at": "2026-11-02T00:00:00Z", "locked": False, "state": "ready",
                    "branch": "main", "context": "production", "published_at": "y" if new_published else None}
        self.pub = self.old
        self.fail_restore, self.raise_restore, self.fail_lock = fail_restore, raise_restore, fail_lock
        self.calls = []

    def nl(self, method, path, timeout=60):
        self.calls.append((method, path))
        if method == "GET" and path.endswith("per_page=30"):
            return 200, [self.new]
        if method == "GET" and "/deploys" in path:
            return 200, [self.new]
        if method == "GET":
            return 200, {"published_deploy": dict(self.pub)}
        if path.endswith("/unlock"):
            self._d(path)["locked"] = False; return 200, {}
        if path.endswith("/lock"):
            if self.fail_lock: return 500, {}
            self._d(path)["locked"] = True; return 200, {}
        if path.endswith("/restore"):
            if self.raise_restore: raise OSError("network reset during restore")
            if self.fail_restore: return self.fail_restore, {}
            self.pub = self.new; self.new["locked"] = False; self.new["published_at"] = "z"; return 200, {}
        raise AssertionError((method, path))

    def _d(self, path):
        return self.new if "/new/" in path + "/" else self.old


def run(fake):
    buf = io.StringIO(); rc = None; exc = None
    with contextlib.redirect_stdout(buf):
        try:
            res = pn.publish_site(fake, "jade", MERGE)
        except SystemExit as e:
            rc = e.code; res = None
        except Exception as e:
            exc = e; res = None
    return res, rc, exc, buf.getvalue()


class T(unittest.TestCase):
    def test_happy_path_relocks(self):
        f = FakeNetlify(); res, rc, exc, out = run(f)
        self.assertEqual(res, ("ok", "new")); self.assertTrue(f.pub["locked"]); self.assertEqual(f.pub["id"], "new")

    def test_restore_http_error_relocks_old(self):
        f = FakeNetlify(fail_restore=500); res, rc, exc, out = run(f)
        self.assertTrue(f.pub["locked"], "old deploy must be re-locked after failed restore")
        self.assertEqual(f.pub["id"], "old"); self.assertNotEqual(rc, 0)   # does not report success

    def test_restore_raises_relocks_and_propagates(self):
        f = FakeNetlify(raise_restore=True); res, rc, exc, out = run(f)
        self.assertIsInstance(exc, OSError); self.assertTrue(f.pub["locked"], "finally must re-lock when restore raises")

    def test_lock_call_fails_exits_nonzero_with_warning(self):
        f = FakeNetlify(fail_lock=True); res, rc, exc, out = run(f)
        self.assertEqual(rc, 1); self.assertIn("UNLOCKED", out)   # loud, never silent

    def test_already_published_deploy_is_not_republished(self):
        f = FakeNetlify(new_published=True); res, rc, exc, out = run(f)
        self.assertFalse(any(c[1].endswith("/unlock") or c[1].endswith("/restore") for c in f.calls), "no unlock/restore")
        self.assertEqual(f.pub["id"], "old")

    def test_older_deploy_refused_without_unlock(self):
        f = FakeNetlify(); f.new["created_at"] = "2026-10-01T00:00:00Z"; res, rc, exc, out = run(f)
        self.assertEqual(rc, 2); self.assertFalse(any(c[1].endswith("/unlock") for c in f.calls)); self.assertTrue(f.pub["locked"])

    def test_negative_control_without_finally_relock_would_fail(self):
        """Negative control: a fake whose lock endpoint is dead leaves the site unlocked; the test above only passes
        because publish_site exits 1 loudly. Prove the fake can express an unlocked end state."""
        f = FakeNetlify(fail_lock=True); run(f)
        self.assertFalse(f.pub["locked"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
