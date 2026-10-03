#!/usr/bin/env python3
"""Self-test for scripts/check-removed-article-redirects.py (gh-2480 Part 5 R1). Builds throwaway repo trees: one
consistent tree must PASS, and each defect class (old file still on disk, missing rule, 302, wrong target, target
without a file, edge-map entry for a removed slug, redirect chain over two hops / loop) must be REJECTED (exit 1).
Run: python3 scripts/check-removed-article-redirects.test.py"""
import subprocess, sys, tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-removed-article-redirects.py"
FAILURES = []

def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok: FAILURES.append(label)

REMOVED = {
    "how-long-does-roof-insurance-claim-take-indiana": "/guides/how-to-file-property-damage-claim.html",
    "hail-damage-roof-inspection-first-72-hours": "/blog/what-to-do-after-storm-damages-roof.html",
    "roofing-estimate-red-flags": "/guides/how-to-read-contractor-estimate.html",
    "what-is-recoverable-depreciation-roofing": "/blog/rcv-vs-acv-roof-insurance.html",
    "when-not-to-file-roof-insurance-claim": "/guides/",
}
TARGET_FILES = ["guides/how-to-file-property-damage-claim.html", "blog/what-to-do-after-storm-damages-roof.html",
                "guides/how-to-read-contractor-estimate.html", "blog/rcv-vs-acv-roof-insurance.html", "guides/index.html"]

def redirects(skip=None, code="301", override=None):
    out = []
    for slug, t in REMOVED.items():
        for form in ("/blog/%s.html", "/blog/%s", "/blog/%s/"):
            src = form % slug
            if src == skip: continue
            out.append("%s %s %s" % (src, (override or {}).get(src, t), code))
    return "\n".join(out) + "\n"

def run(redirect_text, extra_files=(), skip_files=(), edge="const REDIRECT_MAP = {};\n"):
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        for f in TARGET_FILES:
            if f in skip_files: continue
            (root / f).parent.mkdir(parents=True, exist_ok=True); (root / f).write_text("x")
        for f in extra_files:
            (root / f).parent.mkdir(parents=True, exist_ok=True); (root / f).write_text("x")
        (root / "_redirects").write_text(redirect_text)
        e = root / "netlify/edge-functions/blog-guides-redirect.ts"
        e.parent.mkdir(parents=True, exist_ok=True); e.write_text(edge)
        r = subprocess.run([sys.executable, str(SCRIPT)], cwd=d, capture_output=True, text=True)
        return r.returncode, r.stdout

code, out = run(redirects())
check("CLEAN tree exits 0 and prints PASS", code == 0 and "PASS" in out)
code, out = run(redirects(), extra_files=["blog/roofing-estimate-red-flags.html"])
check("REJECTED: old file still on disk exits 1", code == 1 and "still on disk" in out)
code, out = run(redirects(skip="/blog/roofing-estimate-red-flags"))
check("REJECTED: missing extensionless rule exits 1", code == 1 and "roofing-estimate-red-flags" in out)
code, out = run(redirects(code="302"))
check("REJECTED: 302 instead of 301 exits 1", code == 1 and "want 301" in out)
code, out = run(redirects(override={"/blog/roofing-estimate-red-flags.html": "/guides/"}))
check("REJECTED: wrong target exits 1", code == 1 and "want" in out)
code, out = run(redirects(), skip_files=["blog/rcv-vs-acv-roof-insurance.html"])
check("REJECTED: target page missing from disk exits 1", code == 1 and "no file" in out)
edge = "const REDIRECT_MAP = {\n  '/blog/roofing-estimate-red-flags':\n    '/blog/roofing-estimate-red-flags.html',\n};\n"
code, out = run(redirects(), edge=edge)
check("REJECTED: edge map still names a removed slug exits 1", code == 1 and "edge map still names" in out)
chain = redirects(override={"/blog/roofing-estimate-red-flags.html": "/blog/roofing-estimate-red-flags",
                            "/blog/roofing-estimate-red-flags": "/blog/roofing-estimate-red-flags/"})
code, out = run(chain)
check("REJECTED: three-hop chain exits 1", code == 1 and "hops" in out)
loop = redirects(override={"/blog/roofing-estimate-red-flags.html": "/blog/roofing-estimate-red-flags",
                           "/blog/roofing-estimate-red-flags": "/blog/roofing-estimate-red-flags.html"})
code, out = run(loop)
check("REJECTED: redirect loop exits 1", code == 1 and "loop" in out)
print()
print("FAILED: %d" % len(FAILURES) if FAILURES else "all assertions passed")
sys.exit(1 if FAILURES else 0)
