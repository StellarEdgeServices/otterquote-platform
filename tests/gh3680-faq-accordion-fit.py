"""gh-3680: every opened FAQ answer fits its content (clientHeight >= scrollHeight) at 320, 390 and 1280px wide.
Run: python3 tests/gh3680-faq-accordion-fit.py   (python playwright + chromium). Exit 0 = pass.
Serves the repo over local HTTP; non-local requests are aborted (hermetic). Items hidden via [hidden] are un-hidden
for the check (the guarantee item is revealed by js/guarantee-gate.js on the unmerged #3643 branch)."""
import http.server, threading, os, sys, functools
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
bad = []; total = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    for w in (320, 390, 1280):
        pg = b.new_page(viewport={"width": w, "height": 800})
        pg.route("**/*", lambda r: r.continue_() if r.request.url.startswith(base) else r.abort())
        pg.goto(base + "/faq.html", wait_until="load")
        n = pg.evaluate("document.querySelectorAll('.faq-item').length")
        for i in range(n):
            pg.evaluate("i => { var it=document.querySelectorAll('.faq-item')[i]; it.hidden=false; it.querySelector('.faq-question').click(); }", i)
            pg.wait_for_timeout(600)  # 0.4s max-height transition
            r = pg.evaluate("""i => { var it=document.querySelectorAll('.faq-item')[i], a=it.querySelector('.faq-answer');
              return {q: it.querySelector('.faq-question').textContent.replace(/\\s+/g,' ').replace(/▼/,'').trim().slice(0,60), c: a.clientHeight, s: a.scrollHeight}; }""", i)
            total += 1
            ok = r["c"] >= r["s"]
            if not ok: bad.append((w, r))
            print("%s w=%d client=%d scroll=%d  %s" % ("ok  " if ok else "FAIL", w, r["c"], r["s"], r["q"]))
            pg.evaluate("i => document.querySelectorAll('.faq-item')[i].querySelector('.faq-question').click()", i)
            pg.wait_for_timeout(450)
        # animation check (gh-3680 review 6825375633): ~50ms after the click the height is strictly between 0 and final
        if w == 320:
            for i in (0, 6):
                r = pg.evaluate("""async i => { var it=document.querySelectorAll('.faq-item')[i], a=it.querySelector('.faq-answer');
                  it.querySelector('.faq-question').click(); await new Promise(r=>setTimeout(r,50));
                  var mid=a.clientHeight; await new Promise(r=>setTimeout(r,700));
                  return {mid: mid, fin: a.clientHeight}; }""", i)
                total += 1
                ok = 0 < r["mid"] < r["fin"]
                print("%s animation item=%d mid(50ms)=%d final=%d" % ("ok  " if ok else "FAIL", i, r["mid"], r["fin"]))
                if not ok: bad.append(("anim", i, r))
                pg.evaluate("i => document.querySelectorAll('.faq-item')[i].querySelector('.faq-question').click()", i)
                pg.wait_for_timeout(450)
        # resize: open the longest item at 1280 -> shrink to 320 must refit
        if w == 1280:
            pg.evaluate("document.querySelectorAll('.faq-item')[%d].querySelector('.faq-question').click()" % 6)
            pg.set_viewport_size({"width": 320, "height": 800}); pg.wait_for_timeout(700)
            r = pg.evaluate("(()=>{var a=document.querySelectorAll('.faq-item')[6].querySelector('.faq-answer');return {c:a.clientHeight,s:a.scrollHeight}})()")
            total += 1
            print("%s resize 1280->320 client=%d scroll=%d" % ("ok  " if r["c"]>=r["s"] else "FAIL", r["c"], r["s"]))
            if r["c"] < r["s"]: bad.append(("resize", r))
        pg.close()
    b.close()
print("%d checks, %d clipped" % (total, len(bad)))
sys.exit(1 if bad else 0)
