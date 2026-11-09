// gh-3357 items 1 and 2 in a real browser, with the real vendored HeyCatch SDK 0.8.3 and the real privacy module.
// Nothing leaves the machine: the pages are served from a made-up host through Playwright routing, and every
// request to any other host (in.heycatch.ai included) is answered locally and recorded. No production page,
// no real visitor, no HeyCatch account is touched.
//
//   Item 1 (privacy), app shape: the SDK starts on /get-started and stays loaded while the visitor moves
//     client-side to /dashboard and /contractor/bid/<claimId> and back. What reaches the network must not
//     name a denied route: not in a referrer, not in $prev_pageview_pathname, not in a session-entry property.
//   Item 1, site shape: a full page load of /faq from /contract-signing.html?claim_id=... on the same origin.
//     document.referrer then carries the full signed-in URL; what is sent must be the origin only.
//   Item 2 (security): a crafted #__posthog= link (base64 {action:"ph_authorize", token}) and a planted
//     localStorage._postHogToolbarParams must not make the SDK request in.heycatch.ai/static/toolbar.js.
// NEGATIVE CONTROLS: the same scenarios without the protections (no pathAllowed in the app shape; no
// hideToolbarTrigger) must show the leak / the toolbar request, so a green run is not a blind run.
//
// Needs Playwright + Chromium (tests/e2e lockfile in CI). Run: node tests/gh3357-heycatch-browser.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
let chromium;
try { ({ chromium } = createRequire(path.join(here, 'e2e', 'package.json'))('playwright')); }
catch { try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright')); } }

let failed = 0;
const check = (name, ok, detail) => { if (ok) console.log('ok   ' + name); else { failed++; console.log('FAIL ' + name + (detail ? '\n     ' + String(detail).slice(0, 600) : '')); } };

const SDK = fs.readFileSync(path.join(ROOT, 'js/vendor/heycatch-sdk-0.8.3.js'), 'utf8');
const PRIV = fs.readFileSync(path.join(ROOT, 'js/heycatch-privacy.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'react-app/app/lib/heycatch.ts'), 'utf8');
// The app's own allowlist, read from react-app/app/lib/heycatch.ts so the test follows it.
const APP_ALLOWED = JSON.parse(/HEYCATCH_ALLOWED_PATHS\s*=\s*(\[[^\]]*\])/.exec(APP_SRC)[1].replace(/'/g, '"'));
const HOST = 'oq3357.test';
const TOKEN = /ii="(phc_[^"]+)"/.exec(SDK)[1];   // the public ingest token the SDK compares the toolbar token with
const CRAFTED = encodeURIComponent(Buffer.from(JSON.stringify({ action: 'ph_authorize', token: TOKEN })).toString('base64'));
// Headless Chromium is a bot to the SDK (HeadlessChrome UA / brands, navigator.webdriver) and nothing is captured; look like a desktop browser.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// mode: 'app' (pathAllowed = the app allowlist, gate on the current route), 'app-unguarded' (route gate only, no scrubbing: what the SDK itself emits),
// 'site' (makeBeforeSend() as js/heycatch-boot.js calls it), and noGuard to skip hideToolbarTrigger (item 2 control).
const sdkPage = (o) => `<!doctype html><html><head><title>t</title></head><body><a id="next" href="/faq">next</a><script type="module">
import { makeBeforeSend, hideToolbarTrigger } from '/js/heycatch-privacy.js';
const ALLOWED = ${JSON.stringify(APP_ALLOWED)};
const allowed = (p) => typeof p === 'string' && ALLOWED.some((a) => p === a || p.startsWith(a + '/'));
const o = ${JSON.stringify(o)};
const guard = o.noGuard ? { restore() {} } : hideToolbarTrigger();
if (guard) {
  const sdk = await import('/js/vendor/heycatch-sdk-0.8.3.js');
  const bs = o.mode === 'app' ? makeBeforeSend(() => allowed(location.pathname), allowed) : o.mode === 'app-unguarded' ? ((e) => (allowed(location.pathname) ? e : null)) : makeBeforeSend();
  sdk.analytics.init({ projectKey: 'hck_pk_EDCHqNmpbCRmDWZD6PCDsAEczZa0eWr6', requestBatching: false, install: { framework: 'web', agent: 'claude-code' }, beforeSend: bs });
  guard.restore();
}
window.__ready = true;
</script></body></html>`;
const plainPage = '<!doctype html><html><head><title>signed in</title></head><body><a id="next" href="/faq">public page</a></body></html>';

const browser = await chromium.launch();
async function scenario(o, url, act) {
  const ctx = await browser.newContext({ userAgent: UA });
  await ctx.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
  });
  if (o.storedParams) await ctx.addInitScript((t) => { try { localStorage.setItem('_postHogToolbarParams', JSON.stringify({ token: t })); } catch (e) { /* none */ } }, TOKEN);
  const hits = [];
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.host === HOST) {
      if (u.pathname === '/js/vendor/heycatch-sdk-0.8.3.js') return r.fulfill({ contentType: 'text/javascript', body: SDK });
      if (u.pathname === '/js/heycatch-privacy.js') return r.fulfill({ contentType: 'text/javascript', body: PRIV });
      if (o.plain && o.plain.includes(u.pathname)) return r.fulfill({ contentType: 'text/html', body: plainPage });
      return r.fulfill({ contentType: 'text/html', body: sdkPage(o) });
    }
    hits.push({ url: u.href, body: r.request().postData() || '' });
    if (/\/static\/toolbar/.test(u.pathname)) return r.fulfill({ contentType: 'text/javascript', body: 'window.__toolbarRan = true;' });
    return r.fulfill({ contentType: 'application/json', body: '{"status":1}' });
  });
  const pg = await ctx.newPage();
  await pg.goto(url);
  if (act) await act(pg);
  await pg.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await pg.waitForTimeout(1200);
  if (o.moves) for (const m of o.moves) { await pg.evaluate((p) => history.pushState({}, '', p), m); await pg.waitForTimeout(500); }
  await pg.waitForTimeout(1500);
  const toolbarRan = await pg.evaluate(() => window.__toolbarRan === true);
  await ctx.close();
  const events = hits.filter((h) => /\/e\/?$/.test(new URL(h.url).pathname) && h.body).map((h) => h.body);
  return { hits, events, sent: events.join('\n'), toolbarRequested: hits.some((h) => /\/static\/toolbar/.test(h.url)), toolbarRan };
}

