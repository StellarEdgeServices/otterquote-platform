/**
 * gh-2442 -- process-dunning retry pass: one charge attempt per recorded request, never more.
 * Runs the real retry-pass.ts / retry-pass-supabase.ts under node type-stripping (Deno is not needed).
 * Negative control: on main these files do not exist, so the import below fails (exit 1).
 * Run: node --experimental-strip-types tests/gh2442-dunning-retry-pass.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.OQ_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    markUnknown: async (ids, attempt) => { log.unknown.push([ids, attempt]); return over.markUnknownWrites ?? ids.length; },
    clearUnknown: async (ids, key) => { log.cleared.push(ids); (log.clearKeys ??= []).push(key); return over.clearWrites ?? ids.length; },
    acquireLease: async () => (over.lease === false ? null : 'tok'),
    releaseLease: async (t) => { log.released = t; },
    markStuckAlerted: async (ids, att, t) => { log.stuck = (log.stuck ?? 0) + 1; return over.stuckCas ?? ids.length; },
    retrieveIntent: async () => over.fresh ?? (log.lastStatus ? { status: log.lastStatus } : { error: 'no intent' }),
    countOpenRows: async () => over.openLeft ?? 1,
    getQuotePaymentStatus: async () => over.payStatus ?? 'failed',
    chargeGuard: async () => over.guard ?? { allow: true, message: '' },
    getChargeMethods: async () => over.methods === undefined
      ? { customerId: 'cus_1', methods: [{ stripe_pm_id: 'pm_ach1', payment_type: 'us_bank_account', cpm_id: 'cpm1' }, { stripe_pm_id: 'pm_card1', payment_type: 'card', cpm_id: 'cpm2' }] }
      : over.methods,
    charge: async (req) => { log.charges.push(req); const r = (over.results ?? [])[log.charges.length - 1] ?? { status: 'failed', paymentIntentId: null, declineCode: 'card_declined', message: 'x' }; log.lastStatus = r.status === 'unknown' ? null : r.status; return r; },
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
  ok(res.status === 'succeeded' && seen.url === '/payment_intents', 'POST /v1/payment_intents');
  ok(seen.init.headers['Idempotency-Key'] === 'dunning-retry-q1-pm_card1-1', 'sends the per-attempt idempotency key');
  ok(body.get('off_session') === 'true' && body.get('confirm') === 'true' && body.get('amount') === String(P.cardChargeAmount(18000)) && body.get('metadata[platform_fee_cents]') === '18000' && body.get('metadata[source]') === 'dunning_retry_request', 'form body: off_session, confirm, gross amount, fee metadata'); }
{ const failFetch = async () => ({ ok: false, status: 402, json: async () => ({ error: { type: 'card_error', code: 'card_declined', decline_code: 'stolen_card', message: 'm' } }) });
  const res = await S.buildStripeCharge('sk_test_dummy', failFetch)({ ...base, method: { stripe_pm_id: 'pm', payment_type: 'card', cpm_id: null }, chargeAmountCents: 1, idempotencyKey: 'k' });
  ok(res.status === 'failed' && res.declineCode === 'stolen_card', 'decline_code surfaced for the hard-decline check'); }

// ── static wiring
ok(fs.readFileSync(path.join(dir, 'retry-pass-supabase.ts'), 'utf8').includes('const STRIPE_API_BASE = "https://api.stripe.com/v1";'), 'Stripe base URL is https://api.stripe.com/v1 (the only host this module calls)');
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

// C1/C2 ruling: an in-doubt attempt is resolved ONLY by replaying the stored request with the SAME key
const REQ = (o = {}) => ({ quoteId: Q, contractorId: 'c1', claimId: 'cl1', customerId: 'cus_1', method: { stripe_pm_id: 'pm_card1', payment_type: 'card', cpm_id: 'c1' }, feeCents: 18000, chargeAmountCents: P.cardChargeAmount(18000), idempotencyKey: 'dunning-retry-KEY-1', requestedAtMs: Date.parse(iso(10)), ...o });
const unk = (o = {}, att = {}) => row({ retry_handled_at: iso(10), retry_unknown_at: iso(10), retry_unknown_attempt: { req: REQ(), attemptedAt: iso(10), ...att }, ...o });
{ const { deps, log } = makeDeps([unk()], { results: [SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 1 && log.charges[0].idempotencyKey === 'dunning-retry-KEY-1', 'replay: the stored request is sent again with the SAME idempotency key');
  ok(out[0].outcome === 'reconciled' && log.quote[0][1].payment_status === 'succeeded' && log.quote[0][1].payment_method_id === 'c1' && log.closed.length === 1 && log.cleared.length === 1, 'replay succeeded -> quote recorded, dunning closed, marker cleared'); }
{ const { deps, log } = makeDeps([unk()], { results: [{ status: 'processing', paymentIntentId: 'pi_p' }] }); await P.runRetryPass(deps);
  ok(log.quote[0][1].payment_status === 'pending' && log.closed.length === 0 && log.cleared.length === 1, 'replay processing -> pending recorded, dunning kept, marker cleared'); }
{ const { deps, log } = makeDeps([unk()], { results: [{ status: 'failed', paymentIntentId: 'pi_d', declineCode: 'generic_decline' }] }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 1 && log.cleared.length === 1 && log.closed.length === 0 && out[0].result === 'declined', 'replay definite decline -> marker cleared, nothing else charged'); }
{ const { deps, log } = makeDeps([unk()], { results: [{ status: 'unknown', message: 'timeout' }] }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'unknown_still_unknown' && log.cleared.length === 0 && log.closed.length === 0, 'replay unknown again -> marker stays'); }
{ const { deps, log } = makeDeps([unk({}, { attemptedAt: iso(23 * 60 + 5) })], { results: [SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].reason === 'unknown_replay_window_closed', 'past 23h: no replay (it could mint a new charge)');
  const al = log.alerts.find((x) => x[0] === 'dunning_retry_unknown_stuck');
  ok(al && al[1].includes('dunning-retry-KEY-1') && /quote_id=/.test(al[1]) && /Verify in Stripe by idempotency key\/metadata before clearing/.test(al[1]) && !/just clear/i.test(al[1]), 'past 23h: alert carries key + metadata and says verify in Stripe before clearing'); }
{ const { deps, log } = makeDeps([unk({}, { attemptedAt: iso(26 * 60) })]); await P.runRetryPass(deps);
  ok(log.alerts.filter((a) => a[0] === 'dunning_retry_unknown_stuck').length === 1 && log.charges.length === 0, 'past 23h with the cron hour missed (26h): the alert still fires, once, no POST'); }
{ const { deps, log } = makeDeps([unk({}, { attemptedAt: iso(26 * 60), stuckAlertedAt: iso(60) })]); await P.runRetryPass(deps);
  ok(log.alerts.length === 0 && log.charges.length === 0, 'already alerted (stored flag): no repeat alert on later ticks'); }
{ const { deps, log } = makeDeps([unk({}, { attemptedAt: iso(26 * 60) })], { stuckCas: 0 }); await P.runRetryPass(deps);
  ok(log.alerts.length === 0, 'overlapping tick lost the flag race: it does not alert a second time'); }
{ const { deps, log } = makeDeps([unk({}, { attemptedAt: iso(23 * 60) })]); await P.runRetryPass(deps);
  ok(log.charges.length === 0, 'exactly 23h counts as closed (>= 23h, not a one-hour window)'); }
{ const { deps, log } = makeDeps([unk({ retry_unknown_attempt: null })]); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].reason === 'unknown_attempt_not_stored' && log.alerts.length === 1, 'marker without a stored attempt: nothing replayed, alert'); }
{ const { deps, log } = makeDeps([unk()], { guard: { allow: false, message: 'refused' }, results: [SUCCESS] }); const out = await P.runRetryPass(deps);
  ok(log.charges.length === 0 && out[0].reason === 'unknown_replay_guard_refused' && log.cleared.length === 0, 'replay is still behind the live-charge guard'); }
{ const { deps, log } = makeDeps([unk({ retry_requested_at: iso(1), retry_handled_at: iso(10) })], { results: [SUCCESS] }); await P.runRetryPass(deps);
  ok(log.charges.length === 1 && log.charges[0].idempotencyKey === 'dunning-retry-KEY-1' && log.charges[0].requestedAtMs === Date.parse(iso(10)), 'a NEWER request never changes the replayed key or request ms (C2)'); }

{ const { deps, log } = makeDeps([unk()], { results: [SUCCESS], fresh: { status: 'processing' } }); await P.runRetryPass(deps);
  ok(log.quote[0][1].payment_status === 'pending' && log.closed.length === 0, 'replay: cached says succeeded but the intent is now processing -> pending recorded (fresh state wins)'); }
{ const { deps, log } = makeDeps([unk()], { results: [{ status: 'processing', paymentIntentId: 'pi_p' }], fresh: { status: 'succeeded' } }); await P.runRetryPass(deps);
  ok(log.quote[0][1].payment_status === 'succeeded' && log.closed.length === 1, 'replay: cached processing, intent now succeeded -> succeeded recorded, dunning closed'); }
{ const { deps, log } = makeDeps([unk()], { results: [{ status: 'processing', paymentIntentId: 'pi_p' }], fresh: { status: 'requires_payment_method' } }); const out = await P.runRetryPass(deps);
  ok(out[0].result === 'declined' && log.quote.length === 0 && log.cleared.length === 1, 'replay: cached processing, intent later failed -> treated as a decline, nothing recorded as paid'); }
{ const { deps, log } = makeDeps([unk()], { results: [SUCCESS], recordOk: false }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'replay_result_not_recorded' && log.cleared.length === 0, 'replay: quote write failed -> marker kept so the next pass records it'); }
{ const { deps, log } = makeDeps([unk()], { results: [SUCCESS], closeWrites: 0, openLeft: 0 }); await P.runRetryPass(deps);
  ok(!log.alerts.some((a) => a[0] === 'gh2105_zero_row_update'), 'overlapping reconcile ticks: a close that finds nothing left open is benign (no false alert)'); }

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
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS], closeWrites: 1, openLeft: 1 }); await P.runRetryPass(deps);
  ok(log.alerts.some((a) => a[0] === 'gh2105_zero_row_update' && /wrote 1 of 2/.test(a[1])), 'B3: short close write raises the zero-row alert'); }
{ const { deps, log } = makeDeps([W(), Sx()], { results: [SUCCESS], recordOk: false }); await P.runRetryPass(deps);
  ok(log.alerts.some((a) => a[0] === 'gh2105_zero_row_update' && /quotes write matched zero rows/.test(a[1])), 'quote write with zero rows raises the alert'); }

// In-memory supabase fake for the real wiring (listCandidateRows two-step read, CAS, close filter, hold lookup, replay)
function fakeSb(tables) {
  const calls = [];
  const col = (r, c) => { const t = c.split(/->>?/); let v = r[t[0]]; for (const k of t.slice(1)) v = v == null ? null : v[k]; return v ?? null; };
  const match = (r, f) => {
    if (f[0] === 'notnull') return col(r, f[1]) != null;
    if (f[0] === 'isnull') return col(r, f[1]) == null;
    if (f[0] === 'gte') return col(r, f[1]) >= f[2];
    if (f[0] === 'lt') return col(r, f[1]) != null && col(r, f[1]) < f[2];
    if (f[0] === 'in') return f[2].includes(col(r, f[1]));
    if (f[0] === 'eq') return col(r, f[1]) === f[2];
    if (f[0] === 'or') return f[1].split(',').some((c) => { const [col, op, ...v] = c.split('.'); const val = v.join('.'); return op === 'is' ? r[col] == null : op === 'lt' ? (r[col] != null && r[col] < val) : op === 'neq' ? r[col] !== val : false; });
    return true;
  };
  return { calls, from(t) {
    const q = { filters: [], upd: null, ins: null }; calls.push([t, q]);
    const run = () => {
      if (!tables[t]) throw new Error('no table ' + t);
      if (q.ins) { const rows = Array.isArray(q.ins) ? q.ins : [q.ins]; rows.forEach((r) => tables[t].push({ ...r })); return rows; }
      const hit = tables[t].filter((r) => q.filters.every((f) => match(r, f)));
      if (q.upd) hit.forEach((r) => Object.assign(r, q.upd));
      return hit.map((r) => ({ ...r }));
    };
    const api = {
      select() { return api; }, update(v) { q.upd = v; return api; }, insert(v) { q.ins = v; return api; }, order() { return api; },
      not(c, op, v) { q.filters.push(['notnull', c]); return api; }, is(c, v) { q.filters.push(['isnull', c]); return api; },
      gte(c, v) { q.filters.push(['gte', c, v]); return api; }, lt(c, v) { q.filters.push(['lt', c, v]); return api; }, in(c, v) { q.filters.push(['in', c, v]); return api; },
      eq(c, v) { q.filters.push(['eq', c, v]); return api; }, or(s2) { q.filters.push(['or', s2]); return api; },
      maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }); }, single() { return Promise.resolve({ data: run()[0] ?? null, error: null }); },
      then(res, rej) { try { res({ data: run(), error: null }); } catch (e) { (rej || (() => { throw e; }))(e); } },
    };
    return api; } };
}
const guardApi = { GUARD_SELECT: 'id', evaluateLiveChargeGuard: () => ({ allow: true }), describeGuardVerdict: () => '' };
const mkTables = () => ({ payment_failures: [
  { ...W(), id: 'W', quote_id: 'qq' }, { ...Sx(), id: 'S', quote_id: 'qq' },
  { ...row({ id: 'X', quote_id: 'other', retry_requested_at: null, retry_request_count: 0 }) } ], quotes: [] });
{ const sb = fakeSb(mkTables()); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, undefined, () => NOW);
  const got = await d.listCandidateRows(new Date(NOW.getTime() - 72 * 3600000).toISOString());
  ok(got.map((r) => r.id).sort().join() === 'S,W', 'B2 wiring: reads the request row AND its quote siblings, not unrelated quotes'); }
{ const t = mkTables(); const sb = fakeSb(t); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, undefined, () => NOW);
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
{ const t = mkTables(); const sb = fakeSb(t); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, undefined, () => NOW);
  const n = await d.closeDunningRows(['W', 'S'], NOW.toISOString());
  const qS = sb.calls.find(([tbl, q]) => q.upd && q.upd.dunning_status === 'resolved')[1];
  ok(n === 2 && qS.filters.some((f) => f[0] === 'in' && f[1] === 'dunning_status'), 'B3 wiring: close only touches open rows and reports the count'); }
{ const t = mkTables(); const sb = fakeSb(t); const d = S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, undefined, () => NOW);
  const ok1 = await d.refundRequest('W', 1); const ok2 = await d.refundRequest('W', 1);
  ok(ok1 === true && ok2 === false && t.payment_failures[0].retry_request_count === 0, 'refund wiring: compare-and-set on the current count, never below 0'); }

// B4 / C3: payment-hold filter
{ const t = { quotes: [{ id: 'qa', payment_status: 'processing' }, { id: 'qb', payment_status: 'pending' }, { id: 'qc', payment_status: 'succeeded' }, { id: 'qd', payment_status: 'failed' }, { id: 'qe', payment_status: null }, { id: 'qf', payment_status: 'dunning' }],
    payment_failures: [{ id: 'f1', quote_id: 'qf', retry_unknown_at: iso(10) }, { id: 'f2', quote_id: 'qd', retry_unknown_at: null }] };
  const held = await H.heldQuoteIds(fakeSb(t), ['qa', 'qb', 'qc', 'qd', 'qe', 'qf', null]);
  ok([...held].sort().join() === 'qa,qb,qc,qf', 'B4/C3: processing, pending, succeeded AND in-doubt (retry_unknown_at) quotes are held; failed/null are not');
  const kept = H.dropHeld([{ id: 1, quote_id: 'qa' }, { id: 2, quote_id: 'qd' }, { id: 3, quote_id: null }, { id: 4, quote_id: 'qf' }], held);
  ok(kept.map((r) => r.id).join() === '2,3', 'B4/C3: held failures are dropped from the reminder / final-warning / homeowner-notice passes'); }

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


// ═════════════ END-TO-END with a simulated Stripe (REVIEW 6276208597 C1, C2) ═════════════
// The simulated Stripe honours idempotency keys exactly like Stripe does: the same key returns the ORIGINAL response
// (even when that response was lost on the wire); a different key makes a new intent. Search lags for intents flagged slow.
function makeStripe(script) {
  const st = { intents: [], byKey: new Map(), posts: [], gets: [], hold: new Map() };
  let seq = 0;
  st.fetchFn = async (url, init) => {
    if (init.method === 'GET' && /\/payment_intents\/pi_/.test(url)) { const i = st.intents.find((x) => url.endsWith(x.id)); return i ? j(200, { id: i.id, status: i.status }) : j(404, {}); }
    if (init.method === 'GET') { // /payment_intents/search : eventually consistent
      st.gets.push(url); const hits = st.intents.filter((i) => !i.slowIndex);
      return j(200, { data: hits.map((i) => ({ id: i.id, status: i.status })) });
    }
    if (!url.endsWith('/payment_intents')) return j(200, {});
    const key = init.headers['Idempotency-Key']; const body = new URLSearchParams(init.body);
    st.posts.push({ key, pm: body.get('payment_method'), body: init.body });
    const nth = st.posts.length; const held = async () => { if (st.hold.has(nth)) await st.hold.get(nth); };
    const prev = st.byKey.get(key);
    if (prev) { if (prev.body !== init.body) return j(400, { error: { type: 'idempotency_error' } }); await held(); return prev.respond(); }
    const act = script(body.get('payment_method'), st.posts.length);
    if (act === 'lost-before') throw new Error('network timeout (request never arrived)');
    const intent = { id: 'pi_' + (++seq), status: act === 'decline' ? 'requires_payment_method' : act === 'processing' ? 'processing' : 'succeeded', amount: Number(body.get('amount')), slowIndex: act === 'ok-lost-slow' };
    st.intents.push(intent);
    const respond = () => intent.status === 'requires_payment_method'
      ? j(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'declined', payment_intent: { id: intent.id, status: intent.status } } })
      : j(200, { id: intent.id, status: intent.status });
    st.byKey.set(key, { body: init.body, respond });
    if (act === 'ok-lost' || act === 'ok-lost-slow') throw new Error('connection reset (response lost)');
    if (act === 'hang-created') return new Promise(() => {}); // the worker is killed / the call outlives the function: never resolves
    await held();
    return respond();
  };
  st.succeeded = () => st.intents.filter((i) => i.status === 'succeeded').length;
  return st;
}
function world(rows, stripe, clock) {
  const t = {
    payment_failures: rows, quotes: [{ id: Q, payment_status: 'dunning' }], claims: [{ id: 'cl1' }],
    contractors: [{ id: 'c1', stripe_customer_id: 'cus_1', stripe_payment_method_id: null }],
    contractor_payment_methods: [
      { id: 'cpm1', contractor_id: 'c1', is_default: true, payment_type: 'card', stripe_payment_method_id: 'pm_card1' },
      { id: 'cpm2', contractor_id: 'c1', is_default: false, payment_type: 'card', stripe_payment_method_id: 'pm_card2' }],
    platform_alerts_log: [], dunning_retry_pass_lease: [{ id: 1, holder: null, locked_until: '1970-01-01T00:00:00.000Z' }],
  };
  const sb = fakeSb(t);
  const mkDeps = () => S.buildRetryPassDeps(sb, 'sk_test_x', guardApi, stripe.fetchFn, () => clock.now);
  return { t, sb, tick: () => P.runRetryPass(mkDeps()), mkDeps };
}
const wr = (clock, o = {}) => ({ ...row({ id: 'W', quote_id: Q, homeowner_notify_at: null, dunning_status: 'active', retry_requested_at: new Date(clock.now.getTime() - 60000).toISOString(), retry_request_count: 1 }), ...o });
const sr = (clock, o = {}) => ({ ...row({ id: 'S', quote_id: Q, dunning_status: 'warning_sent', homeowner_notify_at: new Date(clock.now.getTime() + 20 * 3600000).toISOString(), retry_requested_at: null, retry_request_count: 0 }), ...o });
const adv = (clock, min) => { clock.now = new Date(clock.now.getTime() + min * 60000); };

// C1: method 1 definite decline (pi_1); method 2 succeeds at Stripe but the response is lost AND search would not show it yet
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe((pm) => (pm === 'pm_card1' ? 'decline' : 'ok-lost-slow'));
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const o1 = await w.tick();
  ok(o1[0].outcome === 'unknown' && stripe.succeeded() === 1, 'C1 tick 1: method 2 charged at Stripe, response lost -> unknown (1 succeeded intent)');
  const stored = w.t.payment_failures.find((r) => r.id === 'W').retry_unknown_attempt;
  ok(stored && stored.req.idempotencyKey.includes('pm_card2') && stored.req.method.stripe_pm_id === 'pm_card2', 'C1: the exact in-doubt request (method 2 key) is stored with the marker');
  ok(w.t.quotes[0].payment_status === 'dunning', 'C1: quote not yet recorded');
  adv(clock, 30); const o2 = await w.tick();
  ok(o2[0].outcome === 'reconciled' && o2[0].result === 'succeeded', 'C1 tick 2: replay of the stored key returns the ORIGINAL intent (search never consulted)');
  ok(stripe.gets.length === 0, 'C1: Stripe search is never called');
  ok(w.t.quotes[0].payment_status === 'succeeded' && w.t.quotes[0].payment_intent_id === 'pi_2', 'C1: quote records pi_2');
  ok(w.t.payment_failures.every((r) => r.dunning_status === 'resolved' && r.retry_unknown_at == null), 'C1: every dunning row closed, marker cleared');
  adv(clock, 10); w.t.payment_failures.find((r) => r.id === 'W').retry_requested_at = clock.now.toISOString(); w.t.payment_failures.find((r) => r.id === 'W').retry_request_count = 2;
  const o3 = await w.tick();
  ok(o3[0].outcome === 'refused' && stripe.succeeded() === 1, 'C1 tick 3: the contractor retries again -> refused; still exactly ONE succeeded intent');
  const keys = stripe.posts.map((x) => x.pm + ':' + x.key.slice(-13)); ok(stripe.posts.length === 3, 'C1: total POSTs = 3 (decline, lost-success, replay)'); }

// C2: unknown on method 1; the contractor asks again BEFORE the replay; the key must not move
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok-lost-slow');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick();
  const firstKey = stripe.posts[0].key; const firstStored = JSON.stringify(w.t.payment_failures.find((r) => r.id === 'W').retry_unknown_attempt);
  adv(clock, 5); const W = w.t.payment_failures.find((r) => r.id === 'W'); W.retry_requested_at = clock.now.toISOString(); W.retry_request_count = 2; // a second click got through
  adv(clock, 5);
  const o2 = await w.tick();
  ok(stripe.posts.length === 2 && stripe.posts[1].key === firstKey, 'C2: the replay uses the ORIGINAL key, not one built from the newer request');
  ok(o2[0].outcome === 'reconciled' && stripe.succeeded() === 1, 'C2: original intent recovered; exactly one succeeded intent');
  ok(firstStored.includes(firstKey), 'C2: the stored attempt carried that key all along');
  const o3 = await w.tick(); ok(o3[0].outcome === 'refused' && stripe.succeeded() === 1, 'C2: the newer request is refused (dunning closed), no second charge'); }

// replay itself times out again: marker stays, still one POST per tick, still no other method
{ const clock = { now: new Date(NOW) };
  let n = 0; const stripe = makeStripe(() => 'ok-lost-slow');
  const realFetch = stripe.fetchFn; let failReplay = true;
  stripe.fetchFn = async (u, i) => { if (failReplay && stripe.posts.length >= 1 && u.endsWith('/payment_intents')) { stripe.posts.push({ key: i.headers['Idempotency-Key'], replayLost: true }); throw new Error('timeout again'); } return realFetch(u, i); };
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick(); adv(clock, 30); const o2 = await w.tick();
  ok(o2[0].reason === 'unknown_still_unknown' && w.t.payment_failures.find((r) => r.id === 'W').retry_unknown_at, 'replay times out again -> marker stays set');
  failReplay = false; adv(clock, 30); const o3 = await w.tick();
  ok(o3[0].outcome === 'reconciled' && stripe.succeeded() === 1, 'a later replay resolves it; one succeeded intent in total'); }

// overlapping ticks while an attempt is in doubt
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok-lost-slow');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick(); adv(clock, 30);
  const [a, b] = await Promise.all([w.tick(), w.tick()]);
  ok(stripe.succeeded() === 1 && stripe.posts.slice(1).every((x) => x.key === stripe.posts[0].key), 'overlapping ticks both replay the same key: Stripe still shows ONE succeeded intent'); }

// 24h: past 23h the pass stops replaying and tells a person to verify in Stripe
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok-lost-slow');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick(); adv(clock, 23 * 60 + 5); const before = stripe.posts.length;
  const o = await w.tick();
  ok(o[0].reason === 'unknown_replay_window_closed' && stripe.posts.length === before, 'after 23h: no POST at all');
  const al = w.t.platform_alerts_log.filter((x) => x.alert_type === 'dunning_retry_unknown_stuck');
  ok(al.length === 1 && al[0].message.includes(stripe.posts[0].key) && /Verify in Stripe by idempotency key\/metadata before clearing/.test(al[0].message), 'after 23h: one alert with the key and the verify-before-clearing wording');
  ok(w.t.payment_failures.every((r) => r.retry_unknown_at), 'after 23h: marker is NOT auto-cleared');
  const held = await H.heldQuoteIds(w.sb, [Q]); ok(held.has(Q), 'C3: the quote stays held (no final warning / homeowner notice) while the marker is set'); }

// C3 end to end: an in-doubt quote is held even though quotes.payment_status is still 'dunning'
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'lost-before');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick();
  ok((await H.heldQuoteIds(w.sb, [Q])).has(Q), 'C3: held right after the unknown outcome'); }


// ═════════════ REVIEW 6276858298 D1 / D2: write-ahead ═════════════
const tick0 = () => new Promise((r) => setTimeout(r, 25));
// D1: the worker dies while the POST is in flight; Stripe has already created and charged pi_1
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'hang-created');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  void w.tick(); await tick0(); // this promise never settles: the "worker" is gone
  ok(stripe.posts.length === 1 && stripe.succeeded() === 1, 'D1: POST left the building and Stripe charged (worker then dies)');
  const Wr = w.t.payment_failures.find((r) => r.id === 'W');
  ok(Wr.retry_unknown_at && Wr.retry_unknown_attempt?.req.idempotencyKey === stripe.posts[0].key, 'D1: the marker + exact request were written BEFORE the POST');
  ok((await H.heldQuoteIds(w.sb, [Q])).has(Q), 'D1: the quote is held while the attempt is in doubt');
  adv(clock, 30); const o2 = await w.tick();
  ok(o2[0].outcome === 'reconciled' && stripe.posts.length === 2 && stripe.posts[1].key === stripe.posts[0].key, 'D1: a new worker replays the SAME key');
  ok(stripe.succeeded() === 1 && w.t.quotes[0].payment_status === 'succeeded' && w.t.payment_failures.every((r) => r.dunning_status === 'resolved'), 'D1: exactly ONE succeeded intent, quote recorded, dunning closed');
  adv(clock, 10); Wr.retry_requested_at = clock.now.toISOString(); Wr.retry_request_count = 2;
  await w.tick(); ok(stripe.succeeded() === 1, 'D1: the contractor pressing Retry afterwards charges nothing more'); }

// D2: the marker write does not land -> Stripe is not called at all
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const deps = w.mkDeps(); deps.markUnknown = async () => 0;
  const out = await P.runRetryPass(deps);
  ok(stripe.posts.length === 0 && out[0].reason === 'could_not_write_ahead', 'D2: markUnknown wrote 0 rows -> NO Stripe call');
  ok(w.t.platform_alerts_log.some((a) => a.alert_type === 'dunning_retry_write_ahead_failed'), 'D2: alert raised');
  adv(clock, 20); const Wr = w.t.payment_failures.find((r) => r.id === 'W'); Wr.retry_requested_at = clock.now.toISOString(); Wr.retry_request_count = 2;
  await w.tick(); ok(stripe.succeeded() === 1 && stripe.posts.length === 1, 'D2: the contractor asks again -> one charge, one succeeded intent in total'); }
// D2b: the marker write THROWS (db error) -> still no Stripe call
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const deps = w.mkDeps(); deps.markUnknown = async () => { throw new Error('db down'); };
  let threw = false; try { await P.runRetryPass(deps); } catch { threw = true; }
  ok(stripe.posts.length === 0, 'D2b: a throwing marker write also means no Stripe call (' + (threw ? 'pass aborted' : 'handled') + ')'); }
// after a definite decline, the marker must be cleared before the next method is attempted; if it cannot be, stop
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe((pm) => (pm === 'pm_card1' ? 'decline' : 'ok'));
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const deps = w.mkDeps(); deps.clearUnknown = async () => 0;
  const out = await P.runRetryPass(deps);
  ok(stripe.posts.length === 1 && out[0].reason === 'marker_moved_on' && stripe.succeeded() === 0, 'definite decline + marker cannot be cleared (CAS missed) -> stop, the second method is NOT charged'); }
// decline then success: marker is swapped per method and ends cleared
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe((pm) => (pm === 'pm_card1' ? 'decline' : 'ok'));
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const out = await w.tick();
  ok(out[0].outcome === 'charged' && stripe.succeeded() === 1 && w.t.payment_failures.every((r) => r.retry_unknown_at == null && r.retry_unknown_attempt == null), 'normal path: decline -> next method succeeds -> marker cleared at the end'); }
// timeout seam
{ const src = fs.readFileSync(path.join(dir, 'retry-pass-supabase.ts'), 'utf8');
  const m = src.match(/STRIPE_TIMEOUT_MS = ([0-9_]+)/);
  ok(m && Number(m[1].replace(/_/g, '')) <= 20000 && src.includes('signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)'), 'stripeHttp aborts a hung Stripe call within 20s (becomes unknown)');
  const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError';
  const res = await S.buildStripeCharge('sk_test_x', async () => { throw e; })({ ...base, method: { stripe_pm_id: 'pm', payment_type: 'card', cpm_id: null }, chargeAmountCents: 1, idempotencyKey: 'k', requestedAtMs: 1 });
  ok(res.status === 'unknown', 'a timeout error is classed unknown, not a decline'); }
// N4: columns the contractor can read
ok(!/select\('\*/.test(fs.readFileSync(path.join(root, 'react-app/app/contractor/dashboard/use-dashboard-data.ts'), 'utf8').split("from('payment_failures')")[1]?.slice(0, 80) ?? ''), 'N4: react dashboard selects explicit payment_failures columns');


