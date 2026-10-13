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

/* ---------- a tiny DOM, enough to run home-reskin.js for real ---------- */
function makeEnv(js, opts = {}) {
  const log = { nav: [], gtag: [], store: {}, prevented: 0 };
  const mkEl = (attrs = {}) => {
    const el = { value: '', textContent: '', attrs: { ...attrs }, handlers: {}, cls: new Set(),
      addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      classList: { toggle() {}, add(c) { el.cls.add(c); } } };
    return el;
  };
  const zip = mkEl({ id: 'hr-zip' });
  const anchors = ['hero', 'header', 'sticky'].map((k) => mkEl({ 'data-hr-go': k }));
  const byId = { '#hr-zip': zip, '#hr-explain': mkEl(), '#hr-replay': mkEl() };
  const root = mkEl();
  const doc = {
    documentElement: root,
    querySelector: (s) => byId[s] || (/^#hr-(sticky|hero-go)$/.test(s) ? null : (byId[s] = mkEl())),
    querySelectorAll: (s) => (s === '[data-hr-go]' ? anchors : []),
  };
  const storage = opts.blockStorage
    ? { setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); } }
    : { setItem: (k, v) => { log.store[k] = String(v); }, removeItem: (k) => { delete log.store[k]; }, getItem: (k) => log.store[k] };
  const loc = { search: '?utm_source=x&fbclid=abc' };
  Object.defineProperty(loc, 'href', { get() { return 'https://otterquote.com/home-next'; }, set(v) { log.nav.push(v); } });
  const win = { document: doc, location: loc, sessionStorage: storage, matchMedia: () => ({ matches: true }), gtag: (...a) => log.gtag.push(JSON.stringify(a)) };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: doc, URLSearchParams, setTimeout: () => 0, clearTimeout() {}, console });
  vm.runInContext(js, ctx);
  const click = (a, ev = {}) => { const e = { button: 0, preventDefault() { log.prevented++; }, ...ev }; (a.handlers.click || []).forEach((f) => f(e)); };
  const typeZip = (v) => { zip.value = v; (zip.handlers.input || []).forEach((f) => f({})); };
  return { log, zip, anchors, click, typeZip, root };
}

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
  const c = makeEnv(js); c.typeZip('123'); c.click(c.anchors[2]);
  out.push(['incomplete ZIP: nothing stored, key cleared', c.log.store.oq_home_zip === undefined]);
  return out;
}
const t1ok = t1(JS); t1ok.forEach(([l, v]) => ok(v, 'T1 ' + l));
const jsZipInUrl = JS.replace("qs.push('entry=home');", "qs.push('entry=home'); if (arguments.length) { qs.push('zip=' + arguments[0]); }")
  .replace('window.location.href = startUrl();', 'window.location.href = startUrl() + "&zip=" + zipValue();');
control('T1', t1(jsZipInUrl).some(([, v]) => !v));
const jsEventZip = JS.replace("zip_present: /^\\d{5}$/.test(zipValue()) ? 'yes' : 'no' });\n    stashZip();", "zip_present: zipValue() });\n    stashZip();");
control('T1 (event)', jsEventZip !== JS && t1(jsEventZip).some(([, v]) => !v));
const jsThrow = JS.replace('} catch (e) {}   /* storage blocked', '} catch (e) { throw e; }   /* storage blocked');
control('T1 (blocked storage)', jsThrow !== JS && t1(jsThrow).some(([, v]) => !v));

