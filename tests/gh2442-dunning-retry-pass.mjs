/**
 * gh-2442 -- process-dunning retry pass: one charge attempt per recorded request, never more.
 * Runs the real retry-pass.ts / retry-pass-supabase.ts under node type-stripping (Deno is not needed).
 * Negative control: on main these files do not exist, so the import below fails (exit 1).
 * Run: node --experimental-strip-types tests/gh2442-dunning-retry-pass.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'supabase/functions/process-dunning');
const P = await import(path.join(dir, 'retry-pass.ts'));
const S = await import(path.join(dir, 'retry-pass-supabase.ts'));
const idx = fs.readFileSync(path.join(dir, 'index.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

const NOW = new Date('2026-10-20T15:00:00Z');
const iso = (minAgo) => new Date(NOW.getTime() - minAgo * 60000).toISOString();
const inH = (h) => new Date(NOW.getTime() + h * 3600000).toISOString();
const row = (o = {}) => ({ id: 'r1', quote_id: 'q1', contractor_id: 'c1', claim_id: 'cl1', amount_cents: 18000,
  dunning_status: 'active', resolved_at: null, homeowner_notify_at: inH(20), retry_requested_at: iso(5),
  retry_request_count: 1, retry_handled_at: null, ...o });

function makeDeps(rows, over = {}) {
  const log = { handled: [], charges: [], quote: [], closed: [], alerts: [] };
  const deps = {
    now: () => NOW,
    listCandidateRows: async () => rows,
    markHandled: async (ids, t) => { log.handled.push([ids, t]); return over.markWrites ?? ids.length; },
    getQuotePaymentStatus: async () => over.payStatus ?? 'failed',
    chargeGuard: async () => over.guard ?? { allow: true, message: '' },
    getChargeMethods: async () => over.methods === undefined
      ? { customerId: 'cus_1', methods: [{ stripe_pm_id: 'pm_ach1', payment_type: 'us_bank_account', cpm_id: 'cpm1' }, { stripe_pm_id: 'pm_card1', payment_type: 'card', cpm_id: 'cpm2' }] }
      : over.methods,
    charge: async (req) => { log.charges.push(req); return (over.results ?? [])[log.charges.length - 1] ?? { status: 'failed', paymentIntentId: null, declineCode: 'card_declined', message: 'x' }; },
    recordQuoteResult: async (q, u) => { log.quote.push([q, u]); return true; },
    closeDunningRows: async (ids) => { log.closed.push(ids); return ids.length; },
    alert: async (t, m) => { log.alerts.push([t, m]); },
  };
  return { deps, log };
}
const SUCCESS = { status: 'succeeded', paymentIntentId: 'pi_1', declineCode: null, message: null };

// ── pure helpers
ok(P.cardChargeAmount(18000) === Math.ceil((18000 + 30) / (1 - 0.029)), 'card amount = fee + 30c grossed up for 2.9%');
ok(idx.includes('Math.ceil((amount_cents + 30) / (1 - 0.029))'), 'formula still identical to TRIGGER mode in index.ts (parity pin)');
ok(P.attemptIdempotencyKey('q1', 'pm_a', '2026-10-20T14:55:00Z') !== P.attemptIdempotencyKey('q1', 'pm_a', '2026-10-20T14:56:00Z'), 'idempotency key differs per request');
ok(!P.attemptIdempotencyKey('q1', 'pm_a', iso(5)).startsWith('dunning-q1'), 'key is not the TRIGGER-mode key dunning-<quote>-<pm> (which replays for ~24h)');
ok(P.isHardDecline('stolen_card') && !P.isHardDecline('insufficient_funds') && !P.isHardDecline(null), 'hard-decline classification');

// ── eligibility
{ const { deps, log } = makeDeps([row()], { results: [SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(out.length === 1 && out[0].outcome === 'charged', 'eligible request: charged');
  ok(log.charges.length === 1 && log.charges[0].method.stripe_pm_id === 'pm_ach1', 'default order: bank account first, one charge');
  ok(log.charges[0].chargeAmountCents === 18000, 'bank account is charged the exact fee');
  ok(log.handled.length === 1 && log.quote[0][1].payment_status === 'succeeded', 'consumed marker written; quote updated');
  ok(log.closed.length === 1, 'success stops the reminder sequence'); }
{ const { deps, log } = makeDeps([row()], { results: [{ status: 'failed', paymentIntentId: null, declineCode: 'card_declined', message: 'x' }, SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 2 && log.charges[1].chargeAmountCents === P.cardChargeAmount(18000) && out[0].outcome === 'charged', 'falls through to the card, which carries the processing fee');
  ok(log.quote[0][1].card_fee_cents === P.cardChargeAmount(18000) - 18000, 'card_fee_cents recorded'); }
{ const { deps, log } = makeDeps([row()], { results: [{ status: 'processing', paymentIntentId: 'pi_p', declineCode: null }] }); const out = await P.runRetryPass(deps);
  ok(out[0].outcome === 'processing' && log.charges.length === 1 && log.closed.length === 0, 'processing: stops after one method, does not close dunning'); }
{ const { deps, log } = makeDeps([row()], { results: [{ status: 'failed', declineCode: 'stolen_card' }, { status: 'failed', declineCode: 'card_declined' }] }); const out = await P.runRetryPass(deps);
  ok(out[0].outcome === 'all_methods_failed' && out[0].hardDeclines === 1 && log.alerts.some((a) => a[0] === 'dunning_retry_hard_decline') && log.closed.length === 0, 'all fail: hard decline alerted, dunning continues'); }

// ── refusals: none may charge
const refuse = async (label, rows, over, reason) => {
  const { deps, log } = makeDeps(rows, over); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0]?.outcome === 'refused' && out[0].reason === reason, `${label}: refused (${reason}), no charge`);
  return log;
};
await refuse('homeowner notice DUE (Ben)', [row({ homeowner_notify_at: iso(1) })], {}, 'homeowner_notice_due');
await refuse('homeowner notice due on the twin row only', [row(), row({ id: 'r2', homeowner_notify_at: iso(1) })], {}, 'homeowner_notice_due');
await refuse('homeowner_notified', [row({ dunning_status: 'homeowner_notified' })], {}, 'dunning_closed');
await refuse('resolved', [row({ dunning_status: 'resolved', resolved_at: iso(3) })], {}, 'dunning_closed');
await refuse('contractor_out', [row({ dunning_status: 'contractor_out', resolved_at: iso(3) })], {}, 'dunning_closed');
await refuse('request older than 24h', [row({ retry_requested_at: iso(25 * 60) })], {}, 'request_expired');
await refuse('no schedule (webhook row alone)', [row({ homeowner_notify_at: null })], {}, 'no_dunning_schedule');
await refuse('quote already paid', [row()], { payStatus: 'succeeded' }, 'quote_payment_succeeded');
await refuse('quote payment pending', [row()], { payStatus: 'pending' }, 'quote_payment_pending');
await refuse('live-charge guard refuses', [row()], { guard: { allow: false, message: 'refused' } }, 'live_charge_guard');
await refuse('no payment method on file', [row()], { methods: { customerId: 'c', methods: [] } }, 'no_payment_method');
await refuse('count over cap (3 per quote)', [row({ retry_request_count: 3 }), row({ id: 'r2', retry_request_count: 2 })], {}, 'over_cap');
await refuse('missing claim', [row({ claim_id: null })], {}, 'missing_quote_claim_or_amount');

// ── at-most-once
{ const { deps, log } = makeDeps([row({ retry_requested_at: iso(5), retry_handled_at: iso(2) })]); const out = await P.runRetryPass(deps);
  ok(out.length === 0 && log.charges.length === 0, 'already handled request is not picked up again'); }
{ const { deps, log } = makeDeps([row({ retry_requested_at: iso(1), retry_handled_at: iso(2) })], { results: [SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(out.length === 1 && log.charges.length === 1, 'a NEW request after a handled one is picked up'); }
{ const { deps, log } = makeDeps([row()], { markWrites: 0 }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].outcome === 'skipped', 'if the consumed marker cannot be written, nothing is charged'); }
{ const order = []; const { deps } = makeDeps([row()], { results: [SUCCESS] });
  const mh = deps.markHandled; deps.markHandled = async (...a) => { order.push('mark'); return mh(...a); };
  const ch = deps.charge; deps.charge = async (...a) => { order.push('charge'); return ch(...a); };
  await P.runRetryPass(deps); ok(order.join(',') === 'mark,charge', 'consumed marker precedes the Stripe call'); }
{ const { deps, log } = makeDeps([row(), row({ id: 'r2' })], { results: [SUCCESS] }); await P.runRetryPass(deps);
  ok(log.charges.length === 1 && log.handled[0][0].length === 2, 'two rows of one quote = one failed payment = one attempt'); }
{ const rows = Array.from({ length: 14 }, (_, i) => row({ id: 'r' + i, quote_id: 'q' + i }));
  const { deps, log } = makeDeps(rows, { results: Array(30).fill(SUCCESS) }); const out = await P.runRetryPass(deps);
  ok(out.filter((o) => o.outcome === 'charged').length === P.MAX_QUOTES_PER_RUN && out.filter((o) => o.outcome === 'skipped').length === 4 && log.charges.length === 10, 'per-run cap of 10 quotes; the rest wait for the next tick'); }

// ── the Stripe request the real wiring sends
const base = { quoteId: 'q1aaaaaaaa', contractorId: 'c1', claimId: 'cl1', customerId: 'cus_1', feeCents: 18000 };
{ let seen = null; const fakeFetch = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ id: 'pi_x', status: 'succeeded' }) }; };
  const res = await S.buildStripeCharge('sk_test_dummy', fakeFetch)({ ...base, method: { stripe_pm_id: 'pm_card1', payment_type: 'card', cpm_id: null }, chargeAmountCents: P.cardChargeAmount(18000), idempotencyKey: 'dunning-retry-q1-pm_card1-1' });
  const body = new URLSearchParams(seen.init.body);
  ok(res.status === 'succeeded' && seen.url === 'https://api.stripe.com/v1/payment_intents', 'POST /v1/payment_intents');
  ok(seen.init.headers['Idempotency-Key'] === 'dunning-retry-q1-pm_card1-1', 'sends the per-attempt idempotency key');
  ok(body.get('off_session') === 'true' && body.get('confirm') === 'true' && body.get('amount') === String(P.cardChargeAmount(18000)) && body.get('metadata[platform_fee_cents]') === '18000' && body.get('metadata[source]') === 'dunning_retry_request', 'form body: off_session, confirm, gross amount, fee metadata'); }
{ const failFetch = async () => ({ ok: false, json: async () => ({ error: { code: 'card_declined', decline_code: 'stolen_card', message: 'm' } }) });
  const res = await S.buildStripeCharge('sk_test_dummy', failFetch)({ ...base, method: { stripe_pm_id: 'pm', payment_type: 'card', cpm_id: null }, chargeAmountCents: 1, idempotencyKey: 'k' });
  ok(res.status === 'failed' && res.declineCode === 'stolen_card', 'decline_code surfaced for the hard-decline check'); }
{ const throwFetch = async () => { throw new Error('network'); };
  const res = await S.buildStripeCharge('k', throwFetch)({ ...base, method: { stripe_pm_id: 'pm', payment_type: 'card', cpm_id: null }, chargeAmountCents: 1, idempotencyKey: 'k' });
  ok(res.status === 'failed', 'network error is a failed attempt, not a crash'); }

// ── static wiring
ok(/DUNNING_RETRY_PASS_ENABLED"\) === "true"/.test(idx), 'index.ts: pass is OFF unless DUNNING_RETRY_PASS_ENABLED=true');
ok(idx.includes('DUNNING_RETRY_PASS_TEST_MODE') && idx.includes('STRIPE_SECRET_KEY_TEST'), 'index.ts: test-mode switch uses the TEST key');
ok(idx.indexOf('runRetryPass(') > idx.indexOf('CRON mode: Scanning') && idx.indexOf('runRetryPass(') < idx.indexOf('PASS 1: Active records'), 'index.ts: pass runs inside CRON mode only');
ok(/catch \(retryErr\)/.test(idx), 'index.ts: a retry-pass failure cannot stop the reminder passes');
for (const f of ['retry-pass.ts', 'retry-pass-supabase.ts']) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); const bad = [];
  lines.forEach((l, i) => { if (l.includes('.update(') && !l.trim().startsWith('//') && !lines.slice(i, i + 10).join('\n').includes('.select(')) bad.push(i + 1); });
  ok(bad.length === 0, `${f}: every .update( chains .select( (gh-2105)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
