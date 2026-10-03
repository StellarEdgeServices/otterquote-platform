#!/usr/bin/env python3
"""Fail if sitemap.xml and the public, indexable HTML pages in the repo disagree.
Run from repo root:  python3 scripts/check-sitemap.py   (exit 1 on any problem)."""
import re, sys, glob, fnmatch
from pathlib import Path

BASE = "https://otterquote.com"
# Public pages deliberately NOT in the sitemap and NOT noindex (keep this list short).
UNLISTED_OK = {"login.html", "contractors/index.html"}
# Not a public page: contractor-about.html needs ?contractor_id= and a signed-in user (without them it renders an error page).
UNLISTED_OK.add("contractor-about.html")
# Pages PR #2460 (gh-2450, T4) makes noindex. Remove these five entries when #2460 merges.
UNLISTED_OK |= {"re-1.html", "re-3.html", "re-5.html", "contractor-auto-bids.html", "oqom-onboarding.html"}

def read(p): return Path(p).read_text(encoding="utf-8", errors="replace")
robots = read("robots.txt")
disallow = [l.split(":", 1)[1].strip() for l in robots.splitlines() if l.lower().startswith("disallow:") and l.split(":", 1)[1].strip()]
def blocked(path): return any(path.startswith(d) for d in disallow)
redirect_src = []
for l in read("_redirects").splitlines():
    l = l.strip()
    if l and not l.startswith("#"):
        redirect_src.append(l.split()[0])
def redirected(path):
    return any(fnmatch.fnmatch(path, s) for s in redirect_src if s.startswith("/"))
def noindex(f):
    m = re.search(r'<meta[^>]+name=["\']robots["\'][^>]*content=["\']([^"\']*)', read(f), re.I)
    return bool(m and "noindex" in m.group(1).lower())
def to_file(loc):
    p = loc[len(BASE):]
    if p.endswith("/"): p += "index.html"
    return p.lstrip("/")

errs = []
locs = re.findall(r"<loc>(.*?)</loc>", read("sitemap.xml"))
for d in {l for l in locs if locs.count(l) > 1}: errs.append(f"duplicate <loc> {d}")
listed = set()
for loc in locs:
    if not loc.startswith(BASE): errs.append(f"{loc}: not on {BASE}"); continue
    f = to_file(loc); listed.add(f); path = loc[len(BASE):]
    if not Path(f).is_file(): errs.append(f"{loc}: no such file {f}"); continue
    if noindex(f): errs.append(f"{loc}: page is noindex")
    if blocked("/" + f) or blocked(path): errs.append(f"{loc}: disallowed in robots.txt")
    if redirected(path): errs.append(f"{loc}: matches a _redirects rule (listing a redirecting URL)")
# Generated /locations/<county>/<trade>/index.html pages (tools/generate_location_pages.py). Pretty URLs serves
# the on-disk .../index.html as a second 200 beside the slash URL, so each one needs a 301 for its index.html twin
# in _redirects AND in the edge function map that actually fires (same mechanism as /blog/index.html, #2461).
loc_pages = sorted(glob.glob("locations/*/*/index.html"))
edge_src = read("netlify/edge-functions/blog-guides-redirect.ts") if Path("netlify/edge-functions/blog-guides-redirect.ts").is_file() else ""
for f in loc_pages:
    if f not in listed and not noindex(f):
        errs.append(f"{f}: public + indexable but missing from sitemap.xml (list it, add noindex, or add to UNLISTED_OK)")
    twin = "/" + f
    slash = twin[: -len("index.html")]
    if twin not in redirect_src:
        errs.append(f"{f}: index.html twin has no _redirects rule ({twin} {slash} 301)")
    if f"'{twin}'" not in edge_src and f'"{twin}"' not in edge_src:
        errs.append(f"{f}: index.html twin is not in the blog-guides-redirect.ts REDIRECT_MAP (the edge function is what fires)")
cands = glob.glob("*.html") + glob.glob("blog/*.html") + glob.glob("guides/*.html") + glob.glob("contractors/*.html") + loc_pages
for f in sorted(cands):
    if f in listed or f in UNLISTED_OK or f.startswith("admin-") or f == "404.html": continue
    if noindex(f) or blocked("/" + f) or redirected("/" + f): continue
    errs.append(f"{f}: public + indexable but missing from sitemap.xml (list it, add noindex, or add to UNLISTED_OK)")
print("\n".join(errs) if errs else "PASS")
sys.exit(1 if errs else 0)