/* ---------- T2 ---------- */
function t2(html, js) {
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  const dyn = [...html.matchAll(/\.src\s*=\s*'([^']+)'/g)].map((m) => m[1]);
  const allowed = new Set(['/js/internal-traffic.js', '/js/home-reskin.js', '/js/ga-gate.js', '/js/meta-pixel-gate.js']);
  const vendor = /googletagmanager|google-analytics|facebook\.net|facebook\.com\/tr|clarity\.ms|fbevents|gtag\/js|hotjar|linkedin|reddit|segment|mixpanel/i;
  return [
    ['every script is one of the four known files', [...srcs, ...dyn].every((s) => allowed.has(s))],
    ['the two gates are the only analytics loaders', dyn.slice().sort().join() === '/js/ga-gate.js,/js/meta-pixel-gate.js'],
    ['no vendor host named in the page or script', !vendor.test(html) && !vendor.test(js)],
    ['the script makes no network call or script/pixel element', !/\b(fetch|XMLHttpRequest|sendBeacon|new Image|createElement)\b/.test(js)],
  ];
}
t2(HTML, JS).forEach(([l, v]) => ok(v, 'T2 ' + l));
control('T2', t2(HTML.replace('</head>', '<script src="https://www.clarity.ms/tag/x"></script></head>'), JS).some(([, v]) => !v));
control('T2 (script)', t2(HTML, JS + "\nfetch('https://x.test/?z=' + zipValue());").some(([, v]) => !v));

/* ---------- T3, T4 ---------- */
const noindex = (html) => /<meta\s+name="robots"\s+content="[^"]*noindex[^"]*"/i.test(html);
const canonicals = (html) => [...html.matchAll(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/gi)].map((m) => m[1]);
const toLive = (h) => { try { const u = new URL(h, 'https://otterquote.com/home-next'); return u.pathname === '/' || u.pathname === '/index.html'; } catch (e) { return true; } };
ok(noindex(HTML), 'T3 page is noindex');
control('T3', !noindex(HTML.replace('content="noindex, follow"', 'content="index, follow"')));
ok(canonicals(HTML).length <= 1 && canonicals(HTML).every((h) => !toLive(h)), 'T4 no canonical to the live homepage (' + (canonicals(HTML)[0] || 'none') + ')');
control('T4', canonicals(HTML.replace(/(rel="canonical" href=")[^"]*/, '$1https://otterquote.com/')).some(toLive));

/* ---------- T5 ---------- */
const own = new Set([...NEW_FILES, 'tests/gh2598-home-next-staging.mjs', '.github/workflows/static-pixel-gate-tests.yml']);
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
function t6(html, js) {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const hashes = [...html.matchAll(/<a[^>]*\shref="#([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  const e = makeEnv(js); e.typeZip(ZIP);
  e.click(e.anchors[0], { ctrlKey: true }); const afterCtrl = e.log.prevented + e.log.nav.length;
  e.click(e.anchors[0], { metaKey: true }); e.click(e.anchors[0], { shiftKey: true }); e.click(e.anchors[0], { button: 1 });
  const plain = makeEnv(js); plain.typeZip(ZIP); plain.click(plain.anchors[0]);
  return [
    ['every #link on the page has a target', hashes.every((h) => ids.has(h))],
    ['hr-js is not added inline (the script adds it)', !/classList\.add\('hr-js'\)/.test(html) && /classList\.add\('hr-js'\)/.test(js)],
    ['modified clicks (ctrl, meta, shift, middle) are not prevented and do not navigate this tab', afterCtrl === 0 && e.log.prevented === 0 && e.log.nav.length === 0],
    ['a plain click is prevented and navigates', plain.log.prevented === 1 && plain.log.nav.length === 1],
  ];
}
t6(HTML, JS).forEach(([l, v]) => ok(v, 'T6 ' + l));
control('T6 (dead link)', t6(HTML.replace('<main>', '<a href="#how">How it works</a><main>'), JS)[0][1] === false);
control('T6 (modified click)', t6(HTML, JS.replace(/if \(e\.metaKey[^\n]*\{/, 'if (false) {'))[2][1] === false);

/* ---------- T7 ---------- */
const lab = (html) => /<div role="rowheader"><span class="hr-full">Public reviews<\/span><span class="hr-short">Reviews<\/span><\/div>/.test(html);
ok(lab(HTML), 'T7 row label: "Public reviews" on desktop, "Reviews" on phones (the two design files)');
control('T7', !lab(HTML.replace('<span class="hr-short">Reviews</span>', '')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