// ═════════════ REVIEW 6277096279 E1: overlapping ticks must not clear each other's marker ═════════════
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe((pm) => (pm === 'pm_card1' ? 'decline' : 'ok-lost-slow'));
  // gate 1 = tick A's card1 response, gate 2 = tick B's replay response
  let g1, g2; stripe.hold.set(1, new Promise((r) => { g1 = r; })); stripe.hold.set(2, new Promise((r) => { g2 = r; }));
  const w = world([wr(clock), sr(clock)], stripe, clock);
  // The lease would stop tick B from starting at all; this test takes it away to prove the key-CAS holds on its own.
  const depsA = w.mkDeps(); const depsB = w.mkDeps(); depsA.acquireLease = depsB.acquireLease = async () => 'no-lease';
  const A = P.runRetryPass(depsA); await tick0();                     // A: write-ahead card1, POST card1, response held
  ok(stripe.posts.length === 1 && w.t.payment_failures.find((r) => r.id === 'W').retry_unknown_attempt?.req.method.stripe_pm_id === 'pm_card1', 'E1 setup: A is mid-POST on card1 with its marker stored');
  const B = P.runRetryPass(depsB); await tick0();                     // B: reads the card1 marker, replays card1, response held
  ok(stripe.posts.length === 2 && stripe.posts[1].key === stripe.posts[0].key, 'E1 setup: B (stale snapshot) is replaying the card1 key');
  g1();                                                                // A gets the 402, clears card1, write-ahead card2, POSTs card2 (response lost)
  const oA = await A;
  const markerNow = w.t.payment_failures.find((r) => r.id === 'W').retry_unknown_attempt;
  ok(oA[0].outcome === 'unknown' && markerNow?.req.method.stripe_pm_id === 'pm_card2' && stripe.succeeded() === 1, 'E1 setup: A moved on to card2 (charged at Stripe, response lost) with card2 as the live marker');
  g2();                                                                // B now gets the cached card1 decline and tries to clear
  const oB = await B;
  ok(oB[0].reason === 'marker_moved_on', 'E1: B\'s clear compared the card1 key, wrote 0 rows and stopped');
  ok(w.t.payment_failures.every((r) => r.retry_unknown_attempt?.req.method.stripe_pm_id === 'pm_card2'), 'E1: A\'s card2 marker is still on every row');
  ok(!w.t.platform_alerts_log.some((a) => a.alert_type === 'dunning_retry_unknown_resolved'), 'E1: B did not report a resolution it did not make');
  adv(clock, 30); const oC = await w.tick();
  ok(oC[0].outcome === 'reconciled' && stripe.succeeded() === 1 && w.t.quotes[0].payment_status === 'succeeded', 'E1: the next tick replays card2 and records pi_2');
  adv(clock, 5); const Wr = w.t.payment_failures.find((r) => r.id === 'W'); Wr.retry_requested_at = clock.now.toISOString(); Wr.retry_request_count = 2;
  await w.tick(); ok(stripe.succeeded() === 1, 'E1: a later Retry charges nothing: exactly ONE succeeded intent'); }

