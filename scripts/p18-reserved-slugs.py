#!/usr/bin/env python3
"""P18 vanity slug: print the reserved_slugs seed (one slug per line, sorted).

A partner's /<slug> must never shadow a path the site already serves. Sources (all read from the working tree at the repo root):
  1. every top-level file and folder name (git ls-tree HEAD; os.listdir when not a git tree), lower-cased, .html/.htm stripped;
  2. every top-level route folder under react-app/app: a folder with a page.*/route.* file somewhere beneath it, descending
     through route groups "(group)" (they add no URL segment), skipping "_"- and "["-prefixed segments;
  3. the first path segment of every source path in _redirects and every `from = "/..."` in netlify.toml;
  4. EXTRA, the fixed list the CEO named.
Names starting with `home-` are NOT written to the seed: a pattern rule in the database (reserved_slug_pattern_hit) refuses the whole
`home-` prefix, because a literal staging-page name in a tracked file trips the static pixel gate (T5 in the gh2598 staging-page test).

Run from the repo root: python3 scripts/p18-reserved-slugs.py
Self-test (negative control; the house pattern, a sibling test file): python3 scripts/p18-reserved-slugs.test.py
"""
import os
import re
import subprocess
import sys
from pathlib import Path

EXTRA = ("api, app, www, support, otter, otterquote, stellar-edge, .well-known, sitemap, robots, "
         "llms, ref, login, admin, partners, partner, blog, guides, news, locations, contractors, "
         "contractor, faq, privacy, terms, help, hc, tools, img, js, css, assets, data, start, "
         "recruit, get-started, the-ashes").split(", ")

PATTERN_PREFIXES = ("home-",)  # refused by pattern in the database, not listed in the seed
# Prefix rules ALSO refused by p18_slug_is_reserved (hard-coded in the migration, kept here so the list is in one reviewed place).
# They match a whole prefix and never 404: the admin-auth-gate edge function (pattern ^/admin-.*), the `/get-started*` redirect in
# _redirects/netlify.toml and the forced `the-ashes*` redirect. Unlike PATTERN_PREFIXES, seed rows under these prefixes are kept.
# If a new `*` redirect source or a new `^/...` edge-function prefix is added, add it here and to p18_slug_is_reserved.
PREFIX_RULES = ("admin-", "get-started", "the-ashes")
REACT_APP = Path("react-app") / "app"
PAGE_RE = re.compile(r"^(page|route)\.(tsx?|jsx?)$")


def norm(name):
    n = name.strip().strip('"').lower()
    for ext in (".html", ".htm"):
        if n.endswith(ext):
            n = n[: -len(ext)]
    return n


def root_names(root):
    try:
        out = subprocess.check_output(["git", "-C", str(root), "ls-tree", "--name-only", "HEAD"], text=True, stderr=subprocess.DEVNULL)
        names = out.splitlines()
        if names:
            return names
    except Exception:
        pass
    return os.listdir(root)


def has_page(d):
    for _, _, files in os.walk(d):
        if any(PAGE_RE.match(f) for f in files):
            return True
    return False


def react_routes(root):
    base = Path(root) / REACT_APP
    found = set()
    if not base.is_dir():
        return found

    def walk(d):
        for e in sorted(os.listdir(d)):
            p = d / e
            if not p.is_dir() or e.startswith("_") or e.startswith("["):
                continue
            if e.startswith("(") and e.endswith(")"):
                walk(p)  # route group: its children are top-level routes
            elif has_page(p):
                found.add(norm(e))

    walk(base)
    return found


def first_segment(path):
    path = re.sub(r"^https?://(www\.)?otterquote\.com", "", path.strip())
    if not path.startswith("/"):
        return None
    seg = path.lstrip("/").split("/")[0].split("?")[0].split("#")[0].rstrip("*")
    seg = norm(seg)
    if not seg or "*" in seg or ":" in seg:
        return None
    return seg


def redirect_sources(root):
    found = set()
    rd = Path(root) / "_redirects"
    if rd.is_file():
        for line in rd.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            seg = first_segment(line.split()[0])
            if seg:
                found.add(seg)
    nt = Path(root) / "netlify.toml"
    if nt.is_file():
        # `from = "/..."` redirect sources, and `path = "/..."` of [[edge_functions]] routes (e.g. /ref-bind, gh-3237: an exact edge route
        # is served at its first segment even though no file or redirect names it).
        for m in re.finditer(r'^\s*(?:from|path)\s*=\s*"([^"]+)"', nt.read_text(encoding="utf-8", errors="replace"), re.MULTILINE):
            seg = first_segment(m.group(1))
            if seg:
                found.add(seg)
    return found


def collect(root=".", names=None):
    """Return the sorted seed list for the tree at `root`."""
    out = set()
    for n in (names if names is not None else root_names(root)):
        n = norm(n)
        if n:
            out.add(n)
    out |= react_routes(root)
    out |= redirect_sources(root)
    out.update(EXTRA)
    return sorted(s for s in out if not s.startswith(PATTERN_PREFIXES))


if __name__ == "__main__":
    print("\n".join(collect(sys.argv[1] if len(sys.argv) > 1 else ".")))
