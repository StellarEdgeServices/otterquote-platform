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
const H = await import(path.join(dir, 'payment-hold.ts'));
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
  const log = { handled: [], charges: [], quote: [], closed: [], alerts: [], refunds: [], unknown: [], cleared: [] };
  const deps = {
    now: () => NOW,
    listCandidateRows: async () => rows,
    markHandled: async (ids, t, req) => { log.handled.push([ids, t, req]); return over.markWrites ?? ids.length; },
    refundRequest: async (id, n) => { log.refunds.push([id, n]); return true; },
    markUnknown: async (ids) => { log.unknown.push(ids); return ids.length; },
    clearUnknown: async (ids) => { log.cleared.push(ids); return ids.length; },
    lookupIntent: async () => over.lookup ?? { found: false },
    getQuotePaymentStatus: async () => over.payStatus ?? 'failed',
    chargeGuard: async () => over.guard ?? { allow: true, message: '' },
    getChargeMethods: async () => over.methods === undefined
      ? { customerId: 'cus_1', methods: [{ stripe_pm_id: 'pm_ach1', payment_type: 'us_bank_account', cpm_id: 'cpm1' }, { stripe_pm_id: 'pm_card1', payment_type: 'card', cpm_id: 'cpm2' }] }
      : over.methods,
    charge: async (req) => { log.charges.push(req); return (over.results ?? [])[log.charges.length - 1] ?? { status: 'failed', paymentIntentId: null, declineCode: 'card_declined', message: 'x' }; },
    recordQuoteResult: async (q, u) => { log.quote.push([q, u]); return over.recordOk ?? true; },
    closeDunningRows: async (ids) => { log.closed.push(ids); return over.closeWrites ?? ids.length; },
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
{ const failFetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { type: 'card_error', code: 'card_declined', decline_code: 'stolen_card', message: 'm' } }) });
  const res = await S.buildStripeCharge('sk_test_dummy', failFetch)({ ...base, method: { stripe_pm_id: 'pm', payment_type: 'card', cpm_id: null }, chargeAmountCents: 1, idempotencyKey: 'k' });
  ok(res.status === 'failed' && res.declineCode === 'stolen_card', 'decline_code surfaced for the hard-decline check'); }

// ── static wiring
ok(/DUNNING_RETRY_PASS_ENABLED"\) === "true"/.test(idx), 'index.ts: pass is OFF unless DUNNING_RETRY_PASS_ENABLED=true');
ok(idx.includes('selectRetryStripeKey(getEnv)') && !idx.includes('DUNNING_RETRY_PASS_TEST_MODE'), 'index.ts: key comes from selectRetryStripeKey (test mode default)');
ok(idx.includes('dropHeld(activeFailures || [], heldActive)') && idx.includes('dropHeld(warnedFailures || [], heldWarned)'), 'index.ts: PASS 1 and PASS 2 both skip quotes that are paid or in flight (B4)');
ok(idx.indexOf('runRetryPass(') > idx.indexOf('CRON mode: Scanning') && idx.indexOf('runRetryPass(') < idx.indexOf('PASS 1: Active records'), 'index.ts: pass runs inside CRON mode only');
ok(/catch \(retryErr\)/.test(idx), 'index.ts: a retry-pass failure cannot stop the reminder passes');
for (const f of ['retry-pass.ts', 'retry-pass-supabase.ts']) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n'); const bad = [];
  lines.forEach((l, i) => { if (l.includes('.update(') && !l.trim().startsWith('//') && !lines.slice(i, i + 10).join('\n').includes('.select(')) bad.push(i + 1); });
  ok(bad.length === 0, `${f}: every .update( chains .select( (gh-2105)`);
}


