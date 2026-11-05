#!/usr/bin/env python3
"""gh-3380 SEO template pass: related-article blocks, breadcrumbs, topic hubs, Organization JSON-LD.

Mechanical only: no body sentence is changed. Topic assignments live in scripts/seo-topic-map.json.
  python3 scripts/seo-article-links.py apply [--only path ...]   write changes (idempotent)
  python3 scripts/seo-article-links.py check                      exit 1 if any rule is broken
  python3 scripts/seo-article-links.py graph [-v]                 orphan counts, two measures (any link / link inside a <p>)
Run from the repo root.
"""
import re, sys, json, glob, os
from pathlib import Path

MAP = json.loads(Path("scripts/seo-topic-map.json").read_text(encoding="utf-8"))
ORG = MAP["organization"]
TODAY = "2026-11-05"
SECTION = {"guides": ("Guides", "/guides/"), "blog": ("Blog", "/blog/"), "news": (None, None),
           "partners": ("Referral Partner Program", "/partners.html")}
HUB_DIR = "guides/topics"
HELD = set(MAP.get("held", {}))

def rd(p): return Path(p).read_text(encoding="utf-8")
def wr(p, s): Path(p).write_text(s, encoding="utf-8", newline="")

TOPICS = {t["id"]: t for t in MAP["topics"]}
OF = {}
for t in MAP["topics"]:
    for i, m in enumerate(t["members"]): OF[m] = (t["id"], i)

