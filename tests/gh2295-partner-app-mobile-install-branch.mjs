/**
 * gh-2295 (k74-w-2295) — regression test for partner-app.html's mobile
 * install branch.
 *
 * Problem: after partner signup, partner-app.html ("Get the Partner App",
 * the page ins-1.html's success screen links to) showed a desktop-oriented
 * QR block ("On your computer? Scan to open on your phone.") to every
 * visitor, including a partner who is already on their phone -- the common
 * case for this funnel, per the INS-1.S23 real-device Facebook in-app-
 * browser walk (issue #2151 closing comment 5873509007). Fix: detect
 * mobile via UA/viewport and swap in a direct install button instead;
 * desktop is untouched.
 *
 * Same structure as tests/gh2068-partner-re-html-oq-internal-header.mjs:
 *   1. Behavioral: the ACTUAL isMobileDevice / detectMobileOs /
 *      isInAppBrowser / applyMobileInstallBranch functions -- extracted
 *      verbatim out of partner-app.html by brace-matching on their own
 *      `function <name>(` anchors, not reimplemented -- loaded into a
 *      Node `vm` context and exercised against a fake DOM/UA.
 *   2. Static, source-level: the mobile CTA markup exists, starts hidden
 *      (fail-closed so a JS-off visitor still sees the original desktop
 *      page), and applyMobileInstallBranch() is actually called from
 *      init (not just defined and orphaned).
 *
 * Coverage: iOS UA, Android UA, desktop UA (negative control -- CTA must
 * stay hidden, QR block must stay visible), narrow-viewport fallback for
 * an unidentified mobile UA, and the Facebook-in-app-browser hint.
 *
 * Run: node tests/gh2295-partner-app-mobile-install-branch.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(repoRoot, 'partner-app.html'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

function extractFunction(src, name, fromIndex) {
  const anchor = `function ${name}(`;
  const start = src.indexOf(anchor, fromIndex || 0);
  if (start === -1) throw new Error(`${name}(...) not found in partner-app.html`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`${name}(...): no matching closing brace found`);
  return { code: src.slice(start, i + 1), end: i + 1 };
}

// ─── Part 1: behavioral, extracted functions ─────────────────────────────

const f1 = extractFunction(pageSrc, 'isMobileDevice');
const f2 = extractFunction(pageSrc, 'detectMobileOs', f1.end);
const f3 = extractFunction(pageSrc, 'isInAppBrowser', f2.end);
const f4 = extractFunction(pageSrc, 'applyMobileInstallBranch', f3.end);
const combinedSrc = [f1.code, f2.code, f3.code, f4.code].join('\n');

function makeEl() {
  return { style: {}, textContent: '', href: '' };
}

function runScenario({ ua, matchesNarrowViewport, maxTouchPoints, gaEvents }) {
  const els = {
    '.qr-block': makeEl(),
    mobileInstallCta: makeEl(),
    mobileInstallBlock: makeEl(),
    mobileInstallHint: makeEl(),
  };
  const sandbox = {
    navigator: { userAgent: ua || '', maxTouchPoints: maxTouchPoints || 0 },
    window: {
      matchMedia: function () { return { matches: !!matchesNarrowViewport }; },
    },
    document: {
      querySelector: function (sel) { return els[sel] || null; },
      getElementById: function (id) { return els[id] || null; },
    },
    gaEvent: function (name, params) { (gaEvents || []).push({ name: name, params: params }); },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    combinedSrc + '\nthis.__applyMobileInstallBranch = applyMobileInstallBranch;',
    sandbox,
    { filename: 'partner-app.html (extracted)' }
  );
  sandbox.__applyMobileInstallBranch();
  return els;
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const IOS_FB_IAB_UA = IOS_UA + ' [FBAN/FBIOS;FBAV/500.0]';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const ANDROID_FB_IAB_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36 [FB_IAB/FB4A]';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
// Since iPadOS 13, iPad Safari sends this Mac-shaped UA by default (desktop
// mode). A real Mac sends the same UA but reports maxTouchPoints === 0 --
// that's the discriminator (REVIEW: FAIL 5874476509, must-fix 2).
const IPADOS_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

// 1. iOS Safari -> CTA revealed, points at the iOS walkthrough, QR block hidden.
{
  const els = runScenario({ ua: IOS_UA });
  ok(els.mobileInstallBlock.style.display === 'block', 'iOS: mobileInstallBlock revealed');
  ok(els.mobileInstallCta.href === '/partner-app-install-ios.html', 'iOS: CTA points at partner-app-install-ios.html');
  ok(els['.qr-block'].style.display === 'none', 'iOS: desktop qr-block hidden');
  ok(els.mobileInstallHint.style.display !== 'block', 'iOS regular Safari: no in-app-browser hint');
}

// 2. Android Chrome -> CTA revealed, points at the Android walkthrough.
{
  const els = runScenario({ ua: ANDROID_UA });
  ok(els.mobileInstallBlock.style.display === 'block', 'Android: mobileInstallBlock revealed');
  ok(els.mobileInstallCta.href === '/partner-app-install-android.html', 'Android: CTA points at partner-app-install-android.html');
  ok(els['.qr-block'].style.display === 'none', 'Android: desktop qr-block hidden');
}

// 3. Negative control: desktop UA, no narrow viewport -> nothing touched.
{
  const els = runScenario({ ua: DESKTOP_UA, matchesNarrowViewport: false });
  ok(els.mobileInstallBlock.style.display === undefined, 'negative control (desktop): mobileInstallBlock never revealed');
  ok(els.mobileInstallCta.href === '', 'negative control (desktop): CTA href never set');
  ok(els['.qr-block'].style.display === undefined, 'negative control (desktop): qr-block never hidden');
}

// 4. Facebook in-app browser on iOS -> hint shown + gaEvent fired.
{
  const events = [];
  const els = runScenario({ ua: IOS_FB_IAB_UA, gaEvents: events });
  ok(els.mobileInstallHint.style.display === 'block', 'iOS FB IAB: hint revealed');
  ok(/Safari/.test(els.mobileInstallHint.textContent), 'iOS FB IAB: hint mentions Safari');
  ok(events.some(function (e) { return e.name === 'partner_app_install_inapp'; }), 'iOS FB IAB: gaEvent fired');
}

// 5. Android in-app WebView -> hint shown, mentions the external-browser escape hatch.
{
  const els = runScenario({ ua: ANDROID_FB_IAB_UA });
  ok(els.mobileInstallHint.style.display === 'block', 'Android FB IAB: hint revealed');
  ok(/Chrome/.test(els.mobileInstallHint.textContent) && !/Safari/.test(els.mobileInstallHint.textContent), 'Android FB IAB: hint says Open in Chrome, never Safari');
}

// 6b. iPadOS in default desktop mode (Mac-shaped UA + multi-touch) -> must
//     be treated as iOS: CTA revealed, points at the iOS walkthrough, QR
//     block hidden. (REVIEW: FAIL 5874476509, must-fix 2.)
{
  const els = runScenario({ ua: IPADOS_DESKTOP_UA, maxTouchPoints: 5 });
  ok(els.mobileInstallBlock.style.display === 'block', 'iPadOS desktop-mode UA: mobileInstallBlock revealed');
  ok(els.mobileInstallCta.href === '/partner-app-install-ios.html', 'iPadOS desktop-mode UA: CTA points at partner-app-install-ios.html');
  ok(els['.qr-block'].style.display === 'none', 'iPadOS desktop-mode UA: desktop qr-block hidden');
}

// 6c. Negative control: a REAL Mac sends the identical UA but
//     maxTouchPoints === 0 -- must stay untouched, same as scenario 3.
{
  const els = runScenario({ ua: IPADOS_DESKTOP_UA, maxTouchPoints: 0, matchesNarrowViewport: false });
  ok(els.mobileInstallBlock.style.display === undefined, 'real Mac (maxTouchPoints=0): mobileInstallBlock never revealed');
  ok(els.mobileInstallCta.href === '', 'real Mac (maxTouchPoints=0): CTA href never set');
  ok(els['.qr-block'].style.display === undefined, 'real Mac (maxTouchPoints=0): qr-block never hidden');
}

// 6. Narrow-viewport fallback for a UA that doesn't self-identify, but no
//    identifiable OS -> viewport alone is not enough to pick an install
//    page, so the branch must no-op (installHref stays null).
{
  const els = runScenario({ ua: 'Mozilla/5.0 (compatible)', matchesNarrowViewport: true });
  ok(els.mobileInstallBlock.style.display === undefined, 'unidentified narrow UA: no install page to link, branch no-ops');
}

// ─── Part 2: static, source-level wiring checks ──────────────────────────

ok(/id="mobileInstallBlock"[^>]*style="display:none;"/.test(pageSrc),
  'source: #mobileInstallBlock starts hidden (fail closed for JS-off visitors)');
ok(/id="mobileInstallCta"/.test(pageSrc),
  'source: #mobileInstallCta exists');
ok(/applyMobileInstallBranch\(\);/.test(pageSrc),
  'source: applyMobileInstallBranch() is actually called, not just defined');
// The call site must come from inside init, after the isStandalone() early
// return -- an already-installed standalone launch redirects to the
// dashboard above and must never reach this branch.
const standaloneReturnIdx = pageSrc.indexOf("window.location.replace('/partner-dashboard.html?source=pwa');");
const callIdx = pageSrc.indexOf('applyMobileInstallBranch();');
ok(standaloneReturnIdx !== -1 && callIdx > standaloneReturnIdx,
  'source: applyMobileInstallBranch() is called after the standalone-launch early return');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