// run lease
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const dA = w.mkDeps(), dB = w.mkDeps();
  const tokA = await dA.acquireLease(); const tokB = await dB.acquireLease();
  ok(tokA && !tokB, 'lease: a second tick cannot take the lease while the first holds it');
  const outB = await P.runRetryPass(dB); ok(outB[0].reason === 'another_pass_holds_the_lease' && stripe.posts.length === 0, 'lease: the pass does nothing without the lease');
  await dA.releaseLease(tokA); ok(await dB.acquireLease(), 'lease: free again after release');
  adv(clock, 11); ok(await dA.acquireLease(), 'lease: a crashed holder\'s lease expires after the TTL (10 min)'); }
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  w.t.dunning_retry_pass_lease.length = 0; // lease table missing / unreadable -> fail closed
  const out = await w.tick(); ok(out[0].reason === 'another_pass_holds_the_lease' && stripe.posts.length === 0, 'lease: no readable lease row -> the pass is skipped (fails closed)'); }
{ const { deps, log } = makeDeps([row()], { results: [SUCCESS] }); await P.runRetryPass(deps);
  ok(log.released === 'tok', 'lease: released when the pass finishes'); }
{ const { deps, log } = makeDeps([row()], { lease: false }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'another_pass_holds_the_lease' && log.charges.length === 0 && log.handled.length === 0, 'lease held elsewhere: nothing read, nothing charged'); }

