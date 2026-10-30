/**
 * gh-3228 / P18 -- the homeowner aerial measurement fee is $22.63 (2263 cents), not $15 (1500 cents).
 * Source-level guard (no browser, no network, no database):
 *   S1  no served page, email source or react copy file states "$15" near measurement / report / aerial / rebate wording
 *   S2  the pages that state the fee state "$22.63"
 *   S3  the DRAFT settings migration moves BOTH keys 1500 -> 2263 in one transaction and the rollback restores 1500
 *   S4  the code constants that mirror the price (static checkout, react utils, Meta CAPI amount guard) read 2263
 * Negative controls: the scanner is run on known-bad strings (it must flag them) and on a "$15,000" roof price (it must not).
 * Run: node tests/gh3228-measurement-price-2263.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// "$15" as a price (not "$15,000", "$150", "$15.50"), within 240 chars of measurement-fee wording.
const OLD_PRICE_RE = /\$15(?![\d]|,\d|\.\d)/g;
const FEE_WORDS_RE = /measure|report|aerial|rebate|refund|property data/i;
function staleHits(text) {
  const out = [];
  let m;
  OLD_PRICE_RE.lastIndex = 0;
  while ((m = OLD_PRICE_RE.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 240), m.index + 240);
    if (FEE_WORDS_RE.test(ctx)) out.push(ctx.replace(/\s+/g, ' ').slice(200, 300));
  }
  return out;
}

// ── negative controls for the scanner itself ─────────────────────────────────
ok(staleHits('Pay $15 Securely for your measurement report').length === 1, 'NC: the scanner flags "Pay $15 Securely" next to measurement wording');
ok(staleHits('You pay as little as $15 up front for professional measurements.').length === 1, 'NC: the scanner flags "as little as $15 up front for professional measurements"');
ok(staleHits('Get a $15 measurement report ($15, rebated if you complete a job)').length === 2, 'NC: the scanner flags both "$15" in the email sentence');
ok(staleHits('A $15,000 replacement of a 15-year roof; measurement of the ridge.').length === 0, 'NC: the scanner does not flag a $15,000 roof price');
ok(staleHits('You pay as little as $22.63 up front for professional measurements.').length === 0, 'NC: the scanner does not flag $22.63');

// ── S1: scan the surfaces ────────────────────────────────────────────────────
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
const surface = tracked.filter((f) => {
  if (f.startsWith('Archive/') || f.startsWith('handoffs/') || f.startsWith('tests/') || f.startsWith('node_modules/')) return false;
  if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(f) || /__tests__\//.test(f)) return false;
  if (/^(.+\.html|llms\.txt|sitemap\.xml)$/.test(f) && !f.includes('/')) return true;           // root pages
  if (/^(blog|guides|partners|locations|news|contractors|news)\/.+\.html$/.test(f)) return true;   // content pages
  if (/^js\/.+\.js$/.test(f)) return true;
  if (/^react-app\/app\/.+\.(ts|tsx)$/.test(f)) return true;
  if (/^supabase\/functions\/(send-[^/]+|notify-[^/]+|_shared)\/.+\.ts$/.test(f)) return true;      // emails
  return false;
});
ok(surface.length > 100, 'S1: the scan covers the pages, js, react copy and email sources (' + surface.length + ' files)');
const stale = [];
for (const f of surface) {
  let t; try { t = read(f); } catch { continue; }
  for (const h of staleHits(t)) stale.push(f + ': ...' + h + '...');
}
ok(stale.length === 0, 'S1: zero "$15" measurement-fee hits on served pages, js, react copy and email sources' + (stale.length ? '\n  ' + stale.join('\n  ') : ''));

// ── S2: the fee is stated as $22.63 where it is stated ───────────────────────
for (const f of ['faq.html', 'help-measurements.html', 'index.html', 'home-next.html', 'terms.html', 're-1.html', 'ref-re.html', 'partner-re.html',
  'react-app/app/(homeowner)/help-measurements/copy.ts', 'supabase/functions/send-homeowner-next-steps/welcome-hook.ts', 'supabase/functions/send-lead-next-step-reminder/email-content.ts']) {
  ok(read(f).includes('$22.63'), 'S2: ' + f + ' states $22.63');
}
ok(/measurement fee of \$22\.63 USD/.test(read('terms.html')), 'S2: terms.html Section 8.5 reads "measurement fee of $22.63 USD" (number-only change; LEGAL-READ)');

// ── S2b: legal copy that must NOT carry a figure (LEGAL-READ L6/L7), and the dates ───────────────────────────────────────
const terms = read('terms.html'), privacy = read('privacy.html');
const notOwed = /<strong>When the Rebate Is Not Owed\.<\/strong>[\s\S]*?<\/p>/.exec(terms);
ok(!!notOwed && !/\$\d/.test(notOwed[0]) && /the Measurement Fee compensates Otter Quotes for the cost of ordering the report on your behalf/.test(notOwed[0]), 'S2b: Terms 8.5 "When the Rebate Is Not Owed" states no figure and says "the Measurement Fee compensates"');
ok(/Payment processing and billing services, including processing of the Measurement Fee and any associated rebate/.test(privacy), 'S2b: privacy.html Stripe line names the Measurement Fee with no figure');
ok(!/Stripe:<\/strong>[^<]*\$\d/.test(privacy), 'S2b: negative control -- no dollar figure on the privacy.html Stripe line');
ok(/<strong>Effective Date:<\/strong> October 30, 2026/.test(terms) && /Effective Date: October 30, 2026/.test(privacy), 'S2b: terms.html and privacy.html Effective Date is October 30, 2026');
const faq = read('faq.html');
ok(faq.includes('The fee pays for ordering the report for you.') && !/covers (Otter Quotes\'|our) cost/.test(faq), 'S2b: FAQ says "The fee pays for ordering the report for you." (no "covers ... cost")');
const hpf = read('react-app/app/(homeowner)/help-measurements/HoverPaymentForm.tsx');
ok(/'Your payment went through and is confirmed\./.test(hpf) && !/Your \$\d[\d.]* payment went through/.test(hpf), 'S2b: the order-failed "payment went through" message carries no amount (a customer caught across the apply was charged the old price)');
ok(/fallback of 1500 cents \(\$15\)/.test(read('supabase/functions/create-hover-order/price-setting.ts')), 'S2b: create-hover-order/price-setting.ts comment still reads "1500 cents ($15)" (historical)');

// ── S3: the draft settings migration ─────────────────────────────────────────
const fwd = read('supabase/migrations_drafts/gh3228_measurement_price_2263.sql');
const rb = read('supabase/migrations_drafts/gh3228_measurement_price_2263_rollback.sql');
ok(/^-- STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(fwd) && /^-- STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(rb), 'S3: both draft files carry the STATUS: NOT APPLIED header');
ok(/key = 'hover_measurement_price'/.test(fwd) && /to_jsonb\(2263\)/.test(fwd) && /'\{roof_basic,homeowner_price_cents\}', to_jsonb\(2263\)/.test(fwd), 'S3: forward sets hover_measurement_price and roof_basic.homeowner_price_cents to 2263');
ok(/to_jsonb\(1500\)/.test(fwd) && /precondition failed/.test(fwd) && /postcondition failed/.test(fwd), 'S3: forward is guarded (precondition both 1500, postcondition both 2263)');
ok(/BEGIN;/.test(fwd) && /COMMIT;/.test(fwd), 'S3: forward is one transaction (the two keys cannot drift)');
ok(/to_jsonb\(1500\)/.test(rb) && /'\{roof_basic,homeowner_price_cents\}', to_jsonb\(1500\)/.test(rb), 'S3: rollback restores both keys to 1500');
ok(!/roof_full|exterior_full/.test(fwd.replace(/^--.*$/gm, '')), 'S3: forward does not touch the contractor-priced SKUs (negative control)');
ok(!/\b(DROP|DELETE|TRUNCATE|ALTER)\b/i.test(fwd.replace(/^--.*$/gm, '')), 'S3: forward has no destructive statement');

// ── S4: the constants that mirror the price ──────────────────────────────────
ok(/amount:\s*2263,/.test(read('help-measurements.html')) && !/amount:\s*1500,/.test(read('help-measurements.html')), 'S4: static checkout amount is 2263');
const utils = read('react-app/app/(homeowner)/help-measurements/utils.ts');
ok(/HOVER_AMOUNT_CENTS = 2263 as const/.test(utils) && /HOVER_AMOUNT_DOLLARS = 22\.63 as const/.test(utils), 'S4: react utils constants are 2263 / 22.63');
const capi = read('supabase/functions/stripe-webhook/meta-capi.ts');
ok(/MEASUREMENT_PURCHASE_VALUE_USD = 22\.63;/.test(capi) && /MEASUREMENT_PURCHASE_AMOUNT_CENTS = 2263;/.test(capi), 'S4: Meta CAPI value/amount guard is 22.63 / 2263 (a stale 1500 guard would silently drop every Purchase)');
ok(!/MEASUREMENT_PURCHASE_AMOUNT_CENTS = 1500/.test(capi), 'S4: negative control -- the CAPI amount guard no longer reads 1500');

// ── S3b: runbook, cancel-open-intents step, sweep, idempotency key ─────────────────────────────────────────────────────
const pre = read('supabase/migrations_drafts/gh3228_measurement_price_2263_pre-flight.md');
for (const [label, text] of [['SQL header', fwd], ['pre-flight', pre]]) {
  ok(['create-payment-intent', 'stripe-webhook', 'send-homeowner-next-steps', 'send-lead-next-step-reminder'].every((f) => text.includes(f)), 'S3b: ' + label + ' names the four edge functions to deploy before the apply (incl. create-payment-intent)');
  ok(/NEVER apply/i.test(text) && /D-291 amendment/.test(text), 'S3b: ' + label + ' says never apply the SQL before the code is live and keeps the D-291 amendment gate');
  ok(/captured immediately|captured automatically/.test(text) && /refund/.test(text) && /by hand/.test(text), 'S3b: ' + label + ' states the PaymentIntent is captured and the sweep refunds or creates the order by hand');
  ok(/requires_payment_method/.test(text) && /requires_confirmation/.test(text) && /requires_action/.test(text) && /cancel/i.test(text), 'S3b: ' + label + ' cancels open 1500-cent intents (requires_payment_method / requires_confirmation / requires_action) right after the apply');
  ok(/7 days/.test(text) && /T\+24h/.test(text) && /T\+1h/.test(text), 'S3b: ' + label + ' widens the sweep to the 7 days before T and runs it at T+1h and T+24h');
  ok(/2026-10-30/.test(text) && /Effective Dates?/.test(text) && /LEGAL-READ/.test(text), 'S3b: ' + label + ' tells the CTO to bump the Effective Dates if the merge lands after 2026-10-30 and to re-run LEGAL-READ');
  ok(/<amount_cents>/.test(text), 'S3b: ' + label + ' documents the amount in the idempotency key');
}
ok(!/lapse/i.test(fwd) && !/authori[sz]ation/i.test(fwd), 'S3b: negative control -- the retired "authorisation lapses" claim is gone from the SQL header');
ok(/payment_intents search/.test(pre) && /amount:1500/.test(pre) && /hover_orders/.test(pre) && /<T-7d epoch>/.test(pre), 'S3b: pre-flight carries the sweep query (Stripe search at 1500 cents, 7 days back, anti-join to hover_orders)');
ok(!/T-1h|T - 1h/.test(pre), 'S3b: negative control -- the old +-1h sweep window is gone');
ok(/status:'succeeded'/.test(pre) && /measurement_order/.test(pre) && /hover_measurement/.test(pre), 'S3b: the sweep covers both PaymentIntent types (measurement_order and legacy hover_measurement)');
const idem = read('supabase/functions/create-payment-intent/standard-create-form.ts');
ok(/\$\{metadata\.type\}-\$\{metadata\.claim_id\}-\$\{String\(amount\)\}/.test(idem) && /standardIdempotencyKey\(metadata, amount\)/.test(read('supabase/functions/create-payment-intent/index.ts')), 'S3b: the create-payment-intent idempotency key includes the amount (a reload after the change gets a fresh 2263 intent)');
ok(!/return `\$\{metadata\.type\}-\$\{metadata\.claim_id\}`;/.test(idem), 'S3b: negative control -- the per-claim-only key is gone');
const rd = read('supabase/migrations_drafts/README.md');
ok(/measurement fee \$15 -> \$22\.63\): 3 files here \(forward, rollback, pre-flight\)/.test(rd), 'S3b: the README section counts the three gh3228 files');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
