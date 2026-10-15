/**
 * gh-2598 slice 1 -- static pin for the staging page /home-next (home-next.html, css/home-reskin.css, js/home-reskin.js).
 *
 * What it pins (review of #2617, B1 / M1 / m3 / m4 / m5 / m8 / m10):
 *   T1  no ZIP in any URL the script builds or navigates to; the ZIP travels in sessionStorage ('oq_home_zip'); a browser that throws on
 *       storage still navigates; no analytics call carries the ZIP value
 *   T2  analytics only through the existing gate files (no other loader, no direct vendor host, no fetch/beacon/pixel in the script)
 *   T3  <meta name="robots" content="noindex..."> present
 *   T4  no rel=canonical pointing at the live homepage (self-canonical or none)
 *   T5  not linked from any other tracked file; not in sitemap.xml or llms.txt
 *   T6  every in-page #link has a target; the hidden-until-animated class is added by the script, not inline; modified clicks are not swallowed
 *   T7  phone/desktop row label pair matches the two design files ("Reviews" on phones, "Public reviews" otherwise)
 *   T6  (correction 3) the pre-paint inline script in <head> sets html.hr-js before first paint, never when reduced motion is preferred, fails open on a timer,
 *       on script error and on any exception; no JS = words visible; the main script stops the timer and still plays one pass
 *   T9  (correction 3, closes the 9-of-17 mutation gap of #2617 review 6067478307) every click/Enter path is EXECUTED and every outbound channel is observed:
 *       URL, link href, window.open, cookie, localStorage, fbq, dataLayer, Image, fetch, XHR, sendBeacon; a stale ZIP is removed
 *   T8  (slice 2) the closing-band ZIP field: same hand-off as the hero (sessionStorage, never a URL, never an event), cta_location 'closing',
 *       Enter key and click paths, header/sticky buttons fall back to whichever field holds a ZIP, the closing phone link is tagged
 * Every test has a NEGATIVE CONTROL: a mutation of the real source that must turn it red.
 * HOME_NEXT_ROOT=<dir> points the test at another checkout (used to run it against the pre-fix commit).
 * Run: node tests/gh2598-home-next-staging.mjs      Exit 0 = all green including every control going red.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.HOME_NEXT_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
function control(id, red) { ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source'); }

const HTML = read('home-next.html');
const JS = read('js/home-reskin.js');
const ZIP = '46077';
const NEW_FILES = ['home-next.html', 'css/home-reskin.css', 'js/home-reskin.js'];

/* ---------- a tiny DOM, enough to run home-reskin.js and the head script for real ---------- */
function makeEnv(js, opts = {}) {
  const log = { nav: [], gtag: [], store: {}, prevented: 0, cookies: [], lstore: [], fbq: [], dl: [], net: [], opened: [], timers: [], cleared: [] };
  const mkEl = (attrs = {}) => {
    const el = { value: '', textContent: '', attrs: { ...attrs }, handlers: {}, cls: new Set(),
      addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      classList: { toggle(c, on) { if (on === undefined ? !el.cls.has(c) : on) { el.cls.add(c); } else { el.cls.delete(c); } }, add(c) { el.cls.add(c); }, remove(c) { el.cls.delete(c); } } };
    return el;
  };
  const zip = mkEl({ id: 'hr-zip' });
  const zipEnd = mkEl({ id: 'hr-zip-end' });
  const anchors = ['hero', 'header', 'sticky', 'closing'].map((k) => mkEl({ 'data-hr-go': k }));
  const byId = { '#hr-zip': zip, '#hr-zip-end': zipEnd, '#hr-explain': mkEl(), '#hr-replay': mkEl() };
  const root = mkEl();
  const doc = {
    documentElement: root,
    querySelector: (s) => (opts.missing && opts.missing.indexOf(s) >= 0 ? null : (byId[s] || (/^#hr-(sticky|hero-go)$/.test(s) ? null : (byId[s] = mkEl())))),
    querySelectorAll: (s) => (s === '[data-hr-go]' ? anchors : []),
  };
  Object.defineProperty(doc, 'cookie', { get() { return ''; }, set(v) { log.cookies.push(String(v)); } });
  if (opts.preseed) { log.store.oq_home_zip = opts.preseed; }
  const storage = opts.blockStorage
    ? { setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); } }
    : { setItem: (k, v) => { log.store[k] = String(v); }, removeItem: (k) => { delete log.store[k]; }, getItem: (k) => log.store[k] };
  const loc = { search: '?utm_source=x&fbclid=abc' };
  Object.defineProperty(loc, 'href', { get() { return 'https://otterquote.com/home-next'; }, set(v) { log.nav.push(v); } });
  const reduce = opts.reduce === undefined ? true : opts.reduce;
  const spy = (kind) => function (...a) { log.net.push(kind + ':' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(',')); };
  const Img = function () { const o = {}; Object.defineProperty(o, 'src', { set(v) { log.net.push('image:' + v); } }); return o; };
  const win = { document: doc, location: loc, sessionStorage: storage,
    localStorage: { setItem: (k, v) => { log.lstore.push(k + '=' + v); }, removeItem() {}, getItem() { return null; } },
    matchMedia: opts.matchMediaThrows ? () => { throw new Error('no matchMedia'); } : () => ({ matches: reduce }),
    gtag: (...a) => log.gtag.push(JSON.stringify(a)),
    fbq: (...a) => log.fbq.push(JSON.stringify(a)),
    dataLayer: { push: (...a) => log.dl.push(JSON.stringify(a)) },
    Image: Img, fetch: spy('fetch'), XMLHttpRequest: function () { this.open = spy('xhr-open'); this.send = spy('xhr-send'); },
    navigator: { sendBeacon: spy('beacon') }, open: (...a) => { log.opened.push(a.join(',')); },
    URLSearchParams, console,
    setTimeout: (f, ms) => { if (opts.timerThrows) { throw new Error('no timers'); } log.timers.push({ f, ms }); return log.timers.length; },
    clearTimeout: (id) => { log.cleared.push(id); } };
  if (opts.hrOpened) { win.__hrOpened = true; }
  win.window = win;
  const ctx = vm.createContext(win);   /* bare identifiers and window.x are the same object, so `new Image`, `fbq(...)` and `window.fbq(...)` all reach the spies */
  vm.runInContext(js, ctx);
  const click = (a, ev = {}) => { const e = { button: 0, preventDefault() { log.prevented++; }, ...ev }; (a.handlers.click || []).forEach((f) => f(e)); };
  const typeZip = (v, el = zip) => { el.value = v; (el.handlers.input || []).forEach((f) => f({})); };
  const press = (el, key) => { const e = { key, preventDefault() { log.prevented++; } }; (el.handlers.keydown || []).forEach((f) => f(e)); };
  const run = (src) => vm.runInContext(src, ctx);
  return { log, zip, zipEnd, anchors, click, typeZip, press, root, byId, run, win };
}
/* every string that left the script by any channel, plus every link href */
const outbound = (e) => [...e.log.nav, ...e.log.gtag, ...e.log.cookies, ...e.log.lstore, ...e.log.fbq, ...e.log.dl, ...e.log.net, ...e.log.opened, ...e.anchors.map((a) => a.attrs.href || '')];

/* ---------- T1 ---------- */
function t1(js) {
  const out = [];
  const a = makeEnv(js);
  a.typeZip(ZIP); a.click(a.anchors[0]);
  out.push(['navigates after a click', a.log.nav.length === 1]);
  out.push(['URL has no ZIP and no zip= parameter', a.log.nav.every((u) => !u.includes(ZIP) && !/[?&]zip=/i.test(u))]);
  out.push(['URL keeps entry=home and the attribution parameters', a.log.nav.every((u) => /^\/start\.html\?/.test(u) && /entry=home/.test(u) && /utm_source=x/.test(u) && /fbclid=abc/.test(u))]);
  out.push(["ZIP handed over in sessionStorage 'oq_home_zip'", a.log.store.oq_home_zip === ZIP]);
  out.push(['no analytics call carries the ZIP', a.log.gtag.every((g) => !g.includes(ZIP)) && a.log.gtag.length > 0]);
  out.push(['href fallbacks carry no ZIP', a.anchors.every((x) => !/zip/i.test(x.attrs.href || ''))]);
  const b = makeEnv(js, { blockStorage: true });
  b.typeZip(ZIP); let threw = false; try { b.click(b.anchors[1]); } catch (e) { threw = true; }
  out.push(['storage blocked: still navigates, does not throw', !threw && b.log.nav.length === 1 && !b.log.nav[0].includes(ZIP)]);
  const c = makeEnv(js, { preseed: '99999' }); c.typeZip('123'); c.click(c.anchors[2]);
  out.push(['incomplete ZIP: nothing stored, a stale stored ZIP is removed', c.log.store.oq_home_zip === undefined]);
  return out;
}
const t1ok = t1(JS); t1ok.forEach(([l, v]) => ok(v, 'T1 ' + l));
const jsZipInUrl = JS.replace("qs.push('entry=home');", "qs.push('entry=home'); if (arguments.length) { qs.push('zip=' + arguments[0]); }")
  .replace('window.location.href = startUrl();', 'window.location.href = startUrl() + "&zip=" + zipValue(loc);');
control('T1', t1(jsZipInUrl).some(([, v]) => !v));
const jsEventZip = JS.replace("zip_present: /^\\d{5}$/.test(zipValue(loc)) ? 'yes' : 'no' });\n    stashZip(loc);", "zip_present: zipValue(loc) });\n    stashZip(loc);");
control('T1 (event)', jsEventZip !== JS && t1(jsEventZip).some(([, v]) => !v));
const jsThrow = JS.replace('} catch (e) {}   /* storage blocked', '} catch (e) { throw e; }   /* storage blocked');
const jsKeepStale = JS.replace('else { window.sessionStorage.removeItem(ZIP_KEY); }', 'else { void 0; }');
control('T1 (stale ZIP survives an emptied field)', jsKeepStale !== JS && t1(jsKeepStale).some(([, v]) => !v));
control('T1 (blocked storage)', jsThrow !== JS && t1(jsThrow).some(([, v]) => !v));

/* ---------- T2 ---------- */
function t2(html, js) {
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  const dyn = [...html.matchAll(/\.src\s*=\s*(['"])([^'"]+)\1/g)].map((m) => m[2])
    .concat([...html.matchAll(/setAttribute\(\s*(['"])src\1\s*,\s*(['"])([^'"]+)\2/g)].map((m) => m[3]));
  const allowed = new Set(['/js/internal-traffic.js', '/js/home-reskin.js', '/js/ga-gate.js', '/js/meta-pixel-gate.js']);
  const vendor = /googletagmanager|google-analytics|facebook\.net|facebook\.com\/tr|clarity\.ms|fbevents|gtag\/js|hotjar|linkedin|reddit|segment|mixpanel/i;
  return [
    ['every script is one of the four known files', [...srcs, ...dyn].every((s) => allowed.has(s))],
    ['the two gates are the only analytics loaders', dyn.slice().sort().join() === '/js/ga-gate.js,/js/meta-pixel-gate.js'],
    ['no vendor host named in the page or script', !vendor.test(html) && !vendor.test(js)],
    ['the script makes no network call or script/pixel element', !/\b(fetch|XMLHttpRequest|sendBeacon|Image|createElement|fbq)\b/.test(js.replace(/\/\*[\s\S]*?\*\//g, ''))],
  ];
}
t2(HTML, JS).forEach(([l, v]) => ok(v, 'T2 ' + l));
control('T2', t2(HTML.replace('</head>', '<script src="https://www.clarity.ms/tag/x"></script></head>'), JS).some(([, v]) => !v));
control('T2 (third-party script, double quotes)', t2(HTML.replace("g.src = '/js/ga-gate.js';", 'g.src = "/js/ga-gate.js"; var x = document.createElement("script"); x.src = "https://evil.test/a.js";'), JS).some(([, v]) => !v));
control('T2 (third-party script, setAttribute)', t2(HTML.replace("g.src = '/js/ga-gate.js';", "g.src = '/js/ga-gate.js'; var x = document.createElement('script'); x.setAttribute('src', 'https://evil.test/a.js');"), JS).some(([, v]) => !v));
control('T2 (script)', t2(HTML, JS + "\nfetch('https://x.test/?z=' + zipValue());").some(([, v]) => !v));

/* ---------- T3, T4 ---------- */
const noindex = (html) => /<meta\s+name="robots"\s+content="[^"]*noindex[^"]*"/i.test(html);
const canonicals = (html) => [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /\brel\s*=\s*["']?canonical\b/i.test(t)).map((t) => (t.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [, ''])[1]);
const toLive = (h) => { try { const u = new URL(h, 'https://otterquote.com/home-next'); return u.pathname === '/' || u.pathname === '/index.html'; } catch (e) { return true; } };
ok(noindex(HTML), 'T3 page is noindex');
control('T3', !noindex(HTML.replace('content="noindex, follow"', 'content="index, follow"')));
ok(canonicals(HTML).length <= 1 && canonicals(HTML).every((h) => !toLive(h)), 'T4 no canonical to the live homepage (' + (canonicals(HTML)[0] || 'none') + ')');
control('T4 (href before rel)', canonicals(HTML.replace('<link rel="canonical" href="https://otterquote.com/home-next">', '<link href="https://otterquote.com/" rel="canonical">')).some(toLive));
control('T4', canonicals(HTML.replace(/(rel="canonical" href=")[^"]*/, '$1https://otterquote.com/')).some(toLive));

/* ---------- T5 ---------- */
const own = new Set([...NEW_FILES, 'tests/gh2598-home-next-staging.mjs', 'tests/gh2598-home-next-sections.mjs', '.github/workflows/static-pixel-gate-tests.yml']);
const ls = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
const files = ls.status === 0 ? ls.stdout.split('\n').filter(Boolean) : [];
ok(files.length > 100, 'T5 git ls-files lists the tree (' + files.length + ' files)');
const refs = [];
for (const f of files) {
  if (own.has(f) || /\.(png|jpe?g|webp|gif|ico|woff2?|pdf|mp4|zip|lock)$/i.test(f)) continue;
  let s; try { s = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
  if (/home-next|home-reskin/.test(s)) refs.push(f);
}
ok(refs.length === 0, 'T5 no other tracked file mentions home-next or home-reskin' + (refs.length ? ': ' + refs.join(', ') : ''));
const listed = (sm, llms) => /home-next/.test(sm) || /home-next/.test(llms);
ok(!listed(read('sitemap.xml'), read('llms.txt')), 'T5 not in sitemap.xml or llms.txt');
control('T5', listed(read('sitemap.xml') + '\n<loc>https://otterquote.com/home-next</loc>', read('llms.txt')) && listed(read('sitemap.xml'), read('llms.txt') + '\nhttps://otterquote.com/home-next'));

/* ---------- T6 ---------- */
const CSS = read('css/home-reskin.css');
const headOf = (html) => (html.match(/<head>[\s\S]*?<\/head>/) || [''])[0];
const preScript = (html) => { const m = [...headOf(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1]).filter((t) => /hr-js/.test(t.replace(/\/\*[\s\S]*?\*\//g, ''))); return m.length === 1 ? m[0] : null; };
function t6(html, js, css) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const hashes = [...html.matchAll(/<a[^>]*\shref="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  const e = makeEnv(js); e.typeZip(ZIP);
  e.click(e.anchors[0], { ctrlKey: true }); const afterCtrl = e.log.prevented + e.log.nav.length;
  e.click(e.anchors[0], { metaKey: true }); e.click(e.anchors[0], { shiftKey: true }); e.click(e.anchors[0], { button: 1 });
  const plain = makeEnv(js); plain.typeZip(ZIP); plain.click(plain.anchors[0]);
  const out = [
    ['every #link on the page has a target', hashes.every((h) => ids.has(h))],
    ['modified clicks (ctrl, meta, shift, middle) are not prevented and do not navigate this tab', afterCtrl === 0 && e.log.prevented === 0 && e.log.nav.length === 0],
    ['a plain click is prevented and navigates', plain.log.prevented === 1 && plain.log.nav.length === 1],
  ];
  /* correction 3: the pre-paint script, executed */
  const pre = preScript(html);
  const bodyPart = html.slice(html.indexOf('</head>'));
  const tag = (html.match(/<script\b[^>]*\ssrc="\/js\/home-reskin\.js"[^>]*>/) || [''])[0];
  out.push(['exactly one inline script in <head> mentions hr-js, it is a plain synchronous script, and nothing after </head> mentions hr-js', pre !== null && !/hr-js/.test(bodyPart) && /<script>/.test(headOf(html)) && !/<html[^>]*hr-js/.test(html)]);
  if (pre === null) { return out.concat([['pre-paint script cases', false]]); }
  const n = makeEnv('', { reduce: false }); n.run(pre);
  const hadClass = n.root.cls.has('hr-js'), timer = n.log.timers[0];
  out.push(['no reduced-motion preference: hr-js is on the root element as soon as the head script ends (before any body markup is parsed)', hadClass]);
  out.push(['a fail-open timer of 1 to 5 s is armed and, when it fires, hr-js is removed', !!timer && timer.ms >= 1000 && timer.ms <= 5000 && (timer.f(), !n.root.cls.has('hr-js'))]);
  const r = makeEnv('', { reduce: true }); r.run(pre);
  out.push(['prefers-reduced-motion: reduce: hr-js is never added, so the words stay visible', !r.root.cls.has('hr-js')]);
  const mm = makeEnv('', { matchMediaThrows: true }); let threw = false; try { mm.run(pre); } catch (x) { threw = true; }
  out.push(['matchMedia throws: the head script does not throw and leaves the words visible', !threw && !mm.root.cls.has('hr-js')]);
  const tt = makeEnv('', { reduce: false, timerThrows: true }); let ttThrew = false; try { tt.run(pre); } catch (x) { ttThrew = true; }
  out.push(['an exception after the class was added (timer cannot be armed): the head script opens the words and does not throw', !ttThrew && !tt.root.cls.has('hr-js')]);
  const er = makeEnv('', { reduce: false }); er.run(pre);
  const oe = (tag.match(/onerror="([^"]*)"/) || [, ''])[1].replace(/&amp;/g, '&');
  let oeThrew = false; try { er.run(oe); } catch (x) { oeThrew = true; }
  out.push(['/js/home-reskin.js onerror removes hr-js (fail open on a load error) and does not throw', oe !== '' && !oeThrew && !er.root.cls.has('hr-js')]);
  const m = makeEnv(js, { reduce: false }); m.run(pre); const id = m.log.timers.length;
  m.run(js);
  out.push(['the main script, once it runs, clears the fail-open timer and leaves hr-js in place for its one pass', m.log.cleared.length >= 1 && m.log.cleared.includes(id) && m.root.cls.has('hr-js')]);
  const pass = makeEnv(js, { reduce: false });
  const w = ['#hr-w1', '#hr-w2', '#hr-w3'].map((k) => pass.byId[k]);
  const firstOn = w.map((x) => x && x.cls.has('hr-on'));
  pass.log.timers.slice().forEach((t) => t.f());
  out.push(['motion still plays one pass: all three words start unrevealed and end revealed after the timeline fires', w.every((x) => x) && firstOn.every((v) => v === false) && w.every((x) => x.cls.has('hr-on'))]);
  /* late script: the head script runs for real, its fail-open timer fires, THEN the main script arrives */
  const late = makeEnv('', { reduce: false }); late.run(pre); if (late.log.timers[0]) { late.log.timers[0].f(); } late.run(js);
  const wl = ['#hr-w1', '#hr-w2', '#hr-w3'].map((k) => late.byId[k]);
  out.push(['script arrives after the fail-open fired (head script executed): no hiding, the first pass shows the finished state at once', wl.every((x) => x && x.cls.has('hr-on')) && !late.root.cls.has('hr-js')]);
  /* m1 (review 6199226076): play() throws (#hr-explain missing) after the timer would have been cleared; the words must still end visible.
     Checked BEFORE the head script's own 2.5 s timer is allowed to fire, so that timer cannot be what rescues the words. */
  const bad = makeEnv('', { reduce: false, missing: ['#hr-explain'] }); bad.run(pre);
  const badTimer = bad.log.timers[0]; let badThrew = false;
  try { bad.run(js); } catch (x) { badThrew = true; }
  const hiddenNow = bad.root.cls.has('hr-js');
  bad.log.timers.filter((t) => t !== badTimer).forEach((t) => { try { t.f(); } catch (x) {} });
  out.push(['m1: play() throws (#hr-explain missing): the main script fails open at once (hr-js removed, no throw), without waiting for the head timer, and stays open', !badThrew && !hiddenNow && !bad.root.cls.has('hr-js') && bad.win.__hrOpened === true]);
  const okp = makeEnv('', { reduce: false }); okp.run(pre); const okTimer = okp.log.timers.length; okp.run(js);
  out.push(['m1: play() starting fine still clears the head timer exactly as before and keeps hr-js for the pass', okp.log.cleared.includes(okTimer) && okp.root.cls.has('hr-js')]);
  /* CSS: the words are hidden only under html.hr-js, so no JS (or a failed script) means visible text */
  const hides = [...css.matchAll(/([^{}]+)\{[^}]*opacity\s*:\s*0\s*[;}]/g)].map((x) => x[1].trim()).filter((sel) => /\.hr-w\b/.test(sel));
  out.push(['CSS hides the words only under .hr-js (no JS: visible)', hides.length >= 1 && hides.every((sel) => /^\.hr-js\s+\.hr-w\b/.test(sel))]);
  out.push(['CSS: reduced motion removes the word transition', /prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.hr-w[^}]*transition:\s*none/.test(css)]);
  return out;
}
t6(HTML, JS, CSS).forEach(([l, v]) => ok(v, 'T6 ' + l));
const red6 = (h, j, c) => t6(h, j, c).some(([, v]) => !v);
control('T6 (dead link)', t6(HTML.replace('<main>', '<a href="#no-such-section">Nowhere</a><main>'), JS, CSS)[0][1] === false);
control('T6 (modified click)', t6(HTML, JS.replace(/if \(e\.metaKey[^\n]*\{/, 'if (false) {'), CSS)[1][1] === false);
const PRE_RE = /(<script>\n\/\* gh-2598 correction 3[\s\S]*?<\/script>\n)/;
const preBlock = (HTML.match(PRE_RE) || [''])[1];
ok(preBlock !== '', 'T6 the pre-paint script block is where the controls expect it');
control('T6 (pre-paint script removed: class added only after first paint)', red6(HTML.replace(preBlock, ''), JS.replace("var late =", "document.documentElement.classList.add('hr-js'); var late ="), CSS));
control('T6 (pre-paint script moved to the end of the body)', red6(HTML.replace(preBlock, '').replace('</body>', preBlock + '</body>'), JS, CSS));
control('T6 (hr-js added with className +=)', red6(HTML.replace(preBlock, '').replace('<link rel="stylesheet"', '<script>document.documentElement.className += " hr-js";</script><link rel="stylesheet"'), JS, CSS));
control('T6 (hr-js written into the <html> tag)', red6(HTML.replace('<html lang="en">', '<html lang="en" class="hr-js">'), JS, CSS));
control('T6 (no fail-open timer)', red6(HTML.replace('window.__hrTimer = setTimeout(open, 2500);', ''), JS, CSS));
control('T6 (timer far too long)', red6(HTML.replace('setTimeout(open, 2500)', 'setTimeout(open, 60000)'), JS, CSS));
control('T6 (reduced motion not honoured)', red6(HTML.replace("window.matchMedia('(prefers-reduced-motion: reduce)').matches", 'false'), JS, CSS));
control('T6 (matchMedia exception leaves the words hidden)', red6(HTML.replace('} catch (e) { open(); }', '} catch (e) { }'), JS, CSS));
control('T6 (onerror removed)', red6(HTML.replace(/ onerror="[^"]*"/, ''), JS, CSS));
control('T6 (main script never stops the timer)', red6(HTML, JS.replace("try { clearTimeout(window.__hrTimer); } catch (e) {}", ''), CSS));
control('T6 (late script hides the words again)', red6(HTML, JS.replace('if (calm() || (first && late))', 'if (calm())'), CSS));
const JS_PREFIX = JS.replace(/  try \{\n    play\(\);\n    try \{ clearTimeout\(window\.__hrTimer\); \} catch \(e\) \{\}\n  \} catch \(e\) \{[\s\S]*?\n  \}\n/, "  play();\n").replace('var late =', 'try { clearTimeout(window.__hrTimer); } catch (e) {}\n  var late =');   /* the pre-m1 behaviour: timer cleared first, play() unguarded */
control('T6 (m1: timer cleared before play(), a throw in play() leaves the words hidden)', JS_PREFIX !== JS && red6(HTML, JS_PREFIX, CSS));
control('T6 (m1: catch does not remove hr-js)', red6(HTML, JS.replace("d.documentElement.classList.remove('hr-js'); window.__hrOpened = true;", 'void 0;'), CSS));
control('T6 (CSS hides the words without .hr-js)', red6(HTML, JS, CSS.replace('.hr-js .hr-w { opacity: 0;', '.hr-w { opacity: 0;')));

/* ---------- T7 ---------- */
const lab = (html) => /<div role="rowheader"><span class="hr-full">Public reviews<\/span><span class="hr-short">Reviews<\/span><\/div>/.test(html);
ok(lab(HTML), 'T7 row label: "Public reviews" on desktop, "Reviews" on phones (the two design files)');
control('T7', !lab(HTML.replace('<span class="hr-short">Reviews</span>', '')));
const labCss = (css) => /\.hr-short\s*\{\s*display:\s*none/.test(css) && /@media\s*\(max-width:\s*767px\)\s*\{[^@]*?\.hr-full[^}]*display:\s*none[^}]*\}\s*\.hr-short\s*\{\s*display:\s*inline/.test(css);
ok(labCss(CSS), 'T7 CSS: the short label is hidden by default and shown on phones, the full label hidden on phones');
control('T7 (CSS, phones show no label)', !labCss(CSS.replace('.hr-short { display: inline; }', '')));

/* ---------- T8 (slice 2): closing-band ZIP field ---------- */
const noCookie = (js) => !/\bcookie\b/i.test(js.replace(/\/\*[\s\S]*?\*\//g, ''));
function t8(js, html) {
  const out = [];
  const a = makeEnv(js);
  a.typeZip(ZIP, a.zipEnd); a.click(a.anchors[3]);
  out.push(['closing button navigates once to /start.html?entry=home with no ZIP in the URL', a.log.nav.length === 1 && /^\/start\.html\?/.test(a.log.nav[0]) && /entry=home/.test(a.log.nav[0]) && !a.log.nav[0].includes(ZIP) && !/zip=/i.test(a.log.nav[0])]);
  out.push(["closing ZIP handed over in sessionStorage 'oq_home_zip'", a.log.store.oq_home_zip === ZIP]);
  out.push(["closing click records hero_cta_click with cta_location 'closing' and zip_present yes", a.log.gtag.some((g) => /hero_cta_click/.test(g) && /"cta_location":"closing"/.test(g) && /"zip_present":"yes"/.test(g))]);
  out.push(["completing the closing ZIP records zip_entered with cta_location 'closing' (once)", a.log.gtag.filter((g) => /zip_entered/.test(g) && /"cta_location":"closing"/.test(g)).length === 1]);
  out.push(['no analytics call carries the ZIP', a.log.gtag.every((g) => !g.includes(ZIP))]);
  const b = makeEnv(js);
  b.typeZip(ZIP, b.zipEnd); b.press(b.zipEnd, 'Enter');
  out.push(['Enter in the closing field navigates, with no ZIP in the URL, and stores the ZIP', b.log.nav.length === 1 && !b.log.nav[0].includes(ZIP) && b.log.store.oq_home_zip === ZIP && b.log.gtag.some((g) => /hero_cta_click/.test(g) && /"cta_location":"closing"/.test(g))]);
  const c = makeEnv(js);
  c.typeZip(ZIP); c.press(c.zip, 'Enter');
  out.push(["Enter in the hero field still reports cta_location 'hero'", c.log.nav.length === 1 && c.log.gtag.some((g) => /hero_cta_click/.test(g) && /"cta_location":"hero"/.test(g))]);
  const d = makeEnv(js);
  d.typeZip(ZIP, d.zipEnd); d.click(d.anchors[2]);
  out.push(['sticky button with only the closing field filled still carries that ZIP (stored, not in the URL)', d.log.store.oq_home_zip === ZIP && d.log.nav.length === 1 && !d.log.nav[0].includes(ZIP)]);
  const e = makeEnv(js);
  e.typeZip(ZIP); e.typeZip('12', e.zipEnd); e.click(e.anchors[3]);
  out.push(['closing button with a short closing ZIP falls back to the complete hero ZIP', e.log.store.oq_home_zip === ZIP]);
  const f = makeEnv(js);
  f.typeZip('123', f.zipEnd); f.click(f.anchors[3]);
  out.push(['incomplete ZIPs everywhere: nothing stored', f.log.store.oq_home_zip === undefined]);
  const g = makeEnv(js);
  g.typeZip(ZIP, g.zipEnd); g.click(g.anchors[3], { ctrlKey: true });
  out.push(['Ctrl-click on the closing button is not prevented and does not navigate this tab', g.log.prevented === 0 && g.log.nav.length === 0 && g.log.gtag.some((x) => /"cta_location":"closing"/.test(x))]);
  const h = makeEnv(js, { blockStorage: true });
  h.typeZip(ZIP, h.zipEnd); let threw = false; try { h.click(h.anchors[3]); } catch (x) { threw = true; }
  out.push(['storage blocked: the closing button still navigates and does not throw', !threw && h.log.nav.length === 1]);
  out.push(['the script never reads or writes a cookie', noCookie(js)]);
  out.push(['markup: closing ZIP input has id hr-zip-end, a visible label, numeric keyboard, postal-code autocomplete and maxlength 5',
    /<label class="hr-lab" for="hr-zip-end">ZIP code of the home<\/label>/.test(html) && /<input id="hr-zip-end"[^>]*inputmode="numeric"[^>]*autocomplete="postal-code"[^>]*maxlength="5"/.test(html)]);
  out.push(["markup: closing button has data-hr-go=\"closing\" and the closing phone link has data-hr-phone=\"closing\" and tel:+18448753412",
    /data-hr-go="closing"/.test(html) && /<a[^>]*href="tel:\+18448753412"[^>]*data-hr-phone="closing"/.test(html)]);
  return out;
}
t8(JS, HTML).forEach(([l, v]) => ok(v, 'T8 ' + l));
control('T8 (closing event reports the wrong location)', t8(JS.replace("wireZip(zipEnd, 'closing');", "wireZip(zipEnd, 'hero');"), HTML).some(([, v]) => !v));
control('T8 (Enter key on the closing field removed)', t8(JS.replace("if (e.key === 'Enter') { e.preventDefault(); go(loc); }", 'void 0;'), HTML).some(([, v]) => !v));
control('T8 (ZIP in the URL on the Enter path)', t8(JS.replace("if (e.key === 'Enter') { e.preventDefault(); go(loc); }", "if (e.key === 'Enter') { e.preventDefault(); window.location.href = startUrl() + '&zip=' + zipValue(loc); }"), HTML).some(([, v]) => !v));
control('T8 (ZIP written to a cookie)', !noCookie(JS.replace('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); window.document.cookie = 'z=' + v;")));
control('T8 (closing ZIP input removed from the page)', t8(JS, HTML.replace('id="hr-zip-end"', 'id="other"')).some(([, v]) => !v));

/* ---------- T9 (correction 3): every path executed, every outbound channel observed ---------- */
function t9(js) {
  const out = [];
  const paths = {
    'plain click': (e) => { e.typeZip(ZIP); e.click(e.anchors[0]); },
    'ctrl-click': (e) => { e.typeZip(ZIP); e.click(e.anchors[0], { ctrlKey: true }); },
    'meta-click': (e) => { e.typeZip(ZIP); e.click(e.anchors[1], { metaKey: true }); },
    'middle click': (e) => { e.typeZip(ZIP); e.click(e.anchors[2], { button: 1 }); },
    'Enter in the hero field': (e) => { e.typeZip(ZIP); e.press(e.zip, 'Enter'); },
    'Enter in the closing field': (e) => { e.typeZip(ZIP, e.zipEnd); e.press(e.zipEnd, 'Enter'); },
    'closing button': (e) => { e.typeZip(ZIP, e.zipEnd); e.click(e.anchors[3]); },
    'typing only': (e) => { e.typeZip(ZIP); },
  };
  for (const [name, f] of Object.entries(paths)) {
    const e = makeEnv(js); f(e);
    const all = outbound(e);
    out.push([name + ': the ZIP is in no URL, link, window.open, cookie, localStorage, fbq, dataLayer, Image, fetch, XHR or beacon', all.every((x) => !x.includes(ZIP)) && !all.some((x) => /zip=/i.test(x))]);
    out.push([name + ': no cookie, localStorage, fbq, dataLayer, network or window.open call at all', e.log.cookies.length + e.log.lstore.length + e.log.fbq.length + e.log.dl.length + e.log.net.length + e.log.opened.length === 0]);
  }
  const c = makeEnv(js); c.typeZip(ZIP); c.click(c.anchors[0], { ctrlKey: true });
  out.push(['ctrl-click: the link href still has no ZIP afterwards and is the plain /start entry', /^\/start\.html\?/.test(c.anchors[0].attrs.href) && !c.anchors[0].attrs.href.includes(ZIP)]);
  return out;
}
t9(JS).forEach(([l, v]) => ok(v, 'T9 ' + l));
const m9 = (o, n) => { const j = JS.replace(o, n); return j !== JS && t9(j).some(([, v]) => !v); };
control('T9 (ZIP appended to the link on a ctrl-click)', m9("stashZip(a.getAttribute('data-hr-go'));\n        return;", "stashZip(a.getAttribute('data-hr-go')); a.setAttribute('href', startUrl() + '&zip=' + zipValue(a.getAttribute('data-hr-go')));\n        return;"));
control('T9 (ZIP opened in a new window on a ctrl-click)', m9("stashZip(a.getAttribute('data-hr-go'));\n        return;", "stashZip(a.getAttribute('data-hr-go')); window.open(startUrl() + '&zip=' + zipValue(a.getAttribute('data-hr-go')));\n        return;"));
control('T9 (ZIP in the URL only on the Enter path)', m9("if (e.key === 'Enter') { e.preventDefault(); go(loc); }", "if (e.key === 'Enter') { e.preventDefault(); window.location.href = startUrl() + '&zip=' + zipValue(loc); }"));
control('T9 (ZIP written to a first-party cookie)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); document.cookie = 'z=' + v;"));
control('T9 (ZIP written to localStorage)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); window.localStorage.setItem('z', v);"));
control('T9 (fbq trackCustom with the ZIP)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); fbq('trackCustom', 'zip', { zip: v });"));
control('T9 (fbq via window.fbq)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); window.fbq('track', 'Lead', { z: v });"));
control('T9 (dataLayer push with the ZIP)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); window.dataLayer.push({ z: v });"));
control('T9 (image pixel, new Image)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); new Image().src = '/p?z=' + v;"));
control('T9 (image pixel, new window.Image)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); new window.Image().src = '/p?z=' + v;"));
control('T9 (fetch with the ZIP)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); fetch('/z?z=' + v);"));
control('T9 (sendBeacon with the ZIP)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); navigator.sendBeacon('/z', v);"));
control('T9 (XMLHttpRequest with the ZIP)', m9('window.sessionStorage.setItem(ZIP_KEY, v);', "window.sessionStorage.setItem(ZIP_KEY, v); var q = new XMLHttpRequest(); q.open('GET', '/z?z=' + v); q.send();"));
control('T9 (event carries the ZIP)', m9("zip_present: /^\\d{5}$/.test(zipValue(loc)) ? 'yes' : 'no' });\n    stashZip(loc);", "zip_present: zipValue(loc) });\n    stashZip(loc);"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