// CAS keys on every clear
{ const { deps, log } = makeDeps([row()], { results: [{ status: 'failed', declineCode: 'card_declined' }, SUCCESS] }); await P.runRetryPass(deps);
  ok(log.clearKeys.length === 2 && log.clearKeys.every((k) => k.startsWith('dunning-retry-')) && log.clearKeys[0].includes('pm_ach1') && log.clearKeys[1].includes('pm_card1'), 'every clear is keyed on the idempotency key of the attempt it settles'); }
{ const { deps, log } = makeDeps([unk()], { results: [{ status: 'failed', paymentIntentId: 'pi_d', declineCode: 'x' }], clearWrites: 0 }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'marker_moved_on' && log.alerts.length === 0, 'reconcile: a clear that writes 0 rows stops the tick and says nothing'); }
{ const { deps, log } = makeDeps([unk()], { results: [SUCCESS], clearWrites: 0 }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'marker_moved_on' && !log.alerts.some((a) => a[0] === 'dunning_retry_unknown_resolved'), 'reconcile success path: 0-row clear also stops without a "resolved" alert'); }
{ const { deps, log } = makeDeps([unk()], { results: [SUCCESS], fresh: { error: 'HTTP 500' } }); const out = await P.runRetryPass(deps);
  ok(out[0].reason === 'reconcile_fresh_state_unavailable' && log.quote.length === 0 && log.cleared.length === 0 && log.closed.length === 0, 'N-f: the fresh-state read failed -> nothing recorded and the marker is KEPT'); }