// ═════════════ REVIEW 6275827939 fixes ═════════════
const Q = '11111111-1111-4111-8111-111111111111';
const methods2 = { customerId: 'cus_1', methods: [{ stripe_pm_id: 'pm_card1', payment_type: 'card', cpm_id: 'c1' }, { stripe_pm_id: 'pm_card2', payment_type: 'card', cpm_id: 'c2' }] };
const j = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// B1: unknown outcome -> exactly ONE POST, no fallback to the next method, marked unknown, dunning not closed
for (const [label, mk] of [
  ['thrown fetch (timeout)', () => { throw new Error('network timeout'); }],
  ['HTTP 500', () => j(500, { error: { message: 'boom' } })],
  ['HTTP 409', () => j(409, { error: { code: 'idempotency_key_in_use' } })],
  ['HTTP 429', () => j(429, { error: { code: 'rate_limit' } })],
  ['non-JSON body', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } })],
  ['HTTP 200 with an unexpected status', () => j(200, { id: 'pi_q', status: 'requires_capture' })],
]) {
  const posts = [];
  const fakeFetch = async (url, init) => { posts.push([url, init]); return mk(); };
  const { deps, log } = makeDeps([row()], { methods: methods2 });
  deps.charge = S.buildStripeCharge('sk_test_dummy', fakeFetch);
  const out = await P.runRetryPass(deps);
  ok(posts.filter(([u]) => u.endsWith('/payment_intents')).length === 1, `B1 ${label}: exactly one POST (no second method)`);
  ok(out[0]?.outcome === 'unknown' && log.unknown.length === 1 && log.closed.length === 0 && log.quote.length === 0, `B1 ${label}: outcome unknown, marker written, dunning not closed`);
  ok(log.alerts.some((a) => a[0] === 'dunning_retry_unknown_outcome'), `B1 ${label}: alert raised`);
}
{ const posts = [];
  const fakeFetch = async (url, init) => { posts.push(url); return posts.length === 1 ? j(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'declined' } }) : j(200, { id: 'pi_ok', status: 'succeeded' }); };
  const { deps, log } = makeDeps([row()], { methods: methods2 }); deps.charge = S.buildStripeCharge('sk_test_dummy', fakeFetch);
  const out = await P.runRetryPass(deps);
  ok(posts.length === 2 && out[0].outcome === 'charged', 'B1 control: a DEFINITE 402 card_error still falls through to the next method'); }

// B1: reconciliation of an unknown marker (never charges)
const unk = (o = {}) => row({ retry_handled_at: iso(10), retry_unknown_at: iso(10), ...o });
{ const { deps, log } = makeDeps([unk()], { lookup: { found: true, id: 'pi_r', status: 'succeeded' } }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].outcome === 'reconciled' && log.quote[0][1].payment_status === 'succeeded' && log.closed.length === 1 && log.cleared.length === 1, 'reconcile: intent found succeeded -> quote recorded, dunning closed, marker cleared, no charge'); }
{ const { deps, log } = makeDeps([unk()], { lookup: { found: true, id: 'pi_r', status: 'processing' } }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && log.quote[0][1].payment_status === 'pending' && log.closed.length === 0, 'reconcile: processing -> pending recorded, dunning not closed'); }
{ const { deps, log } = makeDeps([unk()], { lookup: { found: true, id: 'pi_r', status: 'requires_payment_method' } }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && log.cleared.length === 1 && out[0].result.startsWith('not_charged'), 'reconcile: definite no-charge clears the marker, still no automatic re-charge'); }
{ const { deps, log } = makeDeps([unk()], { lookup: { found: false } }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].reason === 'unknown_awaiting_reconciliation' && log.cleared.length === 0 && log.alerts.length === 0, 'reconcile: nothing found yet -> wait, no charge, marker kept'); }
{ const { deps, log } = makeDeps([unk({ retry_unknown_at: iso(3 * 60) })], { lookup: { found: false } }); await P.runRetryPass(deps);
  ok(log.charges.length === 0 && log.alerts.some((a) => a[0] === 'dunning_retry_unknown_stuck'), 'reconcile: still nothing after 2h -> escalated, still no charge'); }
{ const { deps, log } = makeDeps([unk({ retry_requested_at: iso(1) })], { lookup: { error: 'HTTP 500' } }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].reason === 'reconcile_lookup_failed', 'reconcile: lookup error -> no charge'); }
{ const { deps, log } = makeDeps([unk({ retry_requested_at: iso(1), retry_handled_at: iso(10) })], { lookup: { found: false } }); await P.runRetryPass(deps);
  ok(log.charges.length === 0, 'a NEWER request on a quote with an unreconciled marker is still not charged'); }

