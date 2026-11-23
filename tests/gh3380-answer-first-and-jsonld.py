#!/usr/bin/env python3
"""gh-3380 S-5 + S-7 check.
S-5: on how many guides (guides/*.html except index) is the FIRST content block after the h1 the author byline
     ("By Dustin Stohler and Sloane ...") instead of the opening paragraph? PASS = 0. (main before this PR: 41)
S-7: how many sitemap.xml pages have no JSON-LD Organization/Article node, outside the legal pages and the partner/referral pages? PASS = 0.
     Every ld+json block must parse (an empty block is reported, not failed: index.html carries one that is filled by script).
Run: python3 tests/gh3380-answer-first-and-jsonld.py [repo-root]     Exit 0 = PASS.
Text check: python3 tests/gh3380-answer-first-and-jsonld.py <repo-root> --text-diff <other-root>
            = for every guide, the multiset of visible text nodes is identical between the two trees (only order may differ).
"""
import glob, json, os, re, sys
from html.parser import HTMLParser
ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SKIP_CLASS = {'subtitle', 'hero-subtitle', 'back-link'}
LEGAL_PARTNER = re.compile(r'^(terms|privacy|sms-terms|[^/]*agreement[^/]*|[^/]*disclos[^/]*|partner[^/]*|partners/.*|ref-[^/]*|refer[^/]*)\.html$|^partners/')

class Blocks(HTMLParser):
    """block-level text after the first </h1>: p, h2-h4, li, div.author-name, span.byline, with the class of each"""
    def __init__(self):
        super().__init__(convert_charrefs=True); self.after_h1 = False; self.stack = []; self.blocks = []; self.skip = 0; self.nodes = []
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'): self.skip += 1
        cls = dict(attrs).get('class', '') or ''
        if self.after_h1 and not self.skip and (tag in ('p', 'h2', 'h3', 'h4', 'li') or (tag == 'div' and 'author-name' in cls) or (tag == 'span' and 'byline' in cls)):
            self.stack.append([tag, cls, []])
    def handle_endtag(self, tag):
        if tag in ('script', 'style'): self.skip = max(0, self.skip - 1)
        if tag == 'h1': self.after_h1 = True
        if self.stack and self.stack[-1][0] == tag:
            t, c, parts = self.stack.pop(); txt = ' '.join(''.join(parts).split())
            if txt: self.blocks.append((t, c, txt))
    def handle_data(self, d):
        if self.skip: return
        if d.strip(): self.nodes.append(' '.join(d.split()))
        for fr in self.stack: fr[2].append(d)

def parse(path):
    p = Blocks(); p.feed(open(path, encoding='utf8').read()); return p

def first_block(path):
    for t, c, txt in parse(path).blocks:
        if set(c.split()) & SKIP_CLASS: continue
        return txt
    return ''

def guides(root):
    return sorted(f for f in glob.glob(os.path.join(root, 'guides', '*.html')) if os.path.basename(f) != 'index.html')

def ld_types(html):
    types, bad, empty = [], 0, 0
    for m in re.finditer(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        if not m.group(1).strip(): empty += 1; continue
        try: j = json.loads(m.group(1))
        except Exception: bad += 1; continue
        for it in (j if isinstance(j, list) else (j.get('@graph') or [j])):
            t = it.get('@type'); types += t if isinstance(t, list) else [t]
    return types, bad, empty

def sitemap_pages(root):
    out = []
    for u in re.findall(r'<loc>(.*?)</loc>', open(os.path.join(root, 'sitemap.xml'), encoding='utf8').read()):
        p = re.sub(r'^https?://[^/]+', '', u).lstrip('/')
        f = next((c for c in [p, p + '.html', (p.rstrip('/') + '/index.html') if p else 'index.html'] if os.path.isfile(os.path.join(root, c))), None)
        if f: out.append(f)
        else: print('NOTE: sitemap URL with no file: ' + u)
    return out

def main():
    fails = 0
    gl = guides(ROOT)
    first_by = [os.path.relpath(f, ROOT) for f in gl if first_block(f).startswith('By Dustin Stohler')]
    print('S-5: guides checked = %d; guides whose first content block is the byline = %d' % (len(gl), len(first_by)))
    for r in first_by[:50]: print('  FAIL first block is byline: ' + r)
    fails += len(first_by)
    pages = sitemap_pages(ROOT); nonode, excluded, bad, empty = [], [], [], []
    for f in pages:
        types, b, e = ld_types(open(os.path.join(ROOT, f), encoding='utf8').read())
        if b: bad.append(f)
        if e: empty.append(f)
        has = 'Organization' in types or any(t in ('Article', 'BlogPosting', 'NewsArticle') for t in types)
        if not has: (excluded if LEGAL_PARTNER.match(f) else nonode).append(f)
    print('S-7: sitemap pages = %d; with no Organization/Article node: %d excluded (legal/partner/referral) + %d actionable' % (len(pages), len(excluded), len(nonode)))
    for f in excluded: print('  skipped (legal or partner page, needs a legal read): ' + f)
    for f in nonode: print('  FAIL no JSON-LD node: ' + f)
    for f in bad: print('  FAIL ld+json block does not parse: ' + f)
    for f in empty: print('  NOTE empty ld+json block (not parsed): ' + f)
    fails += len(nonode) + len(bad)
    if '--text-diff' in sys.argv:
        other = os.path.abspath(sys.argv[sys.argv.index('--text-diff') + 1]); diffs = 0; n = 0
        for f in gl:
            g = os.path.join(other, 'guides', os.path.basename(f))
            if not os.path.isfile(g): continue
            n += 1
            a, b = sorted(parse(f).nodes), sorted(parse(g).nodes)
            if a != b: diffs += 1; print('  TEXT DIFF: ' + os.path.relpath(f, ROOT))
        print('TEXT: %d guides compared with %s; visible-text multiset differences = %d' % (n, other, diffs)); fails += diffs
    print('RESULT: ' + ('PASS' if not fails else 'FAIL (%d)' % fails)); sys.exit(1 if fails else 0)

if __name__ == '__main__': main()