def h1_text(path):
    s = rd(path + ".html")
    m = re.search(r"<h1[^>]*>(.*?)</h1>", s, re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", m.group(1))).strip()

def hub_url(tid): return f"/{HUB_DIR}/{tid}.html"

def link_title(u):
    if u in MAP.get("plain_titles", {}): return MAP["plain_titles"][u]
    return h1_text(u[1:-5])

def expected_links(key):
    """The block for an article: its five hand-picked links from the map's 'related', then its topic hub."""
    tid, _ = OF[key]
    links = [(u, link_title(u)) for u in MAP["related"][key]]
    links.append((hub_url(tid), "Browse all: " + TOPICS[tid]["title"]))
    return links

def related_links(path): return expected_links(path)

RELATED_CSS = ('<style id="related-links-css">.related-links{background:var(--navy-2);border:1px solid rgba(255,255,255,0.06);'
 'padding:var(--sp-6) var(--sp-8);border-radius:var(--radius-lg);margin:var(--sp-10) 0}.related-links h3{color:var(--white);'
 'margin-bottom:var(--sp-4);font-size:1.05rem}.related-links ul{margin-left:var(--sp-6)}.related-links li{margin-bottom:var(--sp-2);'
 'line-height:1.7}</style>')
CRUMB_CSS = ('<style id="breadcrumb-css">.breadcrumb ol{list-style:none;display:flex;flex-wrap:wrap;gap:.25rem .5rem;justify-content:inherit;'
 'margin:0 0 var(--sp-4);padding:0;font-size:.85rem}.breadcrumb li+li:before{content:"\\203A";margin-right:.5rem;opacity:.7}'
 '.breadcrumb a{color:inherit;text-decoration:underline}</style>')

def last_heading_level_before(s, pos):
    hs = re.findall(r"<h([1-6])\b", re.sub(r"<script.*?</script>", "", s[:pos], flags=re.S))
    return int(hs[-1]) if hs else 1

def block_html(links, heading, level):
    lis = "\n".join(f'        <li><a href="{u}">{t}</a></li>' for u, t in links)
    return (f'<div class="related-links" data-related="1">\n      <h{level}>{heading}</h{level}>\n      <ul>\n{lis}\n      </ul>\n    </div>')

BLOCK_RE = re.compile(r'<div class="related-links"[^>]*>.*?</div>', re.S)

def apply_related(path, s):
    key = path[:-5]
    if key in OF: links = related_links(key)
    elif key in MAP["manual"] and key != "_about": links = [(u, None) for u in MAP["manual"][key]]
    else: return s
    m = BLOCK_RE.search(s)
    if key in MAP["manual"]:
        if m: return s
        tl = {u: (h1_text(u[1:-5]) if u.startswith("/partners/") else None) for u, _ in links}
        names = {"/partner-re.html": "Become a Real Estate Partner", "/partners.html": "Referral Partner Program"}
        links = [(u, tl[u] or names[u]) for u, _ in links]
    heading = "Keep Reading"
    if m:
        hm = re.search(r"<h[1-6][^>]*>(.*?)</h[1-6]>", m.group(0), re.S)
        if hm: heading = hm.group(1)
        pos = m.start()
    else:
        pos = s.rfind("</main>")
        if pos < 0:  # pages built from <section class="main"><div class="article-body">: insert before the closing </div></section>
            fm = s.find('<footer id="site-footer">')
            pos = s.rfind("</div>", 0, fm) if fm > 0 else -1
        if pos < 0: raise SystemExit(f"{path}: no insertion point for related block")
    lvl = 3 if last_heading_level_before(s, pos) >= 2 else 2
    new = block_html(links, heading, lvl)
    if m: s = s[:m.start()] + new + s[m.end():]
    else: s = s[:pos] + "    " + new + "\n\n    " + s[pos:]
    if lvl == 2 and ".related-links h2" not in s:
        s = s.replace("</head>", "<style id=\"related-links-h2-css\">.related-links h2{color:var(--white);margin-bottom:var(--sp-4);font-size:1.05rem}</style>\n</head>", 1)
    if ".related-links{" not in s and ".related-links {" not in s:
        s = s.replace("</head>", RELATED_CSS + "\n</head>", 1)
    return s

# ---------- JSON-LD ----------
def ld_blocks(s): return list(re.finditer(r'(<script type="application/ld\+json">)(.*?)(</script>)', s, re.S))

def obj_span(t, tok_pos):
    depth = 0; i = tok_pos
    while i >= 0:
        c = t[i]
        if c == "}": depth += 1
        elif c == "{":
            if depth == 0: break
            depth -= 1
        i -= 1
    start = i; depth = 0; j = start; ins = False
    while j < len(t):
        c = t[j]
        if ins:
            if c == "\\": j += 1
            elif c == '"': ins = False
        else:
            if c == '"': ins = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0: return start, j + 1
        j += 1
    raise ValueError("unbalanced")

def fix_org_in(text):
    out = text; pos = 0; changed = False
    tok = re.compile(r'"@type"\s*:\s*"Organization"')
    while True:
        m = tok.search(out, pos)
        if not m: break
        a, b = obj_span(out, m.start()); obj = json.loads(out[a:b])
        add = []
        if not obj.get("name"): add.append(f'"name": {json.dumps(ORG["name"])}')
        if not obj.get("url"): add.append(f'"url": {json.dumps(ORG["url"])}')
        if not obj.get("logo"): add.append('"logo": {"@type": "ImageObject", "url": %s}' % json.dumps(ORG["logo"]))
        if not obj.get("sameAs"): add.append(f'"sameAs": {json.dumps(ORG["sameAs"])}')
        if add:
            ins = ", " + ", ".join(add)
            out = out[:m.end()] + ins + out[m.end():]; changed = True
            pos = m.end() + len(ins)
        else: pos = m.end()
    return out, changed

def apply_org(s):
    for m in reversed(ld_blocks(s)):
        body = m.group(2)
        if '"Article"' not in body and '"NewsArticle"' not in body: continue
        nb, ch = fix_org_in(body)
        if ch:
            json.loads(nb)
            s = s[:m.start(2)] + nb + s[m.end(2):]
    return s

def breadcrumb_items(s):
    for m in ld_blocks(s):
        try: j = json.loads(m.group(2))
        except Exception: continue
        for n in (j.get("@graph", [j]) if isinstance(j, dict) else j):
            if isinstance(n, dict) and n.get("@type") == "BreadcrumbList":
                return [(e["name"], e["item"]) for e in n["itemListElement"]]
    return None

def crumb_html(items):
    lis = []
    for k, (name, url) in enumerate(items):
        name = name.replace("&", "&amp;") if "&amp;" not in name else name
        path = re.sub(r"^https://otterquote\.com", "", url) or "/"
        lis.append(f'<li aria-current="page">{name}</li>' if k == len(items) - 1 else f'<li><a href="{path}">{name}</a></li>')
    return '<nav class="breadcrumb" data-seo-crumb="1" aria-label="Breadcrumb"><ol>' + "".join(lis) + "</ol></nav>\n      "

def apply_crumb(path, s):
    if re.search(r'<nav[^>]*class="breadcrumb', s) or "data-seo-crumb" in s: return s
    items = breadcrumb_items(s)
    sec = path.split("/")[0]
    if items is None:  # news pages: no hub exists, 2-level trail from the page's own title
        title = re.sub(r"<[^>]+>", "", re.search(r"<h1[^>]*>(.*?)</h1>", s, re.S).group(1)).strip()
        canon = re.search(r'<link rel="canonical" href="([^"]+)"', s).group(1)
        items = [("Home", "https://otterquote.com/"), (title, canon)]
        ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": n, "item": u} for i, (n, u) in enumerate(items)]}
        s = s.replace("</head>", '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False) + "</script>\n</head>", 1)
    i = s.find("<h1")
    if i < 0: return s
    s = s[:i] + crumb_html(items) + s[i:]
    if ".breadcrumb ol" not in s: s = s.replace("</head>", CRUMB_CSS + "\n</head>", 1)
    return s

def articles():
    keys = list(OF) + [k for k in MAP["manual"] if k != "_about"] + MAP["partner_articles_left_as_is"]
    return [k + ".html" for k in keys]

def apply_one(path):
    s = rd(path); o = s
    s = apply_related(path, s)
    s = apply_org(s)
    s = apply_crumb(path, s)
    if s != o: wr(path, s)
    return s != o

# ---------- hubs ----------
HUB_HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>{title} · Otter Quotes</title>
<meta name="description" content="Otter Quotes guides and articles: {title}.">
<link rel="canonical" href="https://otterquote.com{url}">
<meta property="og:title" content="{title} · Otter Quotes">
<meta property="og:description" content="Otter Quotes guides and articles: {title}.">
<meta property="og:url" content="https://otterquote.com{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Otter Quotes">
<meta property="og:image" content="https://otterquote.com/img/brand-assets/otter-quotes-icon-512.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta property="og:image:alt" content="Otter Quotes logo">

<!-- GA4 -->
<script src="/js/internal-traffic.js"></script>
<script src="/js/ga-gate.js"></script>
<script src="/js/meta-pixel-gate.js"></script>
<script src="/js/linkedin-insight-gate.js"></script>
<script src="/js/reddit-pixel-gate.js"></script>
<script>gtag('config', 'G-D1Y1TLGEFY');</script>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.min.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/design-system.css">
<link rel="stylesheet" href="/css/nav.css">

<script type="application/ld+json">{ld}</script>
{crumbcss}
<style>
.page-hero {{ padding: var(--sp-16) 0 var(--sp-12); text-align: center; background: radial-gradient(ellipse at 50% 0%, rgba(224,123,0,0.06) 0%, transparent 60%); }}
.topic-list {{ display: grid; gap: var(--sp-6); max-width: 800px; margin: 0 auto; }}
.topic-card {{ padding: var(--sp-6) var(--sp-8); border: 1px solid rgba(255,255,255,0.1); border-radius: var(--radius-lg); background: rgba(255,255,255,0.02); text-decoration: none; color: inherit; display: block; }}
.topic-card:hover {{ border-color: rgba(224,123,0,0.3); }}
.topic-card h2 {{ font-size: 1.25rem; margin: 0; color: var(--text-primary); }}
</style>
</head>
<body>

<header id="site-header"></header>

<section class="page-hero">
  <div class="container">
    {crumb}<h1>{title}</h1>
  </div>
</section>

<section class="main">
  <div class="container">
    <div class="topic-list">
{cards}
    </div>
  </div>
</section>

<footer id="site-footer"></footer>

<script src="/js/cookie-storage.js"></script>
<script src="/js/config.js"></script>
<script src="/js/auth.js"></script>
<script src="/js/nav.js"></script>
</body>
</html>
"""

def build_hub(t):
    url = hub_url(t["id"])
    items = [("Home", "https://otterquote.com/"), ("Guides", "https://otterquote.com/guides/"), (t["title"], "https://otterquote.com" + url)]
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "name": t["title"], "url": "https://otterquote.com" + url,
         "publisher": {"@type": "Organization", "name": ORG["name"], "url": ORG["url"], "logo": {"@type": "ImageObject", "url": ORG["logo"]}, "sameAs": ORG["sameAs"]}},
        {"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": i + 1, "name": n, "item": u} for i, (n, u) in enumerate(items)]}]}
    cards = "\n".join(f'      <a href="/{m}.html" class="topic-card"><h2>{h1_text(m)}</h2></a>' for m in t["members"])
    return HUB_HEAD.format(title=t["title"], url=url, ld=json.dumps(ld, ensure_ascii=False), crumbcss=CRUMB_CSS,
                           crumb=crumb_html(items).rstrip(), cards=cards)

def topic_nav():
    lis = "".join(f'<li><a href="{hub_url(t["id"])}">{t["title"]}</a></li>' for t in MAP["topics"])
    return ('<nav class="topic-nav" data-seo-topics="1" aria-label="Browse by topic"><ul style="list-style:none;display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;'
            'justify-content:center;margin:0 auto var(--sp-8);padding:0;max-width:800px;font-size:.95rem">' + lis + "</ul></nav>\n    ")

def apply_hubs():
    os.makedirs(HUB_DIR, exist_ok=True)
    for t in MAP["topics"]: wr(f"{HUB_DIR}/{t['id']}.html", build_hub(t))
    for idx, anchor in (("guides/index.html", '<div class="guides-grid">'), ("blog/index.html", None)):
        s = rd(idx)
        if "data-seo-topics" in s: continue
        if anchor is None:
            m = re.search(r'<div class="[^"]*(?:grid|list)[^"]*">', s[s.find("<main") if "<main" in s else s.find('<section class="main"'):])
            base = s.find("<main") if "<main" in s else s.find('<section class="main"')
            anchor = m.group(0); pos = base + m.start()
        else: pos = s.find(anchor)
        s = s[:pos] + topic_nav() + s[pos:]
        wr(idx, s)
    # sitemap
    sm = rd("sitemap.xml")
    add = ""
    for t in MAP["topics"]:
        loc = f"https://otterquote.com{hub_url(t['id'])}"
        if loc not in sm:
            add += f"  <url>\n    <loc>{loc}</loc>\n    <lastmod>{TODAY}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n"
    if add: wr("sitemap.xml", sm.replace("</urlset>", add + "</urlset>"))

# ---------- check / graph ----------
def norm_href(h):
    p = h.split("#")[0].split("?")[0]
    if p.endswith("/"): p += "index.html"
    return p

def check():
    errs = []
    allk = set(OF)
    pages = glob.glob("guides/*.html") + glob.glob("blog/*.html") + glob.glob("news/*.html") + glob.glob("partners/*.html")
    for h in HELD:
        if h in allk: errs.append(f"{h}: held page is in a topic")
        if h in MAP["related"]: errs.append(f"{h}: held page has a 'related' entry")
    for f in pages:
        k = f[:-5]
        if k.endswith("/index") or k in HELD: continue
        if k not in allk and k not in MAP["partner_articles_left_as_is"] and k not in MAP["manual"]:
            errs.append(f"{f}: not in seo-topic-map.json")
    for k in allk:
        rel = MAP["related"].get(k)
        if rel is None: errs.append(f"{k}: no 'related' entry in the map"); continue
        if len(rel) != 5 or len(set(rel)) != 5: errs.append(f"{k}: 'related' must hold five distinct links, has {len(rel)}")
        for u in rel:
            if u == f"/{k}.html": errs.append(f"{k}: related list links to itself")
            if u[1:-5] in HELD: errs.append(f"{k}: related list links to held page {u}")
    held_urls = {f"/{h}.html" for h in HELD}
    for f in articles():
        s = rd(f)
        m = BLOCK_RE.search(s)
        if not m: errs.append(f"{f}: no related block"); continue
        hrefs = re.findall(r'href=[\'"]([^\'"]+)', m.group(0))
        if not 3 <= len(hrefs) <= 6: errs.append(f"{f}: related block has {len(hrefs)} links (want 3 to 6)")
        for h in hrefs:
            p = norm_href(h)
            if not p.endswith(".html") and Path(p[1:] + ".html").exists(): continue
            if not Path(p[1:]).is_file(): errs.append(f"{f}: related link does not resolve: {h}")
            if p[1:] == f: errs.append(f"{f}: links to itself")
            if h.split("#")[0] in held_urls: errs.append(f"{f}: related block links to held page {h}")
        key = f[:-5]
        if key in OF:
            want = [u for u, _ in expected_links(key)]
            if hrefs != want: errs.append(f"{f}: related block differs from the map (run apply): {hrefs} != {want}")
        if not re.search(r'<nav[^>]*class="breadcrumb', s): errs.append(f"{f}: no visible breadcrumb")
        for lm in ld_blocks(s):
            j = json.loads(lm.group(2)); nodes = j.get("@graph", [j]) if isinstance(j, dict) else j
            for n in nodes:
                orgs = [n.get("publisher"), n.get("author")] if n.get("@type") in ("Article", "NewsArticle") else []
                for o in orgs:
                    if isinstance(o, dict) and o.get("@type") == "Organization":
                        miss = [x for x in ("name", "url", "logo", "sameAs") if not o.get(x)]
                        if miss: errs.append(f"{f}: Organization missing {miss}")
    # orphan control: every topic-mapped article must have an inbound link from another article
    inbound = {}
    for f in pages:
        if f.endswith("/index.html"): continue
        for h in re.findall(r'href=[\'"]([^\'"#]+)', re.sub(r"<script.*?</script>", "", rd(f), flags=re.S)):
            inbound.setdefault(h.lstrip("/").removesuffix(".html"), set()).add(f)
    for k in OF:
        if not {x for x in inbound.get(k, ()) if x != k + ".html"}:
            errs.append(f"{k}.html: orphan (no inbound link from another article)")
    for t in MAP["topics"]:
        hf = Path(f"{HUB_DIR}/{t['id']}.html")
        if not hf.is_file(): errs.append(f"hub missing {t['id']}"); continue
        hs = rd(str(hf))
        for h in re.findall(r'href=[\'"]([^\'"]+)', hs):
            if h.split("#")[0] in held_urls: errs.append(f"{hf}: hub links to held page {h}")
        for m in t["members"]:
            if f'href="/{m}.html"' not in hs: errs.append(f"{hf}: member {m} missing from hub")
    for idx in ("guides/index.html", "blog/index.html"):
        if Path(idx).is_file():
            for nm in re.finditer(r'<nav class="topic-nav".*?</nav>', rd(idx), re.S):
                for h in re.findall(r'href="([^"]+)"', nm.group(0)):
                    if h.split("#")[0] in held_urls: errs.append(f"{idx}: topic nav links to held page {h}")
    print("\n".join(errs) if errs else "PASS"); return 1 if errs else 0

def graph():
    def norm(u):
        u = u.split("#")[0].split("?")[0]
        return u + "index.html" if u.endswith("/") else u
    sm = [re.sub(r"^https://otterquote\.com", "", u) for u in re.findall(r"<loc>(.*?)</loc>", rd("sitemap.xml"))]
    sm = [norm(u) for u in sm]
    pages = [("/" + f) for f in glob.glob("**/*.html", recursive=True) if not f.startswith(("react-app", "Archive", "otterquote-deploy", "docs", "handoffs"))]
    inb, inp = {}, {}   # inbound from any link / inbound from a link inside a <p>
    for p in pages:
        s = re.sub(r"<script.*?</script>", "", rd(p[1:]), flags=re.S)
        prose = " ".join(re.findall(r"<p\b[^>]*>.*?</p>", s, flags=re.S))
        for store, text in ((inb, s), (inp, prose)):
            for h in re.findall(r'href=["\']([^"\'#]*)', text):
                m = re.match(r"https://(www\.)?otterquote\.com(/.*)?$", h)
                if h.startswith("http"):
                    if not m: continue
                    h = m.group(2) or "/"
                elif not h.startswith("/"): h = "/" + os.path.normpath(os.path.join(os.path.dirname(p[1:]), h))
                t = norm(h)
                if t != p: store.setdefault(t, set()).add(p)
    isart = lambda x: re.match(r"/(guides|blog|partners|news)/", x) and not x.endswith("/index.html")
    isart_or_loc = lambda x: isart(x) or re.match(r"/locations/", x)
    a = [u for u in sm if not any(isart(x) for x in inb.get(u, ()))]
    b = [u for u in sm if not any(isart_or_loc(x) for x in inb.get(u, ()))]
    c = [u for u in sm if not inb.get(u)]
    d = [u for u in sm if not any(isart(x) for x in inp.get(u, ()))]
    print(f"sitemap URLs {len(sm)}")
    print(f"  builder's measure (any link on any article, incl. related blocks and breadcrumbs): {len(a)} without one")
    print(f"  no link inside a <p> on any article (prose links only):                          {len(d)} without one")
    print(f"  no link from any article or location page: {len(b)}; from any page at all: {len(c)}")
    arts = [u for u in sm if isart(u)]
    print(f"article pages {len(arts)}; with no inbound link from another article: {len([u for u in arts if u in a])}; "
          f"with no prose link from another article: {len([u for u in arts if u in d])}; with none from any page: {len([u for u in arts if u in c])}")
    if "-v" in sys.argv:
        for u in d: print(" ", u)
    return 0

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "apply":
        only = sys.argv[sys.argv.index("--only") + 1:] if "--only" in sys.argv else None
        files = only or articles()
        n = sum(apply_one(f) for f in files)
        if not only: apply_hubs()
        print(f"changed {n} of {len(files)} article files")
    elif cmd == "check": sys.exit(check())
    elif cmd == "graph": sys.exit(graph())
