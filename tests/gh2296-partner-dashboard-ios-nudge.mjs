/**
 * gh-2296 residual (CTO RUN 48 ruling) -- partner-dashboard.html one-time iOS
 * "Open as Web App" nudge, and send-partner-onboarding/copy.ts iOS 26 steps.
 * Runs the real nudge function extracted from the page source in a stubbed
 * DOM, plus static copy checks with a negative control.
 * Run: node tests/gh2296-partner-dashboard-ios-nudge.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'partner-dashboard.html'), 'utf8');
const copy = fs.readFileSync(path.join(root, 'supabase/functions/send-partner-onboarding/copy.ts'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, l) => { console.log((c ? 'PASS: ' : 'FAIL: ') + l); c ? pass++ : fail++; };

function between(src, start, end) {
  const i = src.indexOf(start); const j = src.indexOf(end, i);
  return i === -1 || j === -1 ? '' : src.slice(i, j);
}
// Real code under test: the nudge block from the page.
function nudgeSrc(page) {
  return between(page, "function isIos()", "window.addEventListener('beforeinstallprompt'");
}
function run({ page = html, ua, platform = 'iPhone', touch = 5, standalone = false, userId = 'u1', store = {} }) {
  const el = { style: { display: 'none' }, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
  const dismissBtn = { listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
  const ctx = {
    window: { navigator: { userAgent: ua, platform, maxTouchPoints: touch, standalone: false },
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } } },
    document: { getElementById: id => id === 'iosOpenAsWebAppNudge' ? el : id === 'iosOpenAsWebAppNudgeDismiss' ? dismissBtn : null },
    isStandaloneLaunch: () => standalone,
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(nudgeSrc(page) + '\nthis.refresh = refreshIosOpenAsWebAppNudge;', ctx);
  ctx.refresh(userId);
  return { el, dismissBtn, ctx, store };
}
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15';

ok(nudgeSrc(html).length > 200, 'source: nudge block found in partner-dashboard.html');
ok(html.includes('Added it to your Home Screen but it opens in Safari? Re-add it and turn on <strong>Open as Web App</strong>.'), 'copy: ruling text present');
ok(run({ ua: IOS }).el.style.display === 'flex', 'iOS + signed in + not standalone: shown');
ok(run({ ua: IOS, standalone: true }).el.style.display === 'none', 'iOS standalone launch: hidden');
ok(run({ ua: IOS, userId: null }).el.style.display === 'none', 'signed out: hidden');
ok(run({ ua: ANDROID, platform: 'Linux armv8l', touch: 5 }).el.style.display === 'none', 'Android: hidden');
ok(run({ ua: DESKTOP, platform: 'MacIntel', touch: 0 }).el.style.display === 'none', 'desktop Mac: hidden');
ok(run({ ua: DESKTOP, platform: 'MacIntel', touch: 5 }).el.style.display === 'flex', 'iPadOS desktop-UA (MacIntel + touch): shown');
{
  const r = run({ ua: IOS });
  r.dismissBtn.listeners.click();
  ok(r.el.style.display === 'none' && r.store['oq_ios_open_as_web_app_nudge_dismissed_u1'] === '1', 'dismiss: hides and writes localStorage');
  ok(run({ ua: IOS, store: r.store }).el.style.display === 'none', 'dismissal remembered on next load');
  ok(run({ ua: IOS, store: r.store, userId: 'u2' }).el.style.display === 'flex', 'dismissal is per user id');
}
ok(/function isStandaloneLaunch\(\) \{\s*return window\.matchMedia\('\(display-mode: standalone\)'\)\.matches \|\|\s*window\.navigator\.standalone === true;\s*\}/.test(html), 'isStandaloneLaunch() unchanged');
ok(/currentPartner && isStandaloneLaunch\(\) && !currentPartner\.app_first_signed_in_launch_at/.test(html), 'activation write gate unchanged');

// Negative control: a broken variant that ignores standalone must be caught.
const broken = html.replace('!isStandaloneLaunch() && ', '');
ok(broken !== html && run({ page: broken, ua: IOS, standalone: true }).el.style.display === 'flex', 'negative control: variant without the standalone gate shows in standalone (test detects it)');

// copy.ts
ok(!/tap the Share icon and choose \*\*Add to Home Screen\*\*/.test(copy), 'copy.ts: pre-iOS-26 day0/1/3 "Share icon" steps gone');
ok(!/Share icon → Add to Home Screen/.test(copy), 'copy.ts: pre-iOS-26 short form gone');
ok((copy.match(/Open as Web App/g) || []).length === 6, 'copy.ts: Open as Web App in all 6 places');
ok((copy.match(/Android: tap "Install app" when prompted\./g) || []).length === 3, 'copy.ts: Android steps intact x3');
const oldCopy = copy.replace(/the ••• button in the address bar, then \*\*Share\*\* → \*\*Add to Home Screen\*\*, and make sure \*\*Open as Web App\*\* is turned on\./g, 'the Share icon and choose **Add to Home Screen**.');
ok(/tap the Share icon and choose \*\*Add to Home Screen\*\*/.test(oldCopy), 'negative control: reverted copy trips the stale-steps check');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
