/**
 * OtterQuote Launch-Prep Smoke Tests
 * Created: Session 181 (Apr 15, 2026)
 *
 * These are canary tests encoding the EXPECTED behavior of core business
 * math per our authoritative decisions. They do not call live endpoints.
 * They exist to catch silent drift between documented rules (D-139, D-140,
 * D-141, D-142, D-143) and the eventual Edge Functions / SQL triggers that
 * implement them.
 *
 * Run: node tests/smoke-tests.mjs
 * Exit code 0 = pass, 1 = any failure.
 *
 * Session 182 update — ClickUp 86e0xdy9h CLOSED. The backend commission
 * implementation (v40-commission-trigger.sql) now exists in the DB. The
 * in-file JS reference for `referralPayout` has been retired in favor of
 * `./referral-payout-via-trigger.mjs`, which exercises the real
 * apply_referral_commission() trigger via the Supabase Management API
 * (BEGIN ... ROLLBACK — no persisted rows). Commission tests are now async.
 */

import { referralPayout } from "./referral-payout-via-trigger.mjs";
import { commissionReversal } from "./commission-reversal-via-trigger.mjs";

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`  \u2717 ${name}\n      expected: ${e}\n      actual:   ${a}`);
    console.log(`  \u2717 ${name}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// REFERENCE IMPLEMENTATIONS
// ---------------------------------------------------------------------------

/**
 * Quote math: sum of line items, with per-section RCV/ACV subtotals.
 * Mirrors the structure in contractor-bid-form.html and the loss_sheet
 * JSON produced by parse-loss-sheet. A line item has:
 *   { description, qty, unit_price, rcv, acv }
 * A section has: { name, items: [...] }
 * Return: { subtotal_rc, subtotal_acv, total_rc, total_acv }
 */
function computeQuoteTotals(sections) {
  let total_rc = 0;
  let total_acv = 0;
  const sectionTotals = [];

  for (const s of sections) {
    let subtotal_rc = 0;
    let subtotal_acv = 0;
    for (const it of (s.items || [])) {
      // Prefer explicit rcv/acv; fall back to qty * unit_price for RCV with ACV=RCV.
      const line_rc  = it.rcv  != null ? Number(it.rcv)  : Number(it.qty || 0) * Number(it.unit_price || 0);
      const line_acv = it.acv  != null ? Number(it.acv)  : line_rc;
      subtotal_rc  += line_rc;
      subtotal_acv += line_acv;
    }
    sectionTotals.push({
      name: s.name,
      subtotal_rc,
      subtotal_acv,
    });
    total_rc  += subtotal_rc;
    total_acv += subtotal_acv;
  }

  return { sections: sectionTotals, total_rc, total_acv };
}

// NOTE: the pure-JS referralPayout reference that lived here was retired in
// Session 182. It is now imported from ./referral-payout-via-trigger.mjs,
// which runs against the live apply_referral_commission() SQL trigger
// inside a BEGIN ... ROLLBACK transaction. See D-139/D-140/D-141/D-142.

/**
 * Service-area match: returns true if a contractor covers the claim's state.
 * NOTE: As of Apr 15, 2026 the `contractors` schema has only a free-text
 * `service_area` column (v7) and a `service_area_description` column (v10).
 * There is NO structured state/ZIP column. This reference function models
 * what SHOULD be true once structured coverage is added. Until then, the
 * notify-contractors Edge Function does not filter by state — it only
 * filters by trade. Flagged in Handoff_2026-04-15.md.
 *
 * Input: contractor.service_states (array of 2-letter codes) and claim.state.
 */
function contractorCoversState(contractor, claim) {
  if (!contractor || !contractor.service_states || contractor.service_states.length === 0) {
    // Conservative: if no coverage list, do NOT auto-match to arbitrary states.
    return false;
  }
  const states = contractor.service_states.map(s => String(s).toUpperCase());
  return states.includes(String(claim.state || "").toUpperCase());
}

// ---------------------------------------------------------------------------
// TESTS
// ---------------------------------------------------------------------------

section("Quote math");

// Simple single-section quote
{
  const sections = [
    { name: "Roof", items: [
      { description: "3-tab shingle", qty: 30, unit_price: 95.50 },   // 2865
      { description: "Underlayment",  qty: 30, unit_price: 12.00 },   // 360
      { description: "Ridge cap",     qty: 10, unit_price: 42.00 },   // 420
    ]},
  ];
  const t = computeQuoteTotals(sections);
  eq("single section RCV subtotal", t.sections[0].subtotal_rc, 3645);
  eq("single section total_rc equals subtotal", t.total_rc, 3645);
  eq("single section total_acv defaults to RCV when ACV not set", t.total_acv, 3645);
}

// Multi-section quote with ACV
{
  const sections = [
    { name: "Roof",  items: [ { qty: 1, unit_price: 10000, rcv: 10000, acv: 8500 } ] },
    { name: "Gutters", items: [ { qty: 1, unit_price: 2000, rcv: 2000, acv: 2000 } ] },
    { name: "Fascia",  items: [ { qty: 1, unit_price: 500,  rcv: 500,  acv: 400  } ] },
  ];
  const t = computeQuoteTotals(sections);
  eq("multi-section RCV total", t.total_rc, 12500);
  eq("multi-section ACV total (RCV minus depreciation)", t.total_acv, 10900);
}

// Empty sections
{
  const t = computeQuoteTotals([]);
  eq("empty quote totals to zero", [t.total_rc, t.total_acv], [0, 0]);
}

// Zero-quantity line items
{
  const t = computeQuoteTotals([{ name: "X", items: [ { qty: 0, unit_price: 500 } ] }]);
  eq("zero-qty line item contributes zero", t.total_rc, 0);
}

section("Commission math (D-139/D-140/D-141/D-142)");

// Below $10K floor
{
  const out = await referralPayout({ job_total: 9999, referrer: "agent_a" });
  eq("job below $10K: no payout", out, { referrer_bonus: 0, recruiter_bonus: 0, eligible: false });
}

// Exactly $10K
{
  const out = await referralPayout({ job_total: 10000, referrer: "agent_a" });
  eq("job at $10K: referrer gets $200", out.referrer_bonus, 200);
  eq("job at $10K: no recruiter set -> recruiter gets $0", out.recruiter_bonus, 0);
}

// Referrer only, no recruiter in chain
{
  const out = await referralPayout({ job_total: 50000, referrer: "agent_a" });
  eq("no recruiter: recruiter_bonus is 0", out.recruiter_bonus, 0);
  eq("solo referrer gets $200", out.referrer_bonus, 200);
}

// Two-tier: recruiter recruited referrer BEFORE the referral
{
  const out = await referralPayout({
    job_total: 25000,
    referrer: "agent_b",
    recruiter: "agent_a",
    recruited_at: "2026-03-01",
    referred_at: "2026-04-10",
  });
  eq("two-tier forward: referrer gets $200", out.referrer_bonus, 200);
  eq("two-tier forward: recruiter gets $50", out.recruiter_bonus, 50);
}

// Recruit AFTER referral — forward-only, recruiter gets $0 (D-142)
{
  const out = await referralPayout({
    job_total: 25000,
    referrer: "agent_b",
    recruiter: "agent_a",
    recruited_at: "2026-05-01",
    referred_at: "2026-04-10",
  });
  eq("backward chain: recruiter_bonus is 0 (D-142)", out.recruiter_bonus, 0);
  eq("backward chain: referrer still gets $200", out.referrer_bonus, 200);
}

// No referrer at all -> ineligible
{
  const out = await referralPayout({ job_total: 20000, referrer: null });
  eq("no referrer: ineligible", out, { referrer_bonus: 0, recruiter_bonus: 0, eligible: false });
}

// One-level-deep: recruiter-of-recruiter gets nothing (D-140)
// (Modeled by never passing a grandparent — the function signature has no slot for it.)
{
  const out = await referralPayout({
    job_total: 40000,
    referrer: "agent_c",
    recruiter: "agent_b",
    recruited_at: "2026-01-01",
    referred_at: "2026-04-01",
  });
  // agent_a (who recruited agent_b) is intentionally absent from the payout.
  eq("one-level cap: only two payouts produced", Object.keys(out).filter(k => k.endsWith('_bonus')).length, 2);
  eq("one-level cap: total payout = $250", out.referrer_bonus + out.recruiter_bonus, 250);
}

section("Commission reversal (D-145 — v42 after_quote_refunded)");

// (a) Unpaid reversal with recruiter — both ledger amounts zero out, status
// steps back to contract_signed, and the recruiter's running recruit_earnings
// is decremented by exactly the amount that was credited on the v40 pass.
{
  const { pre, post } = await commissionReversal({
    job_total: 25000,
    hasRecruiter: true,
  });
  eq("unpaid: v40 wrote $200 referrer on pre-refund", pre.commission_amount, 200);
  eq("unpaid: v40 wrote $50 recruiter on pre-refund", pre.recruit_commission_amount, 50);
  eq("unpaid: v40 set status=job_completed on pre-refund", pre.status, "job_completed");
  eq("unpaid: v40 bumped recruit_earnings to 50 on pre-refund", pre.recruit_earnings, 50);

  eq("unpaid reversal zeroes commission_amount", post.commission_amount, 0);
  eq("unpaid reversal zeroes recruit_commission_amount", post.recruit_commission_amount, 0);
  eq("unpaid reversal steps status back to contract_signed", post.status, "contract_signed");
  eq("unpaid reversal decrements recruit_earnings to 0", post.recruit_earnings, 0);
}

// (a2) Unpaid reversal WITHOUT a recruiter — only the referrer tier was
// credited, so only it needs zeroing. recruit_earnings stays 0 because no
// recruiter exists on the chain.
{
  const { pre, post } = await commissionReversal({
    job_total: 15000,
    hasRecruiter: false,
  });
  eq("unpaid solo: pre commission_amount is 200", pre.commission_amount, 200);
  eq("unpaid solo: pre recruit_commission_amount is 0", pre.recruit_commission_amount, 0);
  eq("unpaid solo: post commission_amount is 0", post.commission_amount, 0);
  eq("unpaid solo: post status is contract_signed", post.status, "contract_signed");
}

// (b) Paid reversal — commission_paid_at is non-null at refund time, so v42
// must refuse to reverse (RAISE LOG, no-op). Ledger must be exactly as v40
// left it.
{
  const { pre, post } = await commissionReversal({
    job_total: 25000,
    hasRecruiter: true,
    markPaid: true,
  });
  eq("paid: pre commission_amount is 200", pre.commission_amount, 200);
  eq("paid reversal does NOT zero commission_amount", post.commission_amount, 200);
  eq("paid reversal does NOT zero recruit_commission_amount", post.recruit_commission_amount, 50);
  eq("paid reversal leaves status at job_completed", post.status, "job_completed");
  eq("paid reversal does NOT decrement recruit_earnings", post.recruit_earnings, 50);
}

// (c) Quote with no referral attached — v40 no-ops, v42 no-ops. The test
// simply verifies the round-trip completes without error and returns NULLs
// for the referral-sourced columns.
{
  const { pre, post } = await commissionReversal({
    job_total: 25000,
    skipReferral: true,
  });
  eq("no referral: pre commission_amount is null", pre.commission_amount, null);
  eq("no referral: post commission_amount is null", post.commission_amount, null);
  eq("no referral: pre status is null", pre.status, null);
  eq("no referral: post status is null", post.status, null);
}

// (d) Double-reversal is idempotent — after a second 'refunded' transition,
// the ledger is still zero and recruit_earnings is still decremented by
// exactly $50 (not $100). v42's `commission_amount = 0` guard short-circuits
// the second fire.
{
  const { post } = await commissionReversal({
    job_total: 25000,
    hasRecruiter: true,
    doubleFire: true,
  });
  eq("double-fire: commission_amount still 0", post.commission_amount, 0);
  eq("double-fire: recruit_commission_amount still 0", post.recruit_commission_amount, 0);
  eq("double-fire: status still contract_signed", post.status, "contract_signed");
  // If the second fire had NOT been idempotent, the recruiter would have
  // been debited twice. The GREATEST(..., 0) clamp would still prevent a
  // negative balance, but the intent is that no second debit happens at all.
  eq("double-fire: recruit_earnings still 0 (not double-decremented)", post.recruit_earnings, 0);
}

section("Service area coverage");

// Structured state list
{
  const c = { service_states: ["IN", "OH"] };
  eq("IN claim matches IN+OH contractor", contractorCoversState(c, { state: "IN" }), true);
  eq("OH claim matches IN+OH contractor", contractorCoversState(c, { state: "OH" }), true);
  eq("KY claim does NOT match IN+OH contractor", contractorCoversState(c, { state: "KY" }), false);
}

// Case-insensitive
{
  eq("lowercase claim state matches", contractorCoversState({ service_states: ["IN"] }, { state: "in" }), true);
}

// Missing coverage -> no match (conservative)
{
  eq("contractor with no service_states -> no match", contractorCoversState({}, { state: "IN" }), false);
  eq("contractor with empty service_states -> no match", contractorCoversState({ service_states: [] }, { state: "IN" }), false);
}

// Multi-state spot check
{
  const c = { service_states: ["IN", "KY", "OH", "IL", "MI"] };
  for (const s of c.service_states) {
    eq(`multi-state contractor covers ${s}`, contractorCoversState(c, { state: s }), true);
  }
  eq("multi-state contractor does NOT cover TX", contractorCoversState(c, { state: "TX" }), false);
}

// ---------------------------------------------------------------------------
// D-178: Homeowner state gating -- parseStateFromAddress + waitlist trigger
// ---------------------------------------------------------------------------
// Inline the same logic used in dashboard.html so smoke tests stay dependency-free.

section("D-178 state gating");

function parseStateFromAddress(address) {
  if (!address) return null;
  const match = address.match(/[,\s]+([A-Za-z]{2})[,\s]+\d{5}(?:-\d{4})?/);
  if (match) return match[1].toUpperCase();
  return null;
}

function stateGateWouldFire(property_state) {
  return Boolean(property_state && property_state !== 'IN');
}

// Test 1 -- Indiana address -> "IN", gate does NOT fire (homeowner proceeds normally)
{
  const state = parseStateFromAddress("123 Main St, Carmel, IN 46032");
  eq("IN address parses to 'IN'", state, "IN");
  eq("IN homeowner: gate does NOT fire", stateGateWouldFire(state), false);
}

// Test 2 -- Ohio address -> "OH", gate fires and waitlist row would be created
{
  const state = parseStateFromAddress("456 Oak Ave, Columbus, OH 43215");
  eq("OH address parses to 'OH'", state, "OH");
  eq("OH homeowner: gate fires, waitlist row created", stateGateWouldFire(state), true);
}

// Test 3 -- null input -> null, gate does NOT fire (new signup before state is set)
{
  eq("null address returns null (no crash)", parseStateFromAddress(null), null);
  eq("null state: gate does NOT fire (no false gate on new signups)", stateGateWouldFire(null), false);
}

// Test 4 -- Kentucky address -> "KY", gate fires and waitlist row would be created
{
  const state = parseStateFromAddress("789 Maple Dr, Louisville, KY 40202");
  eq("KY address parses to 'KY'", state, "KY");
  eq("KY homeowner: gate fires, waitlist row created", stateGateWouldFire(state), true);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Summary ===`);
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
}
process.exit(0);
