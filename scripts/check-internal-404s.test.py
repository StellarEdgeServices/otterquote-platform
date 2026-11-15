#!/usr/bin/env python3
"""Self-test for scripts/check-internal-404s.py (gh-3556).
1. A throwaway tree with a dead sitemap entry, a dead href and a dead src must FAIL naming all three;
   the same tree with the targets present (and a redirect-covered link) must PASS.
2. The real repo (cwd) must PASS: no internal link, canonical or sitemap entry may 404.
Run: python3 scripts/check-internal-404s.test.py   (from repo root)"""
import subprocess, sys, tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-internal-404s.py"
FAILURES = []

def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok:
        FAILURES.append(label)

def run(root):
    r = subprocess.run([sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True)
    return r.returncode, r.stdout

def tree(root, files):
    for name, body in files.items():
        p = Path(root) / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)

SM = '<urlset><url><loc>https://otterquote.com/about.html</loc></url><url><loc>https://otterquote.com/gone.html</loc></url></urlset>'
PAGE = '<a href="/missing-page.html">x</a><img src="/img/nope.png"><a href="/old">r</a><a href="/about">ok</a>'
with tempfile.TemporaryDirectory() as d:
    tree(d, {"sitemap.xml": SM, "_redirects": "/old /about.html 301\n", "index.html": PAGE, "about.html": "<p>hi</p>"})
    rc, out = run(d)
    check("defective tree is rejected", rc == 1)
    check("dead sitemap entry named", "/gone.html" in out)
    check("dead href named", "/missing-page.html" in out)
    check("dead src named", "/img/nope.png" in out)
    check("redirect-covered and pretty-URL links not flagged", "/old" not in out.replace("/old-", "") and "404-bound: /about" not in out)
with tempfile.TemporaryDirectory() as d:
    tree(d, {"sitemap.xml": SM.replace("gone.html", "index.html"), "_redirects": "/old /about.html 301\n",
             "index.html": '<a href="/about">a</a><a href="/old">r</a>', "about.html": "<p>hi</p>"})
    rc, out = run(d)
    check("consistent tree passes", rc == 0)
# gh-3556: a 410 rule must not hide a link to the removed page.
with tempfile.TemporaryDirectory() as d:
    tree(d, {"sitemap.xml": "<urlset></urlset>", "_redirects": "/gone-page 410!\n", "index.html": '<a href="/gone-page">x</a>'})
    rc, out = run(d)
    check("link to a 410-removed page is still flagged", rc == 1 and "/gone-page" in out)
# gh-3556: removed pages answer 410 (rules exist in the real _redirects).
red = Path("_redirects").read_text(encoding="utf8").splitlines()
for src in ("/project-confirmation.html", "/project-confirmation", "/democracy", "/democracy/*"):
    check("410 rule for " + src, any(l.split()[:1] == [src] and l.split()[-1].rstrip("!") == "410" for l in red if l.strip() and not l.startswith("#")))
rc, out = run(".")
print(out.strip())
check("real repo has no 404-bound internal targets", rc == 0)
sys.exit(1 if FAILURES else 0)