// N1b stuck flag is compare-and-set against the real wiring
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok-lost-slow');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick(); adv(clock, 24 * 60);
  const dA = w.mkDeps(), dB = w.mkDeps(); dA.acquireLease = dB.acquireLease = async () => 'x';
  await Promise.all([P.runRetryPass(dA), P.runRetryPass(dB)]);
  ok(w.t.platform_alerts_log.filter((a) => a.alert_type === 'dunning_retry_unknown_stuck').length === 1, 'N1b: two ticks at 23h+ -> exactly ONE stuck alert (flag is unset->set CAS)'); }
// source pins
{ const src = fs.readFileSync(path.join(dir, 'retry-pass-supabase.ts'), 'utf8');
  ok(/clearUnknown\(rowIds: string\[\], idempotencyKey: string\)/.test(src) && src.includes('.eq("retry_unknown_attempt->req->>idempotencyKey", idempotencyKey)'), 'wiring: clearUnknown is a CAS on the stored idempotency key');
  ok(!/attemptedAt\)\s*\.select/.test(src.split('async clearUnknown')[1]?.split('async acquireLease')[0] ?? ''), 'wiring: clearUnknown does not key on attemptedAt'); }


// ═════════════ REVIEW 6277377025 N-g (TRIGGER gate) and N-h (lease alert) ═════════════
{ // N-g: ACH async failure (TRIGGER mode) arrives while the retry pass holds an in-doubt attempt
  const mkTrigger = (w, stripe, clock, { gated, leaseRequired }) => async () => {
    const gd = S.buildTriggerGateDeps(w.sb, () => clock.now); gd.sleep = async () => {};
    let gate = { proceed: true, release: async () => {} };
    if (gated) gate = await P.gateTrigger(gd, Q, leaseRequired);
    if (!gate.proceed) return { charged: false, reason: gate.reason };
    try { await stripe.fetchFn('/payment_intents', { method: 'POST', headers: { 'Idempotency-Key': 'trigger-' + clock.now.getTime() }, body: 'amount=100&payment_method=pm_card1' }); return { charged: true }; } catch (_) { return { charged: true }; /* response lost: Stripe still saw the POST */ }
    finally { await gate.release(); }
  };
  for (const gated of [false, true]) {
    const clock = { now: new Date(NOW) };
    const stripe = makeStripe(() => 'ok-lost-slow');
    const w = world([wr(clock), sr(clock)], stripe, clock);
    await w.tick();                                   // retry pass: charged at Stripe, response lost, marker stored
    ok(stripe.succeeded() === 1 && w.t.payment_failures.every((r) => r.retry_unknown_at), `N-g setup (gated=${gated}): one succeeded intent, in-doubt marker on every row`);
    const r = await mkTrigger(w, stripe, clock, { gated, leaseRequired: true })();
    adv(clock, 30); await w.tick();                   // the next CRON tick reconciles by replay
    if (!gated) ok(r.charged && stripe.succeeded() === 2, 'N-g negative control: without the gate the webhook TRIGGER makes a SECOND succeeded intent');
    else ok(!r.charged && r.reason === 'unknown_outcome_pending' && stripe.succeeded() === 1 && w.t.quotes[0].payment_status === 'succeeded',
      'N-g: TRIGGER refuses while the quote carries the in-doubt marker -> exactly one succeeded intent');
    if (gated) ok(w.t.platform_alerts_log.some((a) => a.alert_type === 'dunning_trigger_skipped'), 'N-g: the refusal is alerted, not silent');
  }
  // the lease: TRIGGER waits/skips while the retry pass holds it, and takes then releases it otherwise
  const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const gd = S.buildTriggerGateDeps(w.sb, () => clock.now); gd.sleep = async () => {};
  const held = await w.mkDeps().acquireLease();
  const g1 = await P.gateTrigger(gd, Q, true);
  ok(!g1.proceed && g1.reason === 'another_pass_holds_the_lease', 'N-g: TRIGGER skips with a logged reason while the retry pass holds the lease');
  ok(w.t.platform_alerts_log.some((a) => a.alert_type === 'dunning_trigger_skipped' && /lease/.test(a.message)), 'N-g: lease refusal alerted');
  await w.mkDeps().releaseLease(held);
  const g2 = await P.gateTrigger(gd, Q, true);
  ok(g2.proceed, 'N-g: TRIGGER proceeds when the lease is free and no marker');
  ok(!(await w.mkDeps().acquireLease()), 'N-g: ... and holds the lease while it works (the retry pass cannot start)');
  await g2.release(); { const tk = await w.mkDeps().acquireLease(); ok(tk, 'N-g: lease released after the TRIGGER finishes'); await w.mkDeps().releaseLease(tk); }
  const g3 = await P.gateTrigger(gd, Q, false); ok(g3.proceed, 'N-g: with the retry pass disabled the lease is not required (nothing else can charge)');
  const brokenMarker = { ...gd, quoteHasUnknownMarker: async () => 'error' };
  const g4 = await P.gateTrigger(brokenMarker, Q, false); ok(!g4.proceed && g4.reason === 'unknown_marker_unreadable', 'N-g: an unreadable marker read fails closed');
  const thrower = { ...gd, quoteHasUnknownMarker: async () => { throw new Error('boom'); } };
  const g5 = await P.gateTrigger(thrower, Q, true);
  ok(!g5.proceed && g5.reason === 'gate_error', 'N-g: a thrown marker read is a refusal, not an exception');
  ok(await w.mkDeps().acquireLease(), 'N-g: ... and the lease it had taken was released');
  const src = fs.readFileSync(path.join(dir, 'index.ts'), 'utf8');
  const trig = src.slice(src.indexOf('MODE: TRIGGER'), src.indexOf('MODE: CRON'));
  ok(/if \(stripeSecretKey && triggerGate\.proceed && !quoteStatusUnreadable && !quoteSettledBeforeCharge\)/.test(trig) && !/triggerGate\.proceed\)\s*\{\s*return new Response/.test(trig) && trig.indexOf('Create payment_failures record') > trig.indexOf('releaseTriggerGate()'),
    'wiring: only the charge loop is gated; the gate never returns early, dunning setup always follows and the lease is released before it');
}
{ // N-h: unreadable lease raises an alert
  const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  const real = w.sb.from.bind(w.sb);
  w.sb.from = (tb) => (tb === 'dunning_retry_pass_lease' ? { update: () => ({ eq: () => ({ lt: () => ({ select: async () => ({ data: null, error: { message: 'relation does not exist' } }) }) }) }) } : real(tb));
  const out = await w.tick();
  ok(out[0].reason === 'another_pass_holds_the_lease' && stripe.posts.length === 0, 'N-h: unreadable lease -> nothing charged');
  const al = w.t.platform_alerts_log.filter((a) => a.alert_type === 'dunning_retry_lease_unreadable');
  ok(al.length === 1 && /relation does not exist/.test(al[0].message), 'N-h: the unreadable lease raises a platform_alerts_log alert');
}


