/**
 * Regression test for gh-2062 — js/cookie-storage.js OtterQuoteReferral.
 *
 * The `oq-ref` cookie (+ its localStorage/sessionStorage mirrors) was
 * refreshed unconditionally on every advance pass with a 90-day TTL and
 * never cleared after a claim consumed it (js/auth.js:1295,
 * trade-selector.html's claim writer). A referral id could therefore sit in
 * a browser for up to 90 days and misattribute commission to the wrong
 * partner on a later, unrelated signup — this is the money-path.
 *
 * This test loads the REAL js/cookie-storage.js source into a minimal vm
 * context (mirroring tests/cookie-max-age-400-days.mjs) with a working
 * document.cookie jar + localStorage/sessionStorage, and exercises the real
 * OtterQuoteReferral.write/read/clear functions the gh-2062 fix now wires
 * into the claim writers on both surfaces (js/auth.js keep-alive write is
 * now conditional on !advanceError; trade-selector.html now calls .clear()
 * once a claim has consumed the id).
 *
 * Both directions are proven, per the issue's mandatory negative control:
 *   1. POSITIVE: a live, unconsumed referral still round-trips correctly.
 *   2. gh-2062 FIX: once .clear() runs (simulating the claim writer having
 *      consumed the id), it does not resurface — read() comes back empty
 *      and the cookie is gone, even though its Max-Age would otherwise
 *      still have ~90 days left on it.
 *
 * Run: node tests/gh2062-referral-cookie-clear.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'cookie-storage.js'), 'utf8');

// --- minimal browser storage fakes -----------------------------------------

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** A real-enough document.cookie jar: setting a key merges/replaces it,
 *  Max-Age=0 removes it, and the getter returns "k1=v1; k2=v2" like a real
 *  browser — the exact shape readCookie()/writeCookie() in the source under
 *  test assume. */
function makeCookieJar() {
  const jar = new Map();
  return {
    get cookie() {
      return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(setString) {
      const firstPair = setString.split(';')[0];
      const eqIdx = firstPair.indexOf('=');
      const key = firstPair.substring(0, eqIdx);
      const value = firstPair.substring(eqIdx + 1);
      const maxAgeMatch = /;\s*Max-Age=(-?\d+)/i.exec(setString);
      const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : null;
      if (maxAge !== null && maxAge <= 0) {
        jar.delete(key);
      } else {
        jar.set(key, value);
      }
    },
  };
}

function freshSandbox() {
  const documentObj = makeCookieJar();
  const sandbox = {
    window: {
      location: { hostname: 'otterquote.com', protocol: 'https:' },
      localStorage: makeStorage(),
      sessionStorage: makeStorage(),
    },
    console,
  };
  sandbox.window.document = documentObj;
  sandbox.document = documentObj;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'js/cookie-storage.js' });
  return sandbox;
}

function assert(cond, label) {
  if (!cond) {
    console.log(`✗ FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`✓ PASS: ${label}`);
}

function main() {
  const PARTNER_A = {
    oq_referral_id: 'referral-aaa-111',
    oq_referral_agent_id: 'agent-aaa-111',
    oq_referral_code: 'PARTNERA',
  };

  // ── 1. POSITIVE CONTROL: a live, unconsumed referral still attributes ──
  {
    const sandbox = freshSandbox();
    const Referral = sandbox.window.OtterQuoteReferral;
    assert(typeof Referral === 'object', 'window.OtterQuoteReferral is defined');

    Referral.write(PARTNER_A);
    const read1 = Referral.read();
    assert(read1.oq_referral_id === PARTNER_A.oq_referral_id, 'live referral: oq_referral_id round-trips');
    assert(read1.oq_referral_agent_id === PARTNER_A.oq_referral_agent_id, 'live referral: oq_referral_agent_id round-trips');
    assert(read1.oq_referral_code === PARTNER_A.oq_referral_code, 'live referral: oq_referral_code round-trips');
    assert(sandbox.document.cookie.indexOf('oq-ref=') !== -1, 'live referral: oq-ref cookie is present');

    // A second, unrelated read (e.g. a later page in the same session
    // before any claim writer runs) must still see the same attribution —
    // reading must never itself consume anything.
    const read2 = Referral.read();
    assert(read2.oq_referral_id === PARTNER_A.oq_referral_id, 'live referral: still attributes on a second read (read is non-destructive)');
  }

  // ── 2. gh-2062 FIX: a CONSUMED referral is cleared and does not resurface ──
  {
    const sandbox = freshSandbox();
    const Referral = sandbox.window.OtterQuoteReferral;

    Referral.write(PARTNER_A);
    assert(Referral.read().oq_referral_id === PARTNER_A.oq_referral_id, 'consumed-case setup: referral was live before the claim');

    // Simulates the claim writer (trade-selector.html) having just stamped
    // claims.referral_id and calling window.OtterQuoteReferral.clear().
    Referral.clear();

    const afterClear = Referral.read();
    assert(afterClear.oq_referral_id === undefined, 'consumed referral: oq_referral_id does NOT resurface after clear()');
    assert(afterClear.oq_referral_agent_id === undefined, 'consumed referral: oq_referral_agent_id does NOT resurface after clear()');
    assert(afterClear.oq_referral_code === undefined, 'consumed referral: oq_referral_code does NOT resurface after clear()');
    assert(sandbox.document.cookie.indexOf('oq-ref=') === -1, 'consumed referral: oq-ref cookie is gone, not merely re-armed with a fresh 90-day TTL');
    assert(sandbox.window.localStorage.getItem('oq_referral_id') === null, 'consumed referral: localStorage mirror cleared');
    assert(sandbox.window.sessionStorage.getItem('oq_referral_id') === null, 'consumed referral: sessionStorage mirror cleared');

    // A later, unrelated visit on the same browser (a fresh read with
    // nothing re-written) must see no attribution at all — this is the
    // exact "reused browser, different person, up to 90 days later"
    // scenario the issue describes.
    const laterVisit = Referral.read();
    assert(Object.keys(laterVisit).length === 0, 'later unrelated visit: no stale attribution resurfaces');
  }

  console.log('✓ PASS: gh-2062 — both directions proven (live referral still attributes; consumed referral does not resurface).');
  process.exit(0);
}

main();
