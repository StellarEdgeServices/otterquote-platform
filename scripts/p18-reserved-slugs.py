#!/usr/bin/env python3
"""P18 vanity slug: print the reserved_slugs seed (one slug per line).

Source 1: every top-level file and folder name in the repo at HEAD
          (git ls-tree), lower-cased, with a trailing .html stripped.
Source 2: the fixed list the CEO named (EXTRA below).
Run from the repo root: python3 scripts/p18-reserved-slugs.py
"""
import subprocess

EXTRA = ("api, app, www, support, otter, otterquote, stellar-edge, .well-known, sitemap, robots, "
         "llms, ref, login, admin, partners, partner, blog, guides, news, locations, contractors, "
         "contractor, faq, privacy, terms, help, hc, tools, img, js, css, assets, data, start, "
         "recruit, get-started, the-ashes").split(", ")

names = subprocess.check_output(["git", "ls-tree", "--name-only", "HEAD"], text=True).splitlines()
out = set()
for n in names:
    n = n.strip().strip('"').lower()
    if n.endswith(".html"):
        n = n[:-5]
    if n:
        out.add(n)
out.update(EXTRA)
print("\n".join(sorted(out)))
