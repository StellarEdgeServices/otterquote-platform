#!/usr/bin/env python3
"""gh-3643 (stacked on #3643): negative-control checks, headless Chromium.
 A  terms.html 8.5: 'This Section 8.5 does not limit Our 100-hour guarantee below.' exists exactly once, ONLY in a hidden
    .oq-guarantee element (the guarantee-gate.js mechanism), and with GUARANTEE_LIVE=false it renders nowhere.
 B  with GUARANTEE_LIVE=false no guarantee text (faq answer, terms section, sentence) is rendered on faq.html / terms.html.
 C  with the gate on, the opened guarantee FAQ answer is not clipped (scrollHeight <= clientHeight, last list item inside the box)
    at 320, 390 and 1280 px; every other open answer keeps the 500px cap rule.
Run: python3 tests/gh3643-faq-clip-terms-xref.py [repo-dir]   Exit 0 = all pass. Needs python playwright + chromium."""
import sys, os, threading, http.server, functools, re
from playwright.sync_api import sync_playwright
ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
SENT84 = 'It also does not apply to payments under Our 100-hour guarantee.'
SENT = 'This Section 8.5 does not limit Our 100-hour guarantee below.'
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{srv.server_port}'
fails = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' -- ' + detail if detail else ''))
    if not ok: fails.append(name)
def page(b, path, w, live):
    ctx = b.new_context(viewport={'width': w, 'height': 900}); pg = ctx.new_page()
    def route(r):
        u = r.request.url
        if not u.startswith(BASE): return r.abort()
        if live and u.endswith('/js/guarantee-gate.js'):
            body = open(os.path.join(ROOT, 'js/guarantee-gate.js'), encoding='utf-8').read().replace('GUARANTEE_LIVE = false', 'GUARANTEE_LIVE = true')
            return r.fulfill(body=body, content_type='application/javascript')
        r.continue_()
    pg.route('**/*', route); pg.goto(BASE + path); pg.wait_for_timeout(500); return pg
# static half of A
t = open(os.path.join(ROOT, 'terms.html'), encoding='utf-8').read()
check('A1 sentence present exactly once in terms.html', t.count(SENT) == 1, f'count={t.count(SENT)}')
m = re.search(r'<p([^>]*)>' + re.escape(SENT) + '</p>', t)
check('A2 sentence is in a <p class=oq-guarantee hidden>', bool(m) and 'oq-guarantee' in m.group(1) and re.search(r'\bhidden\b', m.group(1)) is not None, m.group(1) if m else 'no <p> wrapper')
i = t.find(SENT); j = t.find('id="guarantee-terms"'); k = t.find('8.5 Measurement Fee')
check('A3 sentence sits inside Section 8.5 (after its heading, before the guarantee section)', 0 < k < i < j)
# D: Terms 8.4 carve-out (Ben ruling 6824846681), gated like the 8.5 sentence
check('D1 8.4 sentence present exactly once in terms.html', t.count(SENT84) == 1, f'count={t.count(SENT84)}')
m4 = re.search(r'<(span|p)([^>]*)>\s*' + re.escape(SENT84) + r'\s*</\1>', t)
check('D2 8.4 sentence is in a hidden .oq-guarantee element', bool(m4) and 'oq-guarantee' in m4.group(2) and re.search(r'\bhidden\b', m4.group(2)) is not None, m4.group(2) if m4 else 'no gated wrapper')
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = page(b, '/terms.html', 1280, False)
    check('D3 flag off: 8.4 sentence not rendered', SENT84 not in pg.evaluate('document.body.innerText')); pg.context.close()
    pg = page(b, '/terms.html', 1280, True)
    check('D4 flag on: 8.4 sentence IS rendered', SENT84 in pg.evaluate('document.body.innerText')); pg.context.close()
    for path in ('/terms.html', '/faq.html'):
        pg = page(b, path, 1280, False)
        txt = pg.evaluate('document.body.innerText')
        check(f'B flag off {path}: sentence not rendered', SENT not in txt)
        check(f'B flag off {path}: no "100-hour" text rendered', '100-hour' not in txt and '100 hours' not in txt)
        vis = pg.evaluate("[...document.querySelectorAll('.oq-guarantee')].filter(e=>e.offsetParent!==null||e.getClientRects().length).length")
        check(f'B flag off {path}: 0 visible .oq-guarantee elements', vis == 0, f'visible={vis}')
        pg.context.close()
    pg = page(b, '/terms.html', 1280, True)
    check('A4 flag on (control): sentence IS rendered', SENT in pg.evaluate('document.body.innerText')); pg.context.close()
    for w in (320, 390, 1280):
        pg = page(b, '/faq.html', w, True)
        pg.evaluate("document.querySelector('.faq-item.oq-guarantee .faq-question').click()"); pg.wait_for_timeout(900)
        r = pg.evaluate("""()=>{const a=document.querySelector('.faq-item.oq-guarantee.open .faq-answer'); if(!a) return null;
          const li=[...a.querySelectorAll('li')].pop(), ab=a.getBoundingClientRect(), lb=li.getBoundingClientRect();
          return {sh:a.scrollHeight,ch:a.clientHeight,cap:getComputedStyle(a).maxHeight,lastBottom:lb.bottom,boxBottom:ab.bottom}}""")
        ok = r is not None and r['sh'] <= r['ch'] and r['lastBottom'] <= r['boxBottom'] + 1
        check(f'C width {w}: guarantee answer not clipped', ok, str(r)); pg.context.close()
    pg = page(b, '/faq.html', 390, True)
    pg.evaluate("document.querySelector('.faq-item:not(.oq-guarantee)').classList.add('open')"); pg.wait_for_timeout(900)
    cap = pg.evaluate("getComputedStyle(document.querySelector('.faq-item:not(.oq-guarantee) .faq-answer')).maxHeight")
    check('C2 other FAQ items keep the 500px cap', cap == '500px', cap)
    b.close()
print('RESULT', 'FAIL ' + ', '.join(fails) if fails else 'ALL PASS'); sys.exit(1 if fails else 0)
