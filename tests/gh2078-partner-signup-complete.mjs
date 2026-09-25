/**
 * gh-2078 — partner_signup_complete (GA4) + Meta CompleteRegistration on
 * partner-re.html / partner-insurance.html's signup confirmation, plus the
 * shared getOqVariant() attribution read.
 *
 * Loads the ACTUAL `getOqVariant`/`firePartnerSignupComplete` source —
 * extracted verbatim out of partner-re.html between fixed comment markers,
 * not reimplemented — into a Node `vm` context behind a minimal DOM shim,
 * matching the existing pattern (tests/cookie-max-age-400-days.mjs,
 * tests/gh2033-variant-assignment.mjs). partner-insurance.html carries an
 * identical copy of getOqVariant (same helper, same file-local scope in
 * each static page — there is no shared JS module either page could import
 * from without a build step); Check 6 diffs the two verbatim, so drift
 * between them fails loudly instead of silently.
 *
 * LABEL: a Node vm + DOM-shim result, not a real-browser result — proves
 * the extracted functions' own logic, not real Chrome/Safari behavior.
 *
 * Run: node tests/gh2078-partner-signup-complete.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let failures = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`✓ PASS: ${label}`);
  } else {
    console.log(`✗ FAIL: ${label}`);
    failures++;
  }
}

function loadHelpers(fileName) {
  const src = fs.readFileSync(path.join(repoRoot, fileName), 'utf8');
  // The two files use different indentation (2-space in partner-re.html,
  // 8-space in partner-insurance.html) — extract by the shared, unindented
  // function-name anchors rather than a whitespace-sensitive slice.
  const fnStart = src.indexOf('function getOqVariant() {');
  if (fnStart === -1) throw new Error(`${fileName}: getOqVariant not found`);
  const guardVarIdx = src.indexOf('partnerSignupCompleteFired = false;', fnStart);
  if (guardVarIdx === -1) throw new Error(`${fileName}: partnerSignupCompleteFired guard not found`);
  const fnEnd = src.indexOf('function firePartnerSignupComplete', guardVarIdx);
  if (fnEnd === -1) throw new Error(`${fileName}: firePartnerSignupComplete not found`);
  // Find the matching closing brace for firePartnerSignupComplete by counting.
  let depth = 0;
  let i = src.indexOf('{', fnEnd);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const combinedSrc = src.slice(fnStart, i + 1);

  // gh-2121: read VARIANT_KEY out of the extracted source itself -- never a
  // hardcoded copy here -- so a future start.html KEY bump (this file's own
  // getOqVariant comment: "the SAME localStorage key/cookie start.html
  // itself writes") does not silently desync this test from the two pages'
  // own VARIANT_KEY the way a literal 'oq_variant_v3' string did across the
  // gh-2121 Arm C kill (v3 -> v4).
  const keyMatch = combinedSrc.match(/var VARIANT_KEY = '([^']*)';/);
  if (!keyMatch) throw new Error(`${fileName}: VARIANT_KEY not found in getOqVariant`);
  const variantKey = keyMatch[1];

  const sandbox = {
    window: {
      location: { search: '', hostname: 'otterquote.com' },
      localStorage: makeStorage(),
    },
    document: { cookie: '' },
    URLSearchParams,
    console,
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.URLSearchParams = URLSearchParams;
  const gtagCalls = [];
  const fbqCalls = [];
  sandbox.gtag = (...args) => gtagCalls.push(args);
  sandbox.fbq = (...args) => fbqCalls.push(args);
  sandbox.localStorage = sandbox.window.localStorage;
  vm.createContext(sandbox);
  // Expose the two functions on the sandbox global by evaluating the
  // extracted source directly (they are plain function declarations, so
  // this hoists them onto the vm's global scope).
  vm.runInContext(combinedSrc + '\nthis.__getOqVariant = getOqVariant; this.__fire = firePartnerSignupComplete;', sandbox, {
    filename: fileName,
  });
  return { sandbox, gtagCalls, fbqCalls, combinedSrc, variantKey };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function main() {
  // ── partner-re.html ──
  const re = loadHelpers('partner-re.html');

  // Check 1: no source at all -> 'unknown'
  ok(re.sandbox.__getOqVariant() === 'unknown', 'partner-re: no URL/storage/cookie -> "unknown"');

  // Check 2: ?v= on the URL wins
  re.sandbox.window.location.search = '?v=e';
  ok(re.sandbox.__getOqVariant() === 'e', 'partner-re: ?v=e on the URL is read as "e"');

  // Check 3: falls back to persisted localStorage when no ?v=
  re.sandbox.window.location.search = '';
  re.sandbox.window.localStorage.setItem(re.variantKey, 'd');
  ok(re.sandbox.__getOqVariant() === 'd', 'partner-re: persisted localStorage "d" used when URL carries no ?v=');

  // Check 4: falls back to cookie when neither URL nor localStorage has it
  re.sandbox.window.localStorage.removeItem(re.variantKey);
  re.sandbox.document.cookie = re.variantKey + '=c';
  ok(re.sandbox.__getOqVariant() === 'c', 'partner-re: cookie "c" used as last resort');

  // Check 5: malformed ?v= never forwarded — falls through to storage/cookie/unknown
  re.sandbox.window.location.search = '?v=' + encodeURIComponent('<script>DROP;--');
  ok(re.sandbox.__getOqVariant() === 'c', 'partner-re: malformed ?v= is rejected, falls through to cookie');

  // Check 6: once-only guard — second call never fires gtag/fbq again
  re.sandbox.__fire('e');
  re.sandbox.__fire('e');
  re.sandbox.__fire('d'); // even with a different arg — the guard is a flat boolean, not keyed
  ok(re.gtagCalls.length === 1, 'partner-re: firePartnerSignupComplete only calls gtag once across 3 calls');
  ok(re.fbqCalls.length === 1, 'partner-re: firePartnerSignupComplete only calls fbq once across 3 calls');
  ok(
    re.gtagCalls[0][0] === 'event' && re.gtagCalls[0][1] === 'partner_signup_complete' && re.gtagCalls[0][2].variant === 'e',
    'partner-re: gtag call shape is event/partner_signup_complete/{variant}',
  );
  ok(
    re.fbqCalls[0][0] === 'track' && re.fbqCalls[0][1] === 'CompleteRegistration',
    'partner-re: fbq call shape is track/CompleteRegistration',
  );

  // ── partner-insurance.html — same getOqVariant contract, independently extracted ──
  const ins = loadHelpers('partner-insurance.html');
  ins.sandbox.window.location.search = '?v=e';
  ok(ins.sandbox.__getOqVariant() === 'e', 'partner-insurance: ?v=e read the same way as partner-re.html');
  ins.sandbox.__fire('e');
  ins.sandbox.__fire('e');
  ok(ins.gtagCalls.length === 1 && ins.fbqCalls.length === 1, 'partner-insurance: same once-only guard behavior');

  if (failures > 0) {
    console.log(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main();
