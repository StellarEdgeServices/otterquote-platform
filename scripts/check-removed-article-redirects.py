#!/usr/bin/env python3
"""gh-2480 Part 5 R1: offline proof of the redirect table for the five removed articles.
Parses _redirects and the edge function's REDIRECT_MAP and resolves every URL form of each old article
(.html, extensionless, trailing slash, plus the legacy /otterquote-deploy/blog/ form where one exists) to its
final target. Fails (exit 1) if a form is not a 301, takes more than two hops, loops, ends at a path with no
file on disk, if an old file still exists, or if the edge map still holds an old slug.
Netlify itself is NOT run here: Pretty URLs and rule precedence are only provable on a deploy preview (see the
curl commands in the PR). Run from the repo root: python3 scripts/check-removed-article-redirects.py"""
import re, sys
from pathlib import Path

REMOVED = {
    "how-long-does-roof-insurance-claim-take-indiana": "/guides/how-to-file-property-damage-claim.html",
    "hail-damage-roof-inspection-first-72-hours": "/blog/what-to-do-after-storm-damages-roof.html",
    "roofing-estimate-red-flags": "/guides/how-to-read-contractor-estimate.html",
    "what-is-recoverable-depreciation-roofing": "/blog/rcv-vs-acv-roof-insurance.html",
    "when-not-to-file-roof-insurance-claim": "/guides/",
}
rules = {}
for l in Path("_redirects").read_text(encoding="utf-8").splitlines():
    p = l.split("#")[0].split()
    if len(p) >= 3 and p[0].startswith("/") and "*" not in p[0] and p[2].rstrip("!") in ("301", "302", "200"):
        rules.setdefault(p[0], (p[1], p[2].rstrip("!")))
edge_src = Path("netlify/edge-functions/blog-guides-redirect.ts").read_text(encoding="utf-8")
edge = dict(re.findall(r"'(/[^']*)':\s*'(/[^']*)'", edge_src))

def step(path):
    """One hop as Netlify would apply it: edge map first, then _redirects (exact path; trailing slash optional)."""
    if path in edge: return edge[path], 301, "edge"
    for cand in (path, path.rstrip("/") if path != "/" else path):
        if cand in rules: return rules[cand][0], int(rules[cand][1]), "_redirects"
    return None

def file_for(path):
    f = path.lstrip("/")
    if f == "" or f.endswith("/"): f += "index.html"
    return Path(f).is_file() or Path(f + ".html").is_file()   # Pretty URLs: /x serves x.html

errs, rows = [], []
for slug, target in REMOVED.items():
    if Path("blog/%s.html" % slug).exists(): errs.append("old file still on disk: blog/%s.html" % slug)
    for k in edge:
        if slug in k or slug in edge[k]: errs.append("edge map still names %s" % slug)
    forms = ["/blog/%s.html" % slug, "/blog/%s" % slug, "/blog/%s/" % slug, "/blog/%s.html?utm_source=x" % slug]
    if "/otterquote-deploy/blog/%s.html" % slug in rules: forms.append("/otterquote-deploy/blog/%s.html" % slug)
    for form in forms:
        cur, hops, seen, chain = form.split("?")[0], 0, set(), []
        while True:
            s = step(cur)
            if s is None: break
            dest, code, via = s
            if code != 301: errs.append("%s: hop %s is %d, want 301" % (form, cur, code)); break
            hops += 1; chain.append("%s -%d(%s)-> %s" % (cur, code, via, dest))
            if dest in seen or hops > 4: errs.append("%s: loop or more than 4 hops" % form); break
            seen.add(cur); cur = dest
        ok = cur == target and 1 <= hops <= 2 and file_for(cur)
        if cur != target: errs.append("%s ends at %s, want %s" % (form, cur, target))
        if hops > 2: errs.append("%s takes %d hops" % (form, hops))
        if not file_for(cur): errs.append("%s ends at %s which has no file" % (form, cur))
        rows.append((form, hops, cur, "OK" if ok else "FAIL"))
for r in rows: print("%-82s hops=%d final=%-52s %s" % r)
print("\n".join(errs) if errs else "PASS")
sys.exit(1 if errs else 0)
