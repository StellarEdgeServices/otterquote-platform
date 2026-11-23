#!/usr/bin/env python3
"""Self-test for scripts/gh3380_byline_after_intro.py (gh-3380 S-5, negative control for the detector-negative-control gate).
Builds a throwaway tree with one guide per page shape that carries the byline in the hero (A p.meta, C div.meta,
B article-meta, D tool page), one guide that is already correct, and one with no byline. Then:
  - --check must REJECT the tree (exit 1) naming exactly the four pages with the byline first (the detector fires),
  - the mover must put the byline after the opening block on those four and leave the other two byte-identical,
  - the visible text of every page must be unchanged apart from order, --check must then PASS (exit 0), and a second run must change nothing.
Run: python3 scripts/gh3380_byline_after_intro.test.py"""
import re, shutil, subprocess, sys, tempfile
from pathlib import Path

SRC = Path(__file__).resolve().parent / "gh3380_byline_after_intro.py"
BYL = ('By <a href="/about.html" style="color:inherit;text-decoration:underline">Dustin Stohler</a> and '
       '<a href="/about.html#sloane" style="color:inherit;text-decoration:underline">Sloane</a>, Otter Quotes\' AI marketing executive')
OPEN = "<p>Short answer first: check the bid line by line.</p>"
FAILURES = []

def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok: FAILURES.append(label)

CSS = "<style>\n.page-hero .meta {\n  font-size: 0.9rem;\n  margin-top: 1rem;\n}\n</style>"
A = f'<html><head>{CSS}</head><body>\n<section class="page-hero">\n  <div class="container">\n    <h1>T</h1>\n    <p class="meta">{BYL} &middot; Updated October 2026</p>\n  </div>\n</section>\n<section class="main">\n  <div class="article-body">\n    <div class="article-intro">\n      {OPEN}\n    </div>\n    <h2>Next</h2>\n  </div>\n</section></body></html>\n'
C = f'<html><head>{CSS}</head><body>\n<section class="page-hero">\n  <div class="container">\n    <h1>T</h1>\n    <div class="meta">\n      <div class="author-line">\n        <div>\n          <div class="author-name">{BYL}</div>\n          <div class="author-title">Updated November 2026</div>\n        </div>\n      </div>\n    </div>\n  </div>\n</section>\n<section>\n  <div class="container">\n    <div class="article-body">\n      <div class="article-intro">\n        {OPEN}\n      </div>\n      <h2>Next</h2>\n    </div>\n  </div>\n</section></body></html>\n'
B = f'<html><body>\n  <section class="page-hero">\n    <div class="container">\n      <h1>T</h1>\n      <div class="article-meta">\n        <span class="byline">{BYL}</span>\n        <span class="publish-date">Updated October 2026</span>\n      </div>\n    </div>\n  </section>\n  <main class="article-body">\n    <div class="container">\n      <!-- Intro -->\n      <div class="article-section">\n        {OPEN}\n      </div>\n\n      <h2>Next</h2>\n    </div>\n  </main></body></html>\n'
D = f'<html><body>\n<main id="bt">\n<section class="hero">\n      <h1>T</h1>\n <p class="sub">{BYL}</p>\n <p class="sub">Add a card for each contractor.</p>\n</section>\n</main></body></html>\n'
# already correct: byline after the opening block, CSS already extended
FIXED = A.replace(f'    <p class="meta">{BYL} &middot; Updated October 2026</p>\n', '')
FIXED = FIXED.replace('    </div>\n    <h2>Next</h2>', f'    </div>\n\n    <p class="meta">{BYL} &middot; Updated October 2026</p>\n    <h2>Next</h2>')
FIXED = FIXED.replace('.page-hero .meta {', '.page-hero .meta,\n.article-body > .meta {').replace('}\n</style>', '}\n.article-body > .meta { margin-bottom: var(--sp-6); }\n</style>')
PLAIN = '<html><body><section class="page-hero"><h1>T</h1><p class="meta">Otter Quotes &middot; Updated October 2026</p></section><div class="article-intro"><p>Answer.</p></div></body></html>\n'
PAGES = {"a-guide.html": A, "c-guide.html": C, "b-guide.html": B, "d-tool.html": D, "fixed-guide.html": FIXED, "plain-guide.html": PLAIN}
BROKEN = {"a-guide.html", "c-guide.html", "b-guide.html", "d-tool.html"}

def run(root, *args):
    p = subprocess.run([sys.executable, str(root / "scripts" / SRC.name), *args], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr

def text_nodes(h):
    h = re.sub(r"<(script|style)\b.*?</\1>", "", h, flags=re.S)
    return sorted(x.strip() for x in re.findall(r">([^<]+)<", h) if x.strip())

def first_text_after_h1(h):
    rest = h.split("</h1>", 1)[1]
    for m in re.finditer(r"<(p|div|span)\b[^>]*>([^<]+)", rest):
        t = m.group(2).strip()
        if t and "back" not in m.group(0): return t
    return ""

with tempfile.TemporaryDirectory() as td:
    root = Path(td); (root / "scripts").mkdir(); (root / "guides").mkdir()
    shutil.copy(SRC, root / "scripts" / SRC.name)
    for n, c in PAGES.items(): (root / "guides" / n).write_text(c, encoding="utf8", newline="")
    before = {n: (root / "guides" / n).read_text(encoding="utf8") for n in PAGES}

    rc, out = run(root, "--check")
    check("negative control: --check REJECTS a tree where the byline comes first (exit 1)", rc == 1)
    named = set(re.findall(r"NEEDS MOVE \w+ guides/(\S+)", out))
    check("--check names exactly the four pages with the byline first (got %s)" % sorted(named), named == BROKEN)
    for n in BROKEN: check("fixture %s opens on the byline before the move" % n, first_text_after_h1(before[n]).startswith("By"))

    rc, out = run(root)
    check("mover exits 0 and reports 4 pages moved", rc == 0 and "4 page(s) moved" in out)
    after = {n: (root / "guides" / n).read_text(encoding="utf8") for n in PAGES}
    for n in BROKEN:
        check("%s: first text after the h1 is now the opening answer, not the byline" % n, not first_text_after_h1(after[n]).startswith("By") and first_text_after_h1(after[n]) != "")
        check("%s: byline text present exactly once, after the opening block" % n, after[n].count("Dustin Stohler</a> and") == 1 and after[n].index("Dustin Stohler</a> and") > after[n].index('Add a card' if n == 'd-tool.html' else OPEN))
        check("%s: visible text unchanged apart from order" % n, text_nodes(before[n]) == text_nodes(after[n]))
    check("a page already correct is left byte-identical (negative control for over-moving)", after["fixed-guide.html"] == before["fixed-guide.html"])
    check("a page with no byline is left byte-identical", after["plain-guide.html"] == before["plain-guide.html"])
    check("p.meta page: CSS extended and bottom spacing added", ".article-body > .meta {" in after["a-guide.html"] and ".article-body > .meta { margin-bottom: var(--sp-6); }" in after["a-guide.html"])
    check("div.meta page: author line left-aligned", ".article-body > .meta .author-line { justify-content: flex-start; }" in after["c-guide.html"])
    rc, out = run(root, "--check")
    check("--check passes after the move (exit 0)", rc == 0 and "0 page(s) need the move" in out)
    run(root)
    check("a second run changes nothing (idempotent)", all((root / "guides" / n).read_text(encoding="utf8") == after[n] for n in PAGES))

print("\nall assertions passed" if not FAILURES else "\n%d FAILED" % len(FAILURES))
sys.exit(1 if FAILURES else 0)
