#!/usr/bin/env python3
"""Self-test for scripts/check-sitemap.py (gh-2447). Builds tiny throwaway repo trees
and runs the detector in them: one consistent tree must PASS, and each defect class
(missing page, noindex page, robots-blocked page, redirecting URL, unlisted public page)
must be REJECTED (exit 1) naming the right problem.
Run: python3 scripts/check-sitemap.test.py"""
import subprocess, sys, tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-sitemap.py"
BASE = "https://otterquote.com"
FAILURES = []

def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok: FAILURES.append(label)

def page(noindex=False):
    m = '<meta name="robots" content="noindex">' if noindex else ""
    return f"<!DOCTYPE html><html><head>{m}</head><body>x</body></html>"

def sitemap(paths):
    return '<?xml version="1.0"?><urlset>' + "".join(f"<url><loc>{BASE}{p}</loc></url>" for p in paths) + "</urlset>"

def run(files, sm, robots="User-agent: *\nAllow: /\n", redirects=""):
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        for name, body in files.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_text(body)
        (root / "sitemap.xml").write_text(sm)
        (root / "robots.txt").write_text(robots)
        (root / "_redirects").write_text(redirects)
        r = subprocess.run([sys.executable, str(SCRIPT)], cwd=d, capture_output=True, text=True)
        return r.returncode, r.stdout

good = {"index.html": page(), "faq.html": page(), "blog/index.html": page()}
code, out = run(good, sitemap(["/", "/faq.html", "/blog/"]), redirects="/blog/index.html /blog/ 301\n")
check("CLEAN tree (index.html redirect rule present, /blog/ listed) exits 0 and prints PASS", code == 0 and "PASS" in out)

code, out = run(good, sitemap(["/", "/faq.html", "/blog/", "/gone.html"]))
check("REJECTED: listed URL with no file exits 1 (no such file)", code == 1 and "no such file" in out)

code, out = run({**good, "faq.html": page(True)}, sitemap(["/", "/faq.html", "/blog/"]))
check("REJECTED: listed noindex page exits 1 (page is noindex)", code == 1 and "noindex" in out)

code, out = run(good, sitemap(["/", "/faq.html", "/blog/"]), robots="User-agent: *\nDisallow: /faq.html\n")
check("REJECTED: listed robots-blocked page exits 1 (disallowed)", code == 1 and "disallowed" in out)

code, out = run(good, sitemap(["/", "/faq.html", "/blog/"]), redirects="/faq.html /elsewhere 301\n")
check("REJECTED: listed redirecting URL exits 1 (_redirects rule)", code == 1 and "_redirects" in out)

code, out = run(good, sitemap(["/", "/blog/"]))
check("REJECTED: public indexable page missing from sitemap exits 1 (missing)", code == 1 and "missing from sitemap" in out)

# gh-live-fixes: generated /locations/ pages need an index.html-twin 301 in _redirects AND the edge function map.
EDGE = "netlify/edge-functions/blog-guides-redirect.ts"
LOC = "locations/zz-county-oh/roofing/index.html"
loc_files = {**good, LOC: page(), EDGE: "const M = {\n  '/locations/zz-county-oh/roofing/index.html':\n    '/locations/zz-county-oh/roofing/',\n};\n"}
loc_sm = sitemap(["/", "/faq.html", "/blog/", "/locations/zz-county-oh/roofing/"])
loc_red = "/blog/index.html /blog/ 301\n/locations/zz-county-oh/roofing/index.html /locations/zz-county-oh/roofing/ 301\n"
code, out = run(loc_files, loc_sm, redirects=loc_red)
check("CLEAN locations tree (rule in _redirects and edge map) exits 0", code == 0 and "PASS" in out)
code, out = run(loc_files, loc_sm, redirects="/blog/index.html /blog/ 301\n")
check("REJECTED: locations page with no _redirects index.html rule exits 1", code == 1 and "no _redirects rule" in out)
code, out = run({**loc_files, EDGE: "const M = {};\n"}, loc_sm, redirects=loc_red)
check("REJECTED: locations page missing from the edge function map exits 1", code == 1 and "REDIRECT_MAP" in out)
code, out = run(loc_files, sitemap(["/", "/faq.html", "/blog/"]), redirects=loc_red)
check("REJECTED: locations page missing from sitemap exits 1", code == 1 and "missing from sitemap" in out)

print()
print("FAILED: %d" % len(FAILURES) if FAILURES else "all assertions passed")
sys.exit(1 if FAILURES else 0)