// ═════════════ REVIEW 6277733088 B2: a TRIGGER whose charge was refused for the lease leaves a system retry request ═════════════
{ const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const fields = P.triggerSystemRetryFields({ proceed: false, reason: 'another_pass_holds_the_lease' }, clock.now.toISOString());
  ok(Object.keys(fields).join() === 'retry_requested_at', 'B2: a lease refusal marks ONLY retry_requested_at (the count is untouched: no cap use)');
  ok(Object.keys(P.triggerSystemRetryFields({ proceed: false, reason: 'unknown_outcome_pending' }, 'x')).length === 0 && Object.keys(P.triggerSystemRetryFields({ proceed: true, release: async () => {} }, 'x')).length === 0, 'B2: no mark for the in-doubt refusal or for a TRIGGER that charged');
  const trig = { ...row({ id: 'T', quote_id: Q, homeowner_notify_at: new Date(clock.now.getTime() + 20 * 3600000).toISOString(), dunning_status: 'active', retry_requested_at: null, retry_request_count: 0 }), ...fields };
  const w = world([trig], stripe, clock);
  adv(clock, 1);
  const o1 = await w.tick();
  ok(stripe.succeeded() === 1 && w.t.quotes[0].payment_status === 'succeeded', 'B2: lease held + working card -> the next CRON tick charges it: exactly 1 succeeded intent');
  adv(clock, 5); await w.tick(); ok(stripe.succeeded() === 1, 'B2: and a further tick charges nothing more');
  ok(!w.t.payment_failures.some((r) => (r.retry_request_count ?? 0) > 0), 'B2: the contractor cap of 3 was not consumed'); }


