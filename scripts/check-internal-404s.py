#!/usr/bin/env python3
"""gh-3556: list internal links / sitemap entries / canonicals that would 404 on otterquote.com.

Run from repo root:  python3 scripts/check-internal-404s.py   (exit 1 if any are found).
Models the served tree (netlify.toml build denylist), Netlify Pretty URLs (/x -> x.html,
/x/ -> x/index.html) and the path-only rules in _redirects. Absolute https://otterquote.com
URLs are checked too. Dynamic hrefs (templates, JS concatenation) are skipped.
Test: python3 scripts/check-internal-404s.test.py
"""
import fnmatch
import os
import re
import sys
from urllib.parse import unquote, urlsplit

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
DENY = {"_site", "netlify", "react-app", "supabase", "scripts", "sql", "tests", "handoffs", "docs",
        "archive", "runbooks", "skills-for-code", "democracy", "deploy-checks", "forge-config",
        "otterquote-deploy", "tools", "node_modules"}
# Referral short links are served by an edge function, not a file.
EDGE_PREFIXES = ("/ref/", "/ref-bind", "/recruit")


def served_files():
    out = []
    for root, dirs, files in os.walk(ROOT):
        rel = os.path.relpath(root, ROOT).replace("\\", "/")
        top = rel.split("/")[0].lower() if rel != "." else ""
        if top in DENY or top.startswith("."):
            dirs[:] = []
            continue
        for f in files:
            if rel == "." and (f.lower() in DENY or f.lower().endswith((".md", ".py", ".sh", ".toml"))):
                continue
            out.append(f if rel == "." else rel + "/" + f)
    return out


def main():
    served = served_files()
    low = {p.lower() for p in served}
    rules = []
    with open(os.path.join(ROOT, "_redirects"), encoding="utf8") as fh:
        for line in fh:
            parts = line.split()
            if parts and not line.startswith("#") and len(parts) >= 2 and not parts[0].startswith("http"):
                rules.append(parts[0])

    def resolves(path):
        p = path.lstrip("/").lower()
        if p == "":
            return "index.html" in low
        return any(c in low for c in (p, p + ".html", p.rstrip("/") + "/index.html"))

    def redirected(path):
        return any(path == s or fnmatch.fnmatch(path, s) for s in rules)

    def broken(path):
        return not (resolves(path) or redirected(path) or path.startswith(EDGE_PREFIXES))

    bad = {}

    def note(path, where):
        bad.setdefault(path, []).append(where)

    sm = open(os.path.join(ROOT, "sitemap.xml"), encoding="utf8").read()
    for loc in re.findall(r"<loc>(.*?)</loc>", sm):
        path = unquote(urlsplit(loc).path or "/")
        if broken(path):
            note(path, "sitemap.xml")

    for p in served:
        if not p.endswith(".html"):
            continue
        text = open(os.path.join(ROOT, p), encoding="utf8", errors="replace").read()
        text = re.sub(r"<!--.*?-->", "", text, flags=re.S)  # commented-out markup is not served as a link
        for m in re.finditer(r'(?:href|src)\s*=\s*["\']([^"\']+)["\']', text, re.I):
            u = m.group(1).strip()
            if re.match(r"(mailto:|tel:|#|javascript:|data:|sms:)", u) or "{" in u or "+" in u or u.startswith("//"):
                continue
            if re.match(r"https?://", u):
                if not re.match(r"https?://(www\.)?otterquote\.com", u):
                    continue
                path = urlsplit(u).path or "/"
            else:
                path = urlsplit(u).path
                if not path:
                    continue
                if not path.startswith("/"):
                    path = "/" + os.path.normpath(os.path.join(os.path.dirname(p), path)).replace("\\", "/")
            path = unquote(path)
            if broken(path):
                note(path, p)

    for path in sorted(bad):
        print("404-bound: %s  (%d ref%s, e.g. %s)" % (path, len(bad[path]), "" if len(bad[path]) == 1 else "s", ", ".join(sorted(set(bad[path]))[:3])))
    print("%d 404-bound internal target(s)" % len(bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
