/**
 * gh-3229 (P18) -- frontend and edge-function wiring for the $5 measurement referral fee.
 * Static + syntax checks (no browser, no database; the database behaviour is supabase/tests/gh3229_partner_measurement_fee_proof.sql):
 *   partner-dashboard.html : the referral fee card calls get_partner_dashboard_stats(), shows the numbers, hides for home inspectors,
 *                            says "referral fee" never "commission" in the new copy, and recruit earnings come from the RPC, not a client read
 *   admin-payouts.html     : "Run monthly batch" calls create_monthly_fee_batch with the chosen month
 *   mark-payout-paid       : flips the batched events through partner_fee_events_mark_paid for measurement_fees_monthly only
 *   approve-payout         : the job-completion gate skips the monthly measurement-fee payout
 *   formatPayoutType       : labels the new type (mark-payout-paid and approve-payout)
 * Every inline <script> of both pages must parse.
 * Run: node tests/gh3229-partner-fee-wiring.mjs      GH3229_ROOT points at another tree for a negative control (a checkout of main: checks fail).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = process.env.GH3229_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }
function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } }
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
}
function parses(html) {
  try { inlineScripts(html).forEach((s) => new vm.Script(s)); return html.length > 0; } catch (e) { console.log('  parse error: ' + e.message); return false; }
}

const dash = read('partner-dashboard.html');
const admin = read('admin-payouts.html');
const mpp = read('supabase/functions/mark-payout-paid/index.ts');
const app = read('supabase/functions/approve-payout/index.ts');

ok(parses(dash), 'partner-dashboard.html inline scripts parse');
ok(parses(admin), 'admin-payouts.html inline scripts parse');

// partner dashboard card
ok(/sb\.rpc\('get_partner_dashboard_stats'\)/.test(dash), 'dashboard calls get_partner_dashboard_stats() with no partner argument');
ok(/<div class="fee-summary" id="partnerFeeSummary" style="display:none;"><\/div>/.test(dash), 'static HTML holds only an empty hidden placeholder (no fee wording for inspector / JS-off renders)');
const loader0 = (dash.match(/async function loadFeeSummary[\s\S]*?\n        }\n/) || [''])[0];
for (const id of ['feeClicks', 'feeSignedUp', 'feeMeasurements', 'feeJobs', 'feeAccrued', 'feePaid', 'feeNextPayout'])
  ok(loader0.includes(`card('${id}'`), `card shows ${id}`);
ok(/home_inspector'\) return;\s*\/\/ no fee, no card/.test(dash), 'home-inspector partners never see the card');
ok(/payout_minimum_cents/.test(dash), 'the minimum in the note comes from the RPC, not a hard-coded number');
const cardHtml = '';
const loader = (dash.match(/async function loadFeeSummary[\s\S]*?\n        }\n/) || [''])[0];
ok(loader.length > 800, 'loader found');
ok(!/commission/i.test(cardHtml + loader), 'new copy says "referral fee", never "commission"');
ok(loader.includes('$200 referral fee on projects of $10,000 or more'), 'jobs card states the $10,000 threshold');
ok(loader.includes('On hold until your payment details are complete') && /payments_blocked/.test(loader), 'blocked partner sees the on-hold line');
ok(loader.includes("'expected with the ' + monthName + ' batch, after approval'"), 'next-payout subtext says expected, after approval');
ok(!/Commission payments/.test(dash) && !/\$600/.test(dash) && /Referral fee payments are held until/.test(dash), 'W-9 card says referral fee payments and states no dollar threshold');
{
  const cmo = fs.readFileSync(path.join(ROOT, 'supabase/functions/create-measurement-order/index.ts'), 'utf8');
  ok(!/body\.buyer_role === "contractor" \? "contractor" : "homeowner"/.test(cmo) && /buyer_role must be 'homeowner' or 'contractor'/.test(cmo), 'create-measurement-order has no silent homeowner default for buyer_role');
}
ok(/midnight Eastern time/.test(admin), 'admin confirm text names Eastern time');
ok(!/test rows excluded/.test(dash), 'stale test-rows-excluded comment removed');
ok(dash.indexOf('await loadFeeSummary()') > dash.indexOf('await loadStats()') && dash.indexOf('await loadFeeSummary()') < dash.indexOf('await loadRecruits()'),
   'loadFeeSummary runs after loadStats and before loadRecruits');
// recruit earnings now come from the RPC
ok(/feeStats\.recruits/.test(dash) && /earnings_cents/.test(dash), 'per-recruit earnings read from get_partner_dashboard_stats().recruits');
ok(!/\.from\('referrals'\)\s*\.select\('referral_agent_id, recruit_commission_amount'\)/.test(dash), 'no client read of other partners\' referrals for recruit earnings');
ok(/feeStats\.recruit_earnings_cents/.test(dash), 'Recruit Earnings card uses the server total');

// admin
ok(/sb\.rpc\('create_monthly_fee_batch',\s*\{\s*p_month: month\s*\}\)/.test(admin), 'admin button calls create_monthly_fee_batch with the chosen month');
ok(/onclick="runMonthlyBatch\(this\)">Run monthly batch</.test(admin), '"Run monthly batch" button present');
ok(/measurement_fees_monthly/.test(admin), 'admin table labels the new payout type');

// edge functions
ok(/payout_type === "measurement_fees_monthly"[\s\S]{0,200}rpc\("partner_fee_events_mark_paid"/.test(mpp), 'mark-payout-paid flips events only for measurement_fees_monthly via the RPC');
ok(mpp.indexOf('partner_fee_events_mark_paid') > mpp.indexOf('status:  "paid"'), 'flip happens after the payout row is marked paid');
ok(/fee_events_error/.test(mpp), 'a failed flip is reported in the response');
ok(/!overrideIncomplete && approval\.payout_type !== "measurement_fees_monthly"/.test(app), 'approve-payout completion gate skips the monthly measurement-fee payout');

// labels (node strips the types of these dependency-free modules)
for (const fn of ['mark-payout-paid', 'approve-payout', 'notify-payout-pending', 'process-payout-reminders']) {
  const p = path.join(ROOT, 'supabase/functions', fn, 'templates.ts');
  try {
    const mod = await import(pathToFileURL(p).href);
    ok(mod.formatPayoutType('measurement_fees_monthly') === 'Measurement Referral Fees', `${fn} formatPayoutType labels measurement_fees_monthly`);
    ok(/^Referral/.test(mod.formatPayoutType('commission_referral')) && mod.formatPayoutType('commission_recruit') === 'Recruit Bonus', `${fn} formatPayoutType unchanged for the existing types`);
  } catch (e) { ok(false, `${fn} templates.ts loads (${e.message.split('\n')[0]})`); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