// B2: the whole quote's rows are read; a request on the webhook row W while the scheduled row S is warning_sent is SERVED
const W = (o = {}) => row({ id: 'W', homeowner_notify_at: null, dunning_status: 'active', retry_requested_at: iso(5), retry_request_count: 1, ...o });
const Sx = (o = {}) => row({ id: 'S', dunning_status: 'warning_sent', homeowner_notify_at: inH(10), retry_requested_at: null, retry_request_count: 0, ...o });
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(out[0].outcome === 'charged' && log.charges.length === 1, 'B2: request on W, S warning_sent: served (not no_dunning_schedule)'); }
{ const { deps, log } = makeDeps([W(), Sx({ homeowner_notify_at: iso(1) })]); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'homeowner_notice_due' && log.charges.length === 0, 'B2: notice due on S refuses a request that sits on W'); }
// B2: a refusal gives the request back; a charge attempt does not
{ const { deps, log } = makeDeps([W({ retry_request_count: 2 }), Sx({ homeowner_notify_at: iso(1) })]); await P.runRetryPass(deps);
  ok(log.refunds.length === 1 && log.refunds[0][0] === 'W' && log.refunds[0][1] === 2, 'B2: refusal refunds exactly one request on the carrying row'); }
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS] }); await P.runRetryPass(deps);
  ok(log.refunds.length === 0, 'B2: a real charge attempt keeps the request counted'); }
{ const { deps, log } = makeDeps([W(), Sx()], { markWrites: 0 }); await P.runRetryPass(deps);
  ok(log.refunds.length === 0 && log.charges.length === 0, 'B2: lost compare-and-set -> no refund, no charge'); }
{ const { deps, log } = makeDeps([W(), Sx()], { payStatus: 'processing' }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'quote_payment_processing' && log.charges.length === 0 && log.refunds.length === 1, 'quote payment_status processing refuses and refunds'); }

// B3: success closes EVERY open row of the quote; a short write alerts
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS] }); await P.runRetryPass(deps);
  ok(log.closed.length === 1 && log.closed[0].slice().sort().join() === 'S,W', 'B3: success closes W and S (every open row of the quote)'); }
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS], closeWrites: 1 }); await P.runRetryPass(deps);
  ok(log.alerts.some((a) => a[0] === 'gh2105_zero_row_update' && /wrote 1 of 2/.test(a[1])), 'B3: short close write raises the zero-row alert'); }
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS], recordOk: false }); await P.runRetryPass(deps);
  ok(log.alerts.some((a) => a[0] === 'gh2105_zero_row_update' && /quotes write matched zero rows/.test(a[1])), 'quote write with zero rows raises the alert'); }

// In-memory supabase fake for the real wiring (listCandidateRows two-step read, CAS, close filter, hold lookup)
function fakeSb(tables) {
  const calls = [];
  const match = (r, f) => {
    if (f[0] === 'notnull') return r[f[1]] != null;
    if (f[0] === 'gte') return r[f[1]] >= f[2];
    if (f[0] === 'in') return f[2].includes(r[f[1]]);
    if (f[0] === 'eq') return r[f[1]] === f[2];
    if (f[0] === 'or') return f[1].split(',').some((c) => { const [col, op, ...v] = c.split('.'); const val = v.join('.'); return op === 'is' ? r[col] == null : op === 'lt' ? (r[col] != null && r[col] < val) : false; });
    return true;
  };
  return { calls, from(t) {
    const q = { filters: [], upd: null }; calls.push([t, q]);
    const api = {
      select() { return api; }, update(v) { q.upd = v; return api; },
      not(c, op, v) { q.filters.push(['notnull', c]); return api; }, gte(c, v) { q.filters.push(['gte', c, v]); return api; },
      in(c, v) { q.filters.push(['in', c, v]); return api; }, eq(c, v) { q.filters.push(['eq', c, v]); return api; }, or(s) { q.filters.push(['or', s]); return api; },
      then(res, rej) { try { const hit = tables[t].filter((r) => q.filters.every((f) => match(r, f))); if (q.upd) hit.forEach((r) => Object.assign(r, q.upd)); res({ data: hit.map((r) => ({ ...r })), error: null }); } catch (e) { (rej || (() => { throw e; }))(e); } },
    };
    return api; } };
}
const guardApi = { GUARD_SELECT: 'id', evaluateLiveChargeGuard: () => ({ allow: true }), describeGuardVerdict: () => '' };
const mkTables = () => ({ payment_failures: [
  { ...W(), id: 'W', quote_id: 'qq' }, { ...Sx(), id: 'S', quote_id: 'qq' },
  { ...row({ id: 'X', quote_id: 'other', retry_requested_at: null, retry_request_count: 0 }) } ], quotes: [] });
{ const sb = fakeSb(mkTables()); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, fetch, () => NOW);
  const got = await d.listCandidateRows(new Date(NOW.getTime() - 72 * 3600000).toISOString());
  ok(got.map((r) => r.id).sort().join() === 'S,W', 'B2 wiring: reads the request row AND its quote siblings, not unrelated quotes'); }
{ const t = mkTables(); const sb = fakeSb(t); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, fetch, () => NOW);
  const reqIso = t.payment_failures[0].retry_requested_at;
  const first = await d.markHandled(['W', 'S'], NOW.toISOString(), reqIso);
  const second = await d.markHandled(['W', 'S'], NOW.toISOString(), reqIso);
  ok(first === 2 && second === 0, 'N2 wiring: markHandled is compare-and-set (second overlapping call writes 0 rows)'); }
{ // two overlapping ticks over the same shared state -> one charge
  const shared = [W(), Sx()]; let handled = null;
  const mk = () => { const { deps, log } = makeDeps(shared.map((r) => ({ ...r })), { results: [SUCCESS] });
    deps.markHandled = async (ids) => { if (handled) return 0; handled = true; return ids.length; }; return { deps, log }; };
  const a = mk(), b = mk(); await Promise.all([P.runRetryPass(a.deps), P.runRetryPass(b.deps)]);
  ok(a.log.charges.length + b.log.charges.length === 1, 'N2: two overlapping ticks charge once'); }
{ const t = mkTables(); const sb = fakeSb(t); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, fetch, () => NOW);
  const n = await d.closeDunningRows(['W', 'S'], NOW.toISOString());
  const qS = sb.calls.find(([tbl, q]) => q.upd && q.upd.dunning_status === 'resolved')[1];
  ok(n === 2 && qS.filters.some((f) => f[0] === 'in' && f[1] === 'dunning_status'), 'B3 wiring: close only touches open rows and reports the count'); }
{ const t = mkTables(); const sb = fakeSb(t); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, fetch, () => NOW);
  const ok1 = await d.refundRequest('W', 1); const ok2 = await d.refundRequest('W', 1);
  ok(ok1 === true && ok2 === false && t.payment_failures[0].retry_request_count === 0, 'refund wiring: compare-and-set on the current count, never below 0'); }