const DENIED = /CLAIM[A-Z]+\d+|\/contractor|\/dashboard|\/bids|\/contract-signing|claim_id/;
const MOVES = ['/dashboard', '/contractor/bid/CLAIMPATH777', '/get-started'];

// Item 1, app shape
const app = await scenario({ mode: 'app', moves: MOVES }, `https://${HOST}/get-started`);
check('item 1 app: the SDK sent events (the scenario really captured)', app.events.length >= 2 && /"\$pageview"/.test(app.sent), app.events.length);
check('item 1 app: no denied route or claim id reaches HeyCatch after /dashboard and /contractor/bid/<id>', !DENIED.test(app.sent), (app.sent.match(/"[^"]*(CLAIMPATH777|\/contractor|\/dashboard)[^"]*"/g) || []).join(' '));
const appCtl = await scenario({ mode: 'app-unguarded', moves: MOVES }, `https://${HOST}/get-started`);
check('item 1 app NEGATIVE CONTROL: with the route gate alone the SDK sends the claim path ($prev_pageview_pathname)', /"\$prev_pageview_pathname":"\/contractor\/bid\/CLAIMPATH777"/.test(appCtl.sent));

// Item 1, site shape: full load of a public page from a signed-in page on the same origin
const signed = `/contract-signing.html`;
const site = await scenario({ mode: 'site', plain: [signed] }, `https://${HOST}${signed}?claim_id=CLAIMREF999&bid=7`, async (pg) => { await Promise.all([pg.waitForNavigation(), pg.click('#next')]); });
check('item 1 site: the SDK sent events', site.events.length >= 1, site.events.length);
check('item 1 site: the referrer is the origin only, no path or claim id', !DENIED.test(site.sent) && site.sent.includes(`"$referrer":"https://${HOST}"`), (site.sent.match(/"\$[a-z_]*referrer":"[^"]*"/g) || []).join(' '));

// Item 2: crafted link and stored params
const tb = await scenario({ mode: 'site' }, `https://${HOST}/faq#__posthog=${CRAFTED}`);
check('item 2: a crafted #__posthog= link does not request the toolbar script', !tb.toolbarRequested && !tb.toolbarRan, tb.hits.map((h) => h.url).join(' '));
const tbState = await scenario({ mode: 'site' }, `https://${HOST}/faq#state=${CRAFTED}`);
check('item 2: a crafted #state= link does not request the toolbar script', !tbState.toolbarRequested && !tbState.toolbarRan);
const tbStored = await scenario({ mode: 'site', storedParams: true }, `https://${HOST}/faq`);
check('item 2: planted localStorage._postHogToolbarParams does not request the toolbar script', !tbStored.toolbarRequested && !tbStored.toolbarRan);
const tbApp = await scenario({ mode: 'app' }, `https://${HOST}/get-started#__posthog=${CRAFTED}`);
check('item 2 app shape: a crafted #__posthog= link does not request the toolbar script', !tbApp.toolbarRequested && !tbApp.toolbarRan);
const tbCtl = await scenario({ mode: 'site', noGuard: true }, `https://${HOST}/faq#__posthog=${CRAFTED}`);
check('item 2 NEGATIVE CONTROL: without hideToolbarTrigger the crafted link loads in.heycatch.ai/static/toolbar.js', tbCtl.toolbarRequested && tbCtl.toolbarRan, tbCtl.hits.map((h) => h.url).join(' '));

await browser.close();
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall gh3357 HeyCatch browser checks passed');