// refunded is terminal
{ ok(P.PAYMENT_HOLD_STATUSES.includes('refunded'), 'refunded is in the payment-hold statuses');
  const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  w.t.quotes[0].payment_status = 'refunded';
  const out = await w.tick();
  ok(stripe.posts.length === 0 && out[0].outcome === 'refused' && out[0].reason === 'quote_payment_refunded', 'refunded quote: the retry pass refuses and makes no Stripe call');
  const held = await H.heldQuoteIds(w.sb, [Q]); ok(held.has(Q), 'refunded quote: reminders/notices are held'); }


// ═════════════ REVIEW 6278287285: N-p (never write success over refunded), N-r (own alert for unreadable claim) ═════════════
{ // I5: an in-doubt attempt is resolved by replay as succeeded, but the quote was refunded meanwhile
  const clock = { now: new Date(NOW) };
  const stripe = makeStripe(() => 'ok-lost-slow');
  const w = world([wr(clock), sr(clock)], stripe, clock);
  await w.tick();
  ok(stripe.succeeded() === 1 && w.t.payment_failures.every((r) => r.retry_unknown_at), 'N-p setup: charged at Stripe, response lost, marker stored');
  w.t.quotes[0].payment_status = 'refunded'; adv(clock, 30);
  const posts0 = stripe.posts.length;
  const out = await w.tick();
  ok(stripe.posts.length === posts0 && stripe.succeeded() === 1, 'refunded + in-doubt marker: 0 Stripe POSTs (no replay)');
  ok(w.t.quotes[0].payment_status === 'refunded', 'N-p (I5): status stays refunded');
  ok(w.t.payment_failures.every((r) => r.retry_unknown_at), 'marker KEPT (never auto-cleared)');
  const al = w.t.platform_alerts_log.filter((a) => a.alert_type === 'dunning_retry_unknown_on_refunded_quote');
  ok(al.length === 1 && /URGENT/.test(al[0].message) && /idempotency key dunning-retry-/.test(al[0].message) && /metadata quote_id=/.test(al[0].message) && /refund if a charge exists/.test(al[0].message), 'exactly one URGENT manual-reconciliation alert with the idempotency key and metadata');
  ok(out[0].reason === 'unknown_on_refunded_quote_manual_reconcile', 'outcome is the manual-reconcile skip');
  for (let i = 0; i < 3; i++) { adv(clock, 30); await w.tick(); }
  ok(stripe.posts.length === posts0 && w.t.platform_alerts_log.filter((a) => a.alert_type === 'dunning_retry_unknown_on_refunded_quote').length === 1 && w.t.payment_failures.every((r) => r.retry_unknown_at), 'later ticks: still 0 POSTs, still ONE alert, marker still kept'); }
{ // the supabase write itself is a CAS
  const t = { quotes: [{ id: Q, payment_status: 'refunded' }, { id: 'q2', payment_status: null }] };
  const d = S.buildRetryPassDeps(fakeSb(t), 'sk_test_x', guardApi, undefined, () => NOW);
  ok(!(await d.recordQuoteResult(Q, { payment_status: 'succeeded' })) && t.quotes[0].payment_status === 'refunded', 'N-p: recordQuoteResult refuses to touch a refunded quote');
  ok(await d.recordQuoteResult('q2', { payment_status: 'succeeded' }) && t.quotes[1].payment_status === 'succeeded', 'N-p: ... and still writes a NULL-status quote'); }
{ const { deps, log } = makeDeps([row()], {}); deps.chargeGuard = async () => ({ allow: false, message: 'm', reason: 'claim_unreadable' }); await P.runRetryPass(deps);
  ok(log.alerts.some((a) => a[0] === 'platform_fee_refused_claim_unreadable') && !log.alerts.some((a) => a[0] === 'platform_fee_refused_unauthorized_test'), 'N-r: the retry pass uses the distinct unreadable-claim alert'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