// B4: payment-hold filter
{ const t = { quotes: [{ id: 'qa', payment_status: 'processing' }, { id: 'qb', payment_status: 'pending' }, { id: 'qc', payment_status: 'succeeded' }, { id: 'qd', payment_status: 'failed' }, { id: 'qe', payment_status: null }] };
  const held = await H.heldQuoteIds(fakeSb(t), ['qa', 'qb', 'qc', 'qd', 'qe', null]);
  ok([...held].sort().join() === 'qa,qb,qc', 'B4: processing, pending and succeeded quotes are held; failed/null are not');
  const kept = H.dropHeld([{ id: 1, quote_id: 'qa' }, { id: 2, quote_id: 'qd' }, { id: 3, quote_id: null }], held);
  ok(kept.map((r) => r.id).join() === '2,3', 'B4: held failures are dropped from the reminder / homeowner-notice passes'); }

// N1: test mode is the default even when enabled
{ const env = (o) => (n) => o[n];
  let r = P.selectRetryStripeKey(env({ STRIPE_SECRET_KEY_TEST: 'sk_test_a', STRIPE_SECRET_KEY: 'sk_live_a' }));
  ok(r.ok && r.mode === 'test' && r.key === 'sk_test_a', 'N1: ENABLED alone = test key only');
  r = P.selectRetryStripeKey(env({ STRIPE_SECRET_KEY: 'sk_live_a' })); ok(!r.ok, 'N1: no test key -> skipped, never falls back to live');
  r = P.selectRetryStripeKey(env({ STRIPE_SECRET_KEY_TEST: 'sk_live_a' })); ok(!r.ok, 'N1: test mode refuses a non-test key');
  r = P.selectRetryStripeKey(env({ DUNNING_RETRY_PASS_LIVE: 'true', STRIPE_SECRET_KEY: 'sk_live_a' })); ok(r.ok && r.mode === 'live', 'N1: live needs the explicit LIVE flag');
  r = P.selectRetryStripeKey(env({ DUNNING_RETRY_PASS_LIVE: 'true', STRIPE_SECRET_KEY: 'sk_test_a' })); ok(!r.ok, 'N1: live mode refuses a test key');
  r = P.selectRetryStripeKey(env({ DUNNING_RETRY_PASS_LIVE: 'yes', STRIPE_SECRET_KEY: 'sk_live_a', STRIPE_SECRET_KEY_TEST: 'sk_test_a' })); ok(r.ok && r.mode === 'test', 'N1: only the exact string "true" goes live'); }

// B5: schema contract declaration
{ const pend = JSON.parse(fs.readFileSync(path.join(root, 'sql/schema-pending.json'), 'utf8'));
  ok(pend.payment_failures?.retry_handled_at && pend.payment_failures?.retry_unknown_at, 'B5: sql/schema-pending.json declares retry_handled_at and retry_unknown_at');
  ok(fs.existsSync(path.join(root, pend.payment_failures.retry_handled_at.migration)), 'B5: the named migration file exists'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
