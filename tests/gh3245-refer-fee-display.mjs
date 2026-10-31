/**
 * gh-3245 (#3243; LEGAL-READ FAIL 6525943244 on PR #3249) -- refer-a-friend.html must not show a $200 the Partner Agreement v4
 * gate withheld. A gated referral is ledgered status 'job_completed' with commission_amount NULL; the page must key every fee
 * figure on commission_amount (returned by get_my_referrals()), never on the status alone.
 *
 * Asserts (populateReferralsTable / calculateSummary executed in a vm with a fake DOM):
 *   (d1) gated job_completed row (commission_amount NULL) -> fee cell "No fee", pending $0;
 *   (d2) job_completed with commission_amount 200 -> "$200", pending $200;
 *   (d3) commission_paid 200 -> "$200", earned $200; summary line counts completed rows and sums money;
 *   (d4) open referral -> "—";
 *   NEGATIVE CONTROL (n1): the same harness run on the status-only version (PR #3242 head e36df0e9) shows "$200" and
 *   "$200 pending" for the gated row, i.e. the checks above would have caught the defect.
 * Copy (Ben ruling 3 on PR #3249, fresh LEGAL-READ):
 *   (c1) the static hero line is the conditional "Once you accept the Partner Agreement, you earn $200 ..." and the unconditional
 *        line is swapped in only by showAcceptedHero(), which runs only after acceptance is confirmed or recorded;
 *   (c2) the acceptance card says "Referral fees apply to friends whose projects start after you accept."
 *
 * Run: node tests/gh3245-refer-fee-display.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'refer-a-friend.html'), 'utf8');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('PASS: ' + label); } else { fail++; console.log('FAIL: ' + label); } }

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
function extractConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\};`));
  return m ? m[0] : '';
}
function harness(src, rows) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', style: {} });
  ['referrals-tbody', 'total-earned', 'total-pending', 'referral-summary'].forEach(el);
  const code = [extractConst(src, 'REFERRAL_STATUS_LABELS'), extractConst(src, 'REFERRAL_STATUS_CLASSES'),
    extractFn(src, 'escapeHtml'), extractFn(src, 'referralFeeAmount'), extractFn(src, 'referralFeeCell'),
    extractFn(src, 'populateReferralsTable'), extractFn(src, 'calculateSummary'),
    'populateReferralsTable(rows); calculateSummary(rows);'].join('\n');
  const ctx = { rows, document: { getElementById: (id) => els[id] || null } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const cells = [...els['referrals-tbody'].innerHTML.matchAll(/<tr>(.*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td>(.*?)<\/td>/g)].map(x => x[1]));
  return { fee: cells.map(c => c[3]), earned: els['total-earned'].textContent, pending: els['total-pending'].textContent, summary: els['referral-summary'].textContent };
}
const gated = { display_name: 'Gina G.', created_at: '2026-11-01T12:00:00Z', status: 'job_completed', commission_amount: null };
const accrued = { display_name: 'Ann A.', created_at: '2026-11-01T12:00:00Z', status: 'job_completed', commission_amount: 200 };
const paid = { display_name: 'Pat P.', created_at: '2026-09-01T12:00:00Z', status: 'commission_paid', commission_amount: 200 };
const open = { display_name: 'Olu O.', created_at: '2026-11-02T12:00:00Z', status: 'claim_submitted', commission_amount: null };

let r = harness(page, [gated]);
ok(r.fee[0] === 'No fee' && r.pending === '$0' && r.earned === '$0', '(d1) gated completed referral: fee "No fee", $0 pending, $0 earned -- got ' + JSON.stringify(r));
r = harness(page, [accrued]);
ok(r.fee[0] === '$200' && r.pending === '$200', '(d2) accrued completed referral: "$200", $200 pending -- got ' + JSON.stringify(r));
r = harness(page, [paid, accrued, gated, open]);
ok(JSON.stringify(r.fee) === JSON.stringify(['$200', '$200', 'No fee', '—']) && r.earned === '$200' && r.pending === '$200'
  && r.summary === '4 referrals · 3 completed · $200 earned', '(d3) mixed list: cells, totals and summary line come from commission_amount -- got ' + JSON.stringify(r));
ok(harness(page, [open]).fee[0] === '—', '(d4) open referral shows "—"');

let old = null;
try { old = execFileSync('git', ['show', 'e36df0e90cc7db4073058dc764368cbf24c6c508:refer-a-friend.html'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* shallow clone */ }
if (old) {
  const o = harness(old, [gated]);
  ok(o.fee[0] === '$200' && o.pending === '$200', '(n1) NEGATIVE CONTROL: the status-only version shows "$200" and "$200 pending" for the gated row -- got ' + JSON.stringify(o));
} else console.log('SKIP: (n1) base commit not available');

const heroStatic = page.match(/<p class="subtitle" id="hero-subtitle">([^<]*)<\/p>/);
ok(!!heroStatic && heroStatic[1].startsWith('Once you accept the Partner Agreement, you earn $200 for every friend you refer'), '(c1a) static hero line is conditional on acceptance');
const swapCalls = [...page.matchAll(/showAcceptedHero\(\);/g)].length;
const init = extractFn(page, 'init'), accept = extractFn(page, 'acceptAgreementV4');
ok(swapCalls === 2 && init.indexOf('showAcceptedHero();') > init.indexOf('if (!accepted)') && accept.indexOf('showAcceptedHero();') > accept.indexOf("sb.rpc('accept_partner_agreement_v4')"),
  '(c1b) the unconditional hero line is shown only after acceptance is confirmed (init) or recorded (accept)');
ok(page.includes('<p>Referral fees apply to friends whose projects start after you accept.</p>'), '(c2) acceptance card states the project-start rule');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
