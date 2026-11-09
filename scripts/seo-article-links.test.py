#!/usr/bin/env python3
"""Self-test and negative control for scripts/seo-article-links.py (gh-3380).

Builds a tiny throwaway site under a temp dir (never touches the real repo), lets the
script's own `apply` write the related blocks, breadcrumbs, hubs and Organization
JSON-LD, and runs `check` in it. The clean tree must PASS. Each planted defect must be
REJECTED (exit 1) naming the right problem:
  - a related block that drifted from the map            - a page with no related block
  - a related link that does not resolve                  - a held page linked from a block
  - a held page linked from a hub                         - an orphaned article
  - an article missing from the map                       - an Organization with no sameAs
  - a map entry with the wrong number of links
Also checks that `graph` prints both orphan measures.
Run: python3 scripts/seo-article-links.test.py"""
import json, re, subprocess, sys, tempfile, shutil
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "seo-article-links.py"
FAILURES = []

def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    if not ok: FAILURES.append(label)

ORG = {"name": "T Org", "url": "https://x.test/", "logo": "https://x.test/l.png", "sameAs": ["https://s.test/a"]}
KEYS = ["guides/a1", "guides/a2", "guides/a3", "guides/a4", "guides/a5", "guides/a6", "blog/b1", "blog/b2"]
HELD = "guides/held"

def mapping(related=None, extra_held=True):
    rel = related or {k: [f"/{KEYS[(i + j) % len(KEYS)]}.html" for j in range(1, 6)] for i, k in enumerate(KEYS)}
    return {"topics": [{"id": "t1", "title": "Topic One", "adjacent": "t1", "members": KEYS}],
            "related": rel, "held": {HELD: "held for test"} if extra_held else {}, "plain_titles": {},
            "manual": {"_about": "x"}, "partner_articles_left_as_is": [], "organization": ORG}

def article(title):
    ld = {"@context": "https://schema.org", "@type": "Article", "headline": title,
          "author": {"@type": "Organization"}, "publisher": {"@type": "Organization"}}
    return ('<!DOCTYPE html><html><head><title>%s</title><link rel="canonical" href="https://x.test/%s"><script type="application/ld+json">%s</script></head>'
            '<body><main><h1>%s</h1><p>Body.</p></main><footer id="site-footer"></footer></body></html>' % (title, title.replace(' ', '-'), json.dumps(ld), title))

def index_page():
    return '<!DOCTYPE html><html><head></head><body><main><div class="guides-grid"></div></main></body></html>'

def build(root, m):
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "seo-topic-map.json").write_text(json.dumps(m))
    for k in KEYS + [HELD]:
        (root / (k + ".html")).parent.mkdir(parents=True, exist_ok=True)
        (root / (k + ".html")).write_text(article("Title " + k.split("/")[1]))
    (root / "guides/index.html").write_text(index_page())
    (root / "blog/index.html").write_text(index_page())
    (root / "sitemap.xml").write_text("<urlset></urlset>")

def run(root, *args):
    r = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=root, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr

def fresh(m=None):
    d = Path(tempfile.mkdtemp())
    build(d, m or mapping())
    code, out = run(d, "apply")
    return d, code, out

def edit(root, rel, fn):
    p = root / rel; p.write_text(fn(p.read_text()))

dirs = []
try:
    d, code, out = fresh(); dirs.append(d)
    check("apply runs in the throwaway tree", code == 0 and "changed" in out)
    code, out = run(d, "check")
    check("CLEAN tree exits 0 and prints PASS", code == 0 and out.strip() == "PASS")
    check("CLEAN tree: held page was not touched by apply", "related-links" not in (d / (HELD + ".html")).read_text())
    code, out = run(d, "graph")
    check("graph prints the builder's measure and the prose-link measure", "builder's measure" in out and "inside a <p>" in out)

    d, _, _ = fresh(); dirs.append(d)
    edit(d, "guides/a1.html", lambda s: s.replace('href="/guides/a2.html"', 'href="/guides/a6.html"', 1))
    code, out = run(d, "check")
    check("REJECTED: related block drifted from the map exits 1", code == 1 and "differs from the map" in out)

    d, _, _ = fresh(); dirs.append(d)
    edit(d, "guides/a1.html", lambda s: re.sub(r'<div class="related-links".*?</div>', "", s, flags=re.S))
    code, out = run(d, "check")
    check("REJECTED: article with no related block exits 1", code == 1 and "no related block" in out)

    d, _, _ = fresh(); dirs.append(d)
    edit(d, "guides/a1.html", lambda s: s.replace('href="/guides/a2.html"', 'href="/guides/gone.html"', 1))
    code, out = run(d, "check")
    check("REJECTED: related link that does not resolve exits 1", code == 1 and "does not resolve" in out)

    d, _, _ = fresh(); dirs.append(d)
    edit(d, "guides/a1.html", lambda s: s.replace('href="/guides/a2.html"', f'href="/{HELD}.html"', 1))
    code, out = run(d, "check")
    check("REJECTED: held page linked from a related block exits 1", code == 1 and "held page" in out)

    d, _, _ = fresh(); dirs.append(d)
    edit(d, "guides/topics/t1.html", lambda s: s.replace("</ul>", "</ul>").replace('<a href="/guides/a1.html"', f'<a href="/{HELD}.html"', 1))
    code, out = run(d, "check")
    check("REJECTED: held page linked from a hub exits 1", code == 1 and "hub links to held page" in out)

    # orphan: nothing links to blog/b2 except its own block
    rel = {k: [f"/{KEYS[(i + j) % len(KEYS)]}.html" for j in range(1, 7) if KEYS[(i + j) % len(KEYS)] not in (k, "blog/b2")][:5] for i, k in enumerate(KEYS)}
    d, _, _ = fresh(mapping(rel)); dirs.append(d)
    code, out = run(d, "check")
    check("REJECTED: article no other article links to exits 1 (orphan)", code == 1 and "blog/b2.html: orphan" in out)

    d, _, _ = fresh(); dirs.append(d)
    (d / "guides/stray.html").write_text(article("Stray"))
    code, out = run(d, "check")
    check("REJECTED: article missing from the map exits 1", code == 1 and "guides/stray.html: not in seo-topic-map.json" in out)

    d, _, _ = fresh(); dirs.append(d)
    edit(d, "guides/a1.html", lambda s: s.replace('"sameAs"', '"sameAsX"'))
    edit(d, "guides/a1.html", lambda s: re.sub(r',\s*"sameAs[^\]]*\]', "", s))
    code, out = run(d, "check")
    check("REJECTED: Organization without sameAs exits 1", code == 1 and "Organization missing" in out)

    bad = {k: v[:4] for k, v in mapping()["related"].items()}
    d, _, _ = fresh(mapping(bad)); dirs.append(d)
    code, out = run(d, "check")
    check("REJECTED: map entry with four links instead of five exits 1", code == 1 and "five distinct links" in out)
finally:
    for d in dirs: shutil.rmtree(d, ignore_errors=True)

print()
print("FAILED: %d" % len(FAILURES) if FAILURES else "all assertions passed")
sys.exit(1 if FAILURES else 0)
