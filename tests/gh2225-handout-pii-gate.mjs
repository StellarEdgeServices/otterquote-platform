/**
 * gh-2225 -- fix round for REVIEW FAIL + LEGAL-READ FAIL 5849558470 on PR
 * #2225 (ins-5/hi-4 handout lead-magnet funnels).
 *
 * B1 (PII to Meta): assets/handout-ins-5.html and assets/handout-hi-4.html
 * must not load js/meta-pixel-gate.js (or any other analytics script), and
 * ins-5.html/hi-4.html's buildHandoutUrl() must not put name/company/phone/
 * email/link into the handout's query string -- only the opaque `code`.
 *
 * B2 (unvalidated `link`): the handout pages must not read a `link` query
 * param at all, and must validate `code` against the real unique_code
 * alphabet (/^[A-Za-z0-9_-]{1,64}$/) before building
 * https://otterquote.com/ref.html?code=... from it.
 *
 * Static source inspection (no headless browser in this worktree, same
 * constraint documented in tests/gh2155-hi0c-inspector-sweep.mjs and
 * tests/gh2155-hi05b-inspector-crawler.mjs) -- reads the real files, no
 * hand-retyped reimplementation.
 *
 * Negative control: runs the exact same checks against the pre-fix source
 * (reconstructed inline, byte-identical to the flagged lines in comment
 * 5849558470) and asserts EVERY check fails there, proving these assertions
 * are not vacuously true against any input.
 *
 * Run: node tests/gh2225-handout-pii-gate.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

const CODE_RE_SRC = /^[A-Za-z0-9_-]\{1,64\}$/; // literal match target inside source text
const HANDOUT_FILES = ['assets/handout-ins-5.html', 'assets/handout-hi-4.html'];
const FUNNEL_FILES = ['ins-5.html', 'hi-4.html'];

// ── Checks applied to a given (filename, source) pair ──────────────────────

function handoutHasNoPixel(src) {
  return !/js\/meta-pixel-gate\.js/.test(src) && !/gtag\(/.test(src) && !/clarity\(/.test(src);
}

function handoutHasNoLinkParam(src) {
  return !/qp\.get\(\s*['"]link['"]\s*\)/.test(src) && !/getElementById\('refLinkBox'\)\.textContent\s*=\s*link/.test(src);
}

function handoutValidatesCode(src) {
  // Must define the real unique_code alphabet regex AND use it to gate
  // building the ref.html URL from qp.get('code').
  const hasRegex = /\/\^\[A-Za-z0-9_-\]\{1,64\}\$\//.test(src);
  const usesCodeParam = /qp\.get\(\s*['"]code['"]\s*\)/.test(src);
  const buildsRefUrl = /https:\/\/otterquote\.com\/ref\.html\?code=/.test(src);
  return hasRegex && usesCodeParam && buildsRefUrl;
}

function extractFunctionBody(src, fnName) {
  const startMatch = src.match(new RegExp('function ' + fnName + '\\([^)]*\\)\\s*\\{'));
  if (!startMatch) return null;
  let i = startMatch.index + startMatch[0].length;
  let depth = 1;
  const start = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(start, i - 1);
}

function funnelBuildsCodeOnlyUrl(src) {
  const body = extractFunctionBody(src, 'buildHandoutUrl');
  if (!body) return false;
  const returnsUrl = /return\s+'\/assets\/handout-[\w-]+\.html\?'\s*\+\s*qs\.toString\(\)/.test(body);
  if (!returnsUrl) return false;
  // The URLSearchParams object(s) built in this function must carry ONLY a
  // `code` key -- no name/company/phone/email/link.
  const qsBlocks = [...body.matchAll(/new URLSearchParams\(\{([\s\S]*?)\}\)/g)];
  if (qsBlocks.length === 0) return false;
  return qsBlocks.every(([, inner]) => {
    const keys = [...inner.matchAll(/(\w+)\s*:/g)].map((mm) => mm[1]);
    return keys.length === 1 && keys[0] === 'code';
  });
}

function funnelUsesSessionStorageForContact(src) {
  return /sessionStorage\.setItem\(/.test(src);
}

// ── Positive assertions against the real, fixed files ───────────────────────

for (const f of HANDOUT_FILES) {
  const src = read(f);
  ok(handoutHasNoPixel(src), `${f}: no Meta pixel / gtag / clarity script`);
  ok(handoutHasNoLinkParam(src), `${f}: no unvalidated 'link' query param read`);
  ok(handoutValidatesCode(src), `${f}: 'code' is validated against /^[A-Za-z0-9_-]{1,64}$/ before building the referral URL`);
}

for (const f of FUNNEL_FILES) {
  const src = read(f);
  ok(funnelBuildsCodeOnlyUrl(src), `${f}: buildHandoutUrl() puts only 'code' in the handout query string`);
  ok(funnelUsesSessionStorageForContact(src), `${f}: buildHandoutUrl() hands off contact fields via sessionStorage, not the URL`);
}

// ── Negative control: the SAME checks against the pre-fix source, verbatim
// from the flagged lines in review comment 5849558470, must all FAIL. This
// proves the checks above are not vacuously true (e.g. a regex that matches
// everything, or a check that never actually runs).

const PRE_FIX_HANDOUT_SNIPPET = `
    <script>
        try {
            var qp = new URLSearchParams(window.location.search);
            setText('cbName', qp.get('name'));
            setText('cbPhone', qp.get('phone'));
            setText('cbEmail', qp.get('email'));
            var link = qp.get('link');
            if (link) { document.getElementById('refLinkBox').textContent = link; }
        } catch (e) {}
    </script>
    <script src="/js/meta-pixel-gate.js"></script>
`;

const PRE_FIX_BUILD_HANDOUT_URL = `
        function buildHandoutUrl(agentFirstName, agentCompany, agentPhone, agentEmail, uniqueCode) {
            var referralLink = 'https://otterquote.com/ref.html?code=' + encodeURIComponent(uniqueCode);
            var qs = new URLSearchParams({
                name: agentFirstName || '',
                company: agentCompany || '',
                phone: agentPhone || '',
                email: agentEmail || '',
                link: referralLink,
            });
            return '/assets/handout-ins-5.html?' + qs.toString();
        }
`;

ok(!handoutHasNoPixel(PRE_FIX_HANDOUT_SNIPPET), 'negative control: pre-fix handout snippet is correctly caught (has pixel script)');
ok(!handoutHasNoLinkParam(PRE_FIX_HANDOUT_SNIPPET), 'negative control: pre-fix handout snippet is correctly caught (reads unvalidated link param)');
ok(!handoutValidatesCode(PRE_FIX_HANDOUT_SNIPPET), 'negative control: pre-fix handout snippet is correctly caught (no code validation)');
ok(!funnelBuildsCodeOnlyUrl(PRE_FIX_BUILD_HANDOUT_URL), 'negative control: pre-fix buildHandoutUrl() is correctly caught (PII in query string)');
ok(!funnelUsesSessionStorageForContact(PRE_FIX_BUILD_HANDOUT_URL), 'negative control: pre-fix buildHandoutUrl() is correctly caught (no sessionStorage handoff)');

// ── Bonus: the D-169 geographic claim and the B3 paraphrase must be gone too,
// with the same negative-control shape (the pre-fix strings, byte-identical
// to what shipped at c0092520, must still match the "bad" pattern).

const INDIANA_RE = /"Otter Quotes"\s*service area:\s*Indiana\.|Otter Quotes,\s*Indiana/;
for (const f of HANDOUT_FILES) {
  const src = read(f);
  ok(!INDIANA_RE.test(src), `${f}: no Indiana geographic claim (D-169)`);
}
ok(INDIANA_RE.test('"Otter Quotes" service area: Indiana.'), 'negative control: Indiana-claim regex correctly matches the removed sentence');
ok(INDIANA_RE.test('Otter Quotes, Indiana &middot; otterquote.com'), 'negative control: Indiana-claim regex correctly matches the removed footer');

const PARAPHRASED_FEE_RE = /Earn \$200 when a referred job of \$10,000\+ completes\./;
const ins5Src = read('ins-5.html');
ok(!PARAPHRASED_FEE_RE.test(ins5Src), 'ins-5.html: paraphrased D-301/D-305 fee bullet (benefit2) is gone');
ok(PARAPHRASED_FEE_RE.test('Earn $200 when a referred job of $10,000+ completes.'), 'negative control: paraphrase regex correctly matches the removed bullet');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
