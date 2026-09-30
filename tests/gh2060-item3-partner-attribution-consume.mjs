/**
 * gh-2060 item 3 (CEO ruling, #2060 comment 5911272482) -- static stack.
 *
 * `oq_referral_source` / `oq_partner_id` are consumed (cookie + localStorage +
 * sessionStorage copies) once the claim write succeeded and the referral /
 * partner id is stamped on the claim. Never cleared on an error or no-op pass.
 * Mirrors the gh-2062 rule for the oq-ref cookie.
 *
 * 1. BEHAVIOUR: the REAL js/cookie-storage.js OtterQuoteReferral
 *    .clearPartnerAttribution() removes all three copies of both keys and
 *    leaves unrelated storage and the oq-ref cookie alone.
 * 2. WIRING: the REAL trade-selector.html claim writer calls it only under
 *    `claimWriteSucceeded`, after the claim write, inside the same try block.
 *
 * The React stack is covered by
 * react-app/app/trade-selector/__tests__/gh2060-stale-session-keys.test.tsx.
 *
 * Override ROOT=<dir holding js/ and trade-selector.html> for the negative
 * control. Run: node tests/gh2060-item3-partner-attribution-consume.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT || path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`✓ PASS: ${name}`); }
  catch (e) { failures += 1; console.log(`✗ FAIL: ${name}\n  ${e.message}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

function makeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}
function makeCookieJar() {
  const jar = new Map();
  return {
    get cookie() { return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(str) {
      const first = str.split(';')[0]; const i = first.indexOf('=');
      const m = /;\s*Max-Age=(-?\d+)/i.exec(str);
      if (m && Number(m[1]) <= 0) jar.delete(first.substring(0, i)); else jar.set(first.substring(0, i), first.substring(i + 1));
    },
  };
}
function sandbox() {
  const doc = makeCookieJar();
  const sb = { window: { location: { hostname: 'otterquote.com', protocol: 'https:' }, localStorage: makeStorage(), sessionStorage: makeStorage(), document: doc }, document: doc, console };
  vm.createContext(sb);
  vm.runInContext(read('js/cookie-storage.js'), sb, { filename: 'js/cookie-storage.js' });
  return sb;
}

check('OtterQuoteReferral.clearPartnerAttribution clears cookie + localStorage + sessionStorage copies of both keys', () => {
  const sb = sandbox();
  const R = sb.window.OtterQuoteReferral;
  ok(typeof R.clearPartnerAttribution === 'function', 'clearPartnerAttribution is not defined');
  for (const k of ['oq_referral_source', 'oq_partner_id']) {
    sb.window.localStorage.setItem(k, 'x'); sb.window.sessionStorage.setItem(k, 'x'); sb.document.cookie = `${k}=x; Path=/`;
  }
  sb.window.localStorage.setItem('unrelated', 'keep');
  sb.document.cookie = 'unrelated=keep; Path=/';
  R.write({ oq_referral_id: 'r1', oq_referral_code: 'P1' }, { click: true });
  R.clearPartnerAttribution();
  for (const k of ['oq_referral_source', 'oq_partner_id']) {
    ok(sb.window.localStorage.getItem(k) === null, `${k} still in localStorage`);
    ok(sb.window.sessionStorage.getItem(k) === null, `${k} still in sessionStorage`);
    ok(!sb.document.cookie.includes(`${k}=`), `${k} cookie still present`);
  }
  ok(sb.window.localStorage.getItem('unrelated') === 'keep', 'unrelated localStorage key was removed');
  ok(sb.document.cookie.includes('unrelated=keep'), 'unrelated cookie was removed');
  ok(R.read().oq_referral_id === 'r1', 'oq-ref referral id was consumed by the partner-attribution clear (it is gh-2062\'s job)');
});

check('trade-selector.html: partner-attribution keys are cleared only after a successful claim write', () => {
  const src = read('trade-selector.html');
  const call = src.indexOf('clearPartnerAttribution()');
  ok(call !== -1, 'trade-selector.html never calls clearPartnerAttribution()');
  // The guard directly above the call must require claimWriteSucceeded and this pass's keys.
  const outer = src.lastIndexOf('if ((referralSource || partnerIdParam)', call);
  ok(outer !== -1, 'clear is not guarded by (referralSource || partnerIdParam)');
  const outerGuard = src.slice(outer, src.indexOf('{', outer));
  ok(/claimWriteSucceeded/.test(outerGuard), `guard does not require claimWriteSucceeded: ${outerGuard}`);
  // Must come after the last claimWriteSucceeded assignment (the write), so an early/unconditional pass cannot precede it.
  const lastAssign = Math.max(src.lastIndexOf('claimWriteSucceeded = !insertError'), src.lastIndexOf('claimWriteSucceeded = !updateError'));
  ok(lastAssign !== -1 && lastAssign < call, 'clear is not after the claim write result');
  // No other clear of the two keys outside the guard (unconditional removeItem would consume on error passes).
  const stray = [...src.matchAll(/(?:sessionStorage|localStorage)\.removeItem\(\s*['"](oq_referral_source|oq_partner_id)['"]\s*\)/g)]
    .filter((m) => m.index < outer || m.index > outer + 900);
  ok(stray.length === 0, `unguarded removeItem of a partner-attribution key at offset ${stray[0] && stray[0].index}`);
});

console.log(failures ? `\n${failures} failed.` : '\nall passed.');
process.exit(failures ? 1 : 0);
