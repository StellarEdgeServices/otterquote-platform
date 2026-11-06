/**
 * gh-3356 -- the static measurement checkout handles create-payment-intent's refusal to sell a second report on a paid claim.
 *   C1  Services.createHoverPaymentIntent turns the 409 MEASUREMENT_ALREADY_PAID / 503 MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE / 503 MEASUREMENT_PAYMENT_CANNOT_START answers into
 *       {client_secret: null, refused: true, code}; every other failure is still the old placeholder; a success is untouched.
 *   C2  the REAL showMeasurementRefusal() from help-measurements.html: already paid -> Purchase button hidden, plain message, no card form;
 *       check unavailable -> button kept (re-enabled) and a retry message; cannot start (cancelled replay) -> button kept and its own sentence.
 *   C3  purchaseHover() checks `refused` BEFORE it reads client_secret, and nothing on the refusal path mounts Stripe elements.
 *   C4  the claims.hover_paid / hover_order_id / hover_status columns are not written by any code, so the page does not gate on them.
 *   C5  the REAL confirmHoverPayment(): a CANCELLED PaymentIntent gets the plain reload sentence, Pay stays disabled, no order. An error whose
 *       payment_intent.status is 'succeeded' (the card WAS charged) runs the normal order step with that intent's id and shows the normal
 *       success screen; if payment_intent is absent or unreadable the page fails safe to the reload sentence.
 *   C6  editing the card field after the dead-intent message keeps the explanation visible and Pay disabled (the REAL purchaseHover handler).
 * Negative control: main's services.js (the catch that returns only the placeholder) fails C1.
 * Run: node tests/gh3356-hover-refusal-client.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'help-measurements.html'), 'utf8');
const services = fs.readFileSync(path.join(root, 'js', 'services.js'), 'utf8');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

function extractFn(src, name) {
  const m = new RegExp('(?:async )?function ' + name + '\\(').exec(src);
  if (!m) return null;
  let d = 0;
  for (let k = src.indexOf('{', m.index); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(m.index, k + 1); }
  }
  return null;
}

async function loadServices(src, invoke) {
  const ctx = { sb: { functions: { invoke } }, console: { warn() {}, log() {}, error() {} } };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__S = Services;', ctx);
  return ctx.__S;
}
const PARAMS = { claim_id: 'c1', amount: 2263, description: 'Complete Property Report' };
// what supabase-js hands back for a non-2xx: { data: null, error: FunctionsHttpError } whose .context is the Response
const httpError = (status, body) => ({ data: null, error: Object.assign(new Error('Edge Function returned a non-2xx status code'), { context: { status, json: async () => body } }) });

async function c1(src, label) {
  const paid = await (await loadServices(src, async () => httpError(409, { error: 'x', code: 'MEASUREMENT_ALREADY_PAID' }))).createHoverPaymentIntent(PARAMS);
  const unavailable = await (await loadServices(src, async () => httpError(503, { error: 'x', code: 'MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE' }))).createHoverPaymentIntent(PARAMS);
  const cannotStart = await (await loadServices(src, async () => httpError(503, { error: 'x', code: 'MEASUREMENT_PAYMENT_CANNOT_START' }))).createHoverPaymentIntent(PARAMS);
  const other = await (await loadServices(src, async () => httpError(500, { error: 'boom' }))).createHoverPaymentIntent(PARAMS);
  const unknownCode = await (await loadServices(src, async () => httpError(422, { code: 'SOMETHING_ELSE' }))).createHoverPaymentIntent(PARAMS);
  const network = await (await loadServices(src, async () => { throw new TypeError('offline'); })).createHoverPaymentIntent(PARAMS);
  const success = await (await loadServices(src, async () => ({ data: { client_secret: 'cs_1', payment_intent_id: 'pi_1' }, error: null }))).createHoverPaymentIntent(PARAMS);
  return {
    refusedPaid: paid.refused === true && paid.code === 'MEASUREMENT_ALREADY_PAID' && paid.client_secret === null,
    refusedUnavailable: unavailable.refused === true && unavailable.code === 'MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE',
    refusedCannotStart: cannotStart.refused === true && cannotStart.code === 'MEASUREMENT_PAYMENT_CANNOT_START' && cannotStart.client_secret === null,
    othersUnchanged: [other, unknownCode, network].every((r) => r.placeholder === true && r.client_secret === null && !r.refused),
    successUnchanged: success.client_secret === 'cs_1' && !success.refused,
  };
}
const r = await c1(services, 'shipped');
ok(r.refusedPaid, 'C1 a 409 MEASUREMENT_ALREADY_PAID becomes {refused: true, code, client_secret: null}');
ok(r.refusedUnavailable, 'C1 a 503 MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE becomes {refused: true, code}');
ok(r.refusedCannotStart, 'C1 a 503 MEASUREMENT_PAYMENT_CANNOT_START becomes {refused: true, code}');
ok(r.othersUnchanged, 'C1 any other failure (500, an unknown code, a network error) is still the old placeholder, not a refusal');
ok(r.successUnchanged, 'C1 a success still returns the client_secret untouched');

// negative control: the pre-fix wrapper. An inline copy of main's catch at a5e52ec8 (no origin/main read, so it cannot go red when this
// merges): the same shipped file with the gh-3356 block cut out of the catch, which leaves exactly the old catch.
const OLD_CATCH = "} catch (err) {\n      console.warn('Stripe Edge function not deployed:', err);\n      return { client_secret: null, placeholder: true };\n    }";
const NEW_CATCH_RE = /\} catch \(err\) \{\s*\/\/ gh-3356:[\s\S]*?return \{ client_secret: null, placeholder: true \};\s*\}/;
const preFixServices = services.replace(NEW_CATCH_RE, OLD_CATCH);
ok(preFixServices !== services && !preFixServices.includes('gh-3356') && preFixServices.includes(OLD_CATCH), 'NC setup: the pre-fix wrapper is the shipped file with only the gh-3356 catch block replaced by the old catch');
{
  const m = await c1(preFixServices, 'pre-fix');
  ok(!m.refusedPaid && !m.refusedUnavailable && !m.refusedCannotStart && m.successUnchanged, "NC: the pre-fix wrapper loses the refusal (placeholder only), so C1 fails against it");
}

// C2
const showSrc = extractFn(html, 'showMeasurementRefusal');
ok(!!showSrc, 'C2 help-measurements.html defines showMeasurementRefusal');
function runShow(code) {
  const messages = [];
  const btn = { style: { display: '' }, disabled: true, innerHTML: 'Loading' };
  const ctx = { showMessage: (t, ty) => messages.push([t, ty]) };
  vm.createContext(ctx);
  vm.runInContext(/var MEASUREMENT_CANNOT_START_MESSAGE = '[^']*';/.exec(html)[0] + '\n' + showSrc + '\n;globalThis.__show = showMeasurementRefusal;', ctx);
  ctx.__show(code, btn, 'Purchase Aerial Roof Report');
  return { btn, messages };
}
if (showSrc) {
  const PAID_TEXT = 'Our records show a payment for the Aerial Roof Report on this project, so we did not start another one. This attempt did not charge your card. If you have a question about your report or a charge, contact support.';
  const UNAVAILABLE_TEXT = 'We could not check your payment history just now, so we did not start a payment. This attempt did not charge your card. Please try again in a few minutes.';
  const paid = runShow('MEASUREMENT_ALREADY_PAID');
  ok(paid.btn.style.display === 'none', 'C2 already paid: the Purchase button is hidden');
  ok(paid.messages.length === 1 && paid.messages[0][1] === 'error' && paid.messages[0][0] === PAID_TEXT, 'C2 already paid: exactly the approved sentence, as an error message');
  const unavailable = runShow('MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE');
  ok(unavailable.btn.style.display === '' && unavailable.btn.disabled === false && unavailable.btn.innerHTML === 'Purchase Aerial Roof Report', 'C2 unavailable: the button stays and is usable again');
  ok(unavailable.messages.length === 1 && unavailable.messages[0][1] === 'error' && unavailable.messages[0][0] === UNAVAILABLE_TEXT, 'C2 unavailable: exactly the approved sentence, as an error message');
  // the cancelled-replay sentence (proposed in the PR body for the legal read): its own words, no statement about a charge, support if it persists
  const CANNOT_START_TEXT = 'We could not start a payment for the Aerial Roof Report just now. Please try again later. If this keeps happening, contact support.';
  const cannot = runShow('MEASUREMENT_PAYMENT_CANNOT_START');
  ok(cannot.btn.style.display === '' && cannot.btn.disabled === false && cannot.btn.innerHTML === 'Purchase Aerial Roof Report', 'C2 cannot start: the button stays and is usable again');
  ok(cannot.messages.length === 1 && cannot.messages[0][1] === 'error' && cannot.messages[0][0] === CANNOT_START_TEXT, 'C2 cannot start: exactly its own sentence, as an error message');
  ok(cannot.messages[0][0] !== UNAVAILABLE_TEXT && !/payment history|check/i.test(CANNOT_START_TEXT), 'C2 cannot start: it does not reuse "could not check your payment history"');
  ok(!/charge|card|refund|\$|24|hour|minutes/i.test(CANNOT_START_TEXT) && /contact support/.test(CANNOT_START_TEXT), 'C2 cannot start: no statement about a charge, no time promise, tells them to contact support');
  for (const [label, text] of [['paid', PAID_TEXT], ['unavailable', UNAVAILABLE_TEXT], ['cannot start', CANNOT_START_TEXT]]) {
    ok(!/not been charged|have already paid|can't take|second payment/i.test(text), 'C2 ' + label + ': none of the rejected wording survives');
    ok(html.includes(text.replace(/'/g, "\\'")) || html.includes(text), 'C2 ' + label + ': the sentence is in help-measurements.html verbatim');
  }
  ok(!/You have not been charged|You have already paid for the Aerial Roof Report|can't take a second payment/.test(html), 'C2 the page carries none of the rejected wording');
  ok(!/\$|rebate|refund|free|guarantee/i.test(PAID_TEXT + UNAVAILABLE_TEXT + CANNOT_START_TEXT), 'C2 the sentences state no price, rebate, refund or promise');
}

// C3
const purchaseSrc = extractFn(html, 'purchaseHover');
ok(!!purchaseSrc, 'C3 help-measurements.html defines purchaseHover');
if (purchaseSrc) {
  const iRefused = purchaseSrc.indexOf('paymentResult?.refused');
  const iSecret = purchaseSrc.indexOf('paymentResult?.client_secret');
  const iMount = purchaseSrc.indexOf('hoverStripe.elements()');
  ok(iRefused > -1 && iRefused < iSecret && iSecret < iMount, 'C3 the refusal is handled before the client_secret is read and before any card element is mounted');
  const refusedBlock = purchaseSrc.slice(iRefused, purchaseSrc.indexOf('}', purchaseSrc.indexOf('return;', iRefused)) + 1);
  ok(/showMeasurementRefusal\(/.test(refusedBlock) && /return;/.test(refusedBlock) && !/elements|mount|hoverPaymentForm/.test(refusedBlock), 'C3 the refusal path shows the message and returns: no card form');
}

// C4
const gated = /hover_paid|hover_order_id|hover_status/.test(purchaseSrc || '') || /currentClaim\??\.hover_(paid|order_id|status)/.test(html);
ok(!gated, 'C4 the page does not gate the Purchase button on claims.hover_paid / hover_order_id / hover_status (nothing writes them)');

// C5 (F2) the REAL confirmHoverPayment() and purchaseHover(), run in one vm context with the page's own helper functions and state.
const STALE_TEXT = 'This payment page is out of date. Please reload the page to continue. If you have a question about a charge, contact support.';
const staleVar = /var MEASUREMENT_STALE_INTENT_MESSAGE = '[^']*';/.exec(html)?.[0];
const stateVars = 'var staleIntentShown = false;\nvar expectedIntentId = null;';
const stateFn = extractFn(html, 'setStaleIntentState');
const outcomeFn = extractFn(html, 'measurementStaleIntentOutcome');
const confirmSrc = extractFn(html, 'confirmHoverPayment');
ok(!!staleVar && !!stateFn && !!outcomeFn && !!confirmSrc && !!purchaseSrc, 'C5 help-measurements.html defines the stale-intent message, its helpers, confirmHoverPayment and purchaseHover');
ok(!/\bhover\w*Stale|showHover/i.test(html), 'C5 the new identifiers carry no vendor token (vendor-scrub ratchet)');

function makePage({ confirmResult, confirmSrcOverride, purchaseSrcOverride, orderFails = false, secretId = 'pi_old' }) {
  const els = { payHoverBtn: { disabled: false, innerHTML: 'Pay $22.63' }, hoverCardErrors: { textContent: '' }, purchaseHoverBtn: { style: {}, disabled: false, innerHTML: 'Buy' }, hoverPaymentForm: { style: {} },
    hoverSection: { querySelector: () => ({ style: {} }) }, hoverSuccessSection: { classList: { add(c) { els.__success = c; } } } };
  const orders = [], fired = [];
  let changeHandler = null;
  const ctx = {
    document: { getElementById: (id) => els[id] || (els[id] = { style: {}, textContent: '', innerHTML: '' }) },
    hoverStripe: { confirmCardPayment: async () => confirmResult, elements: () => ({ create: () => ({ on: (ev, fn) => { changeHandler = fn; }, mount() {}, clear() {} }) }) },
    hoverCardElement: {}, hoverClientSecret: 'pi_old_secret_x', hoverPaymentIntentId: secretId,
    Services: {
      createMeasurementOrder: async (a) => { orders.push(a); if (orderFails) throw new Error('order step failed'); return {}; },
      createHoverPaymentIntent: async () => ({ client_secret: 'pi_old_secret_x', payment_intent_id: secretId }),
    },
    initHoverStripe() {}, fireMeasurementPurchase: (pi) => { fired.push(pi.id); return Promise.resolve(true); },
    currentClaim: { id: 'c1' }, MEASUREMENT_PRODUCT_CODE: 'roof_basic', console: { warn() {}, log() {}, error() {} },
    showMessage() {}, showMeasurementRefusal() {},
  };
  vm.createContext(ctx);
  vm.runInContext([stateVars, staleVar, stateFn, outcomeFn, confirmSrcOverride ?? confirmSrc, purchaseSrcOverride ?? purchaseSrc].join('\n') + '\n;globalThis.__confirm = confirmHoverPayment; globalThis.__purchase = purchaseHover;', ctx);
  ctx.expectedIntentId = secretId;
  return { ctx, els, orders, fired, change: () => changeHandler };
}
const stripeErr = (status, extra = {}, withPi = true) => ({ type: 'invalid_request_error', code: 'payment_intent_unexpected_state', message: 'You cannot confirm this PaymentIntent because it has a status of ' + status + '.', ...(withPi ? { payment_intent: { id: 'pi_old', status, amount: 2263, currency: 'usd', ...extra } } : {}) });

if (staleVar && stateFn && outcomeFn && confirmSrc && purchaseSrc) {
  // cancelled: nothing was charged. Reload sentence, Pay stays disabled, no order.
  { const pg = makePage({ confirmResult: { error: stripeErr('canceled') } }); await pg.ctx.__confirm();
    ok(pg.els.hoverCardErrors.textContent === STALE_TEXT, 'C5 cancelled intent: exactly the reload sentence is shown (not Stripe\'s raw text)');
    ok(pg.els.payHoverBtn.disabled === true, 'C5 cancelled intent: Pay stays disabled against the dead secret');
    ok(pg.orders.length === 0 && !pg.els.__success, 'C5 cancelled intent: no order is recorded and no success screen'); }
  // succeeded: the card WAS charged. The normal order step runs with THAT intent's id and the normal success path is shown.
  { const pg = makePage({ confirmResult: { error: stripeErr('succeeded') } }); await pg.ctx.__confirm();
    ok(pg.orders.length === 1 && pg.orders[0].payment_intent_id === 'pi_old' && pg.orders[0].claim_id === 'c1' && pg.orders[0].product_code === 'roof_basic' && pg.orders[0].buyer_role === 'homeowner', 'C5 succeeded intent: the existing order step runs once with that intent\'s id');
    ok(pg.els.__success === 'active', 'C5 succeeded intent: the normal success screen is shown');
    ok(pg.els.hoverCardErrors.textContent === '' , 'C5 succeeded intent: the stale sentence is NOT shown');
    ok(pg.fired.join() === 'pi_old', 'C5 succeeded intent: the once-per-intent conversion hook gets the same intent (it dedups by id)'); }
  // fail safe: payment_intent absent, unreadable, wrong id or another status -> the reload sentence, no order
  for (const [label, err] of [
    ['payment_intent absent', stripeErr('succeeded', {}, false)],
    ['payment_intent null', { ...stripeErr('succeeded', {}, false), payment_intent: null }],
    ['payment_intent a string', { ...stripeErr('succeeded', {}, false), payment_intent: 'pi_old' }],
    ['status missing', { ...stripeErr('x'), payment_intent: { id: 'pi_old' } }],
    ['status processing', stripeErr('processing')],
    ['id of another intent', stripeErr('succeeded', { id: 'pi_other' })],
    ['id malformed', stripeErr('succeeded', { id: 'x; drop' })],
    ['id missing', stripeErr('succeeded', { id: undefined })],
  ]) {
    const pg = makePage({ confirmResult: { error: err } }); await pg.ctx.__confirm();
    ok(pg.els.hoverCardErrors.textContent === STALE_TEXT && pg.els.payHoverBtn.disabled === true && pg.orders.length === 0 && !pg.els.__success, 'C5 fail safe (' + label + '): reload sentence, Pay disabled, no order, no success screen');
  }
  // the order step failing after a recovered payment never re-enables Pay (the card was charged)
  { const pg = makePage({ confirmResult: { error: stripeErr('succeeded') }, orderFails: true }); await pg.ctx.__confirm();
    ok(pg.orders.length === 1 && pg.els.payHoverBtn.disabled === true && /contact support/.test(pg.els.payHoverBtn.innerHTML), 'C5 succeeded intent, order step fails: Pay stays disabled and reads "Paid - contact support"'); }
  // a normal success is unchanged; an ordinary decline still re-enables Pay
  { const pg = makePage({ confirmResult: { paymentIntent: { id: 'pi_new', status: 'succeeded' } } }); await pg.ctx.__confirm();
    ok(pg.orders.length === 1 && pg.orders[0].payment_intent_id === 'pi_new' && pg.els.__success === 'active', 'C5 an ordinary success still records the order and shows success'); }
  { const pg = makePage({ confirmResult: { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } } }); await pg.ctx.__confirm();
    ok(pg.els.hoverCardErrors.textContent === 'Your card was declined.' && pg.els.payHoverBtn.disabled === false && pg.orders.length === 0, 'C5 an ordinary card decline still shows Stripe\'s message and lets the buyer try another card'); }
  ok(!/charged|not charge|refund|\$/i.test(STALE_TEXT.replace('a charge', '')), 'C5 the sentence makes no claim that a card was or was not charged, and no price');
  ok(html.includes(STALE_TEXT), 'C5 the sentence is in help-measurements.html verbatim');

  // C6 the card field changes after the dead-intent message: explanation stays, Pay stays disabled (the REAL handler mounted by purchaseHover)
  { const pg = makePage({ confirmResult: { error: stripeErr('canceled') } });
    await pg.ctx.__purchase(); const ch = pg.change();
    ok(typeof ch === 'function' && pg.els.payHoverBtn.disabled === false, 'C6 setup: purchaseHover mounted the card field and Pay is usable on a fresh payment page');
    await pg.ctx.__confirm();
    ok(pg.els.payHoverBtn.disabled === true && pg.els.hoverCardErrors.textContent === STALE_TEXT, 'C6 setup: the dead-intent state is shown');
    ch({ error: null, complete: true }); ch({ error: { message: 'Your card number is incomplete.' } }); ch({});
    ok(pg.els.hoverCardErrors.textContent === STALE_TEXT && pg.els.payHoverBtn.disabled === true, 'C6 after the card field changes the explanation is still visible and Pay is still disabled');
    await pg.ctx.__purchase();
    ok(pg.els.payHoverBtn.disabled === false, 'C6 a fresh payment page (Cancel then Purchase again) makes Pay usable again'); }
  { const pg = makePage({ confirmResult: { paymentIntent: { id: 'pi_new', status: 'succeeded' } } }); await pg.ctx.__purchase(); const ch = pg.change();
    ch({ error: { message: 'Your card number is incomplete.' } });
    ok(pg.els.hoverCardErrors.textContent === 'Your card number is incomplete.', 'C6 with a live payment the card field still shows Stripe\'s field errors'); }

  // negative controls
  const noStale = confirmSrc.replace(/if \(stripeError\) \{\s*\/\/ gh-3356 \(F2\)[^\n]*\n\s*const stale = measurementStaleIntentOutcome\(stripeError, expectedIntentId\);\s*if \(stale && stale\.kind === 'paid'\) \{[\s\S]*?\} else if \(stale\) \{[\s\S]*?return;\s*\}\s*\}/, '');
  ok(noStale !== confirmSrc, 'NC5 setup: the pre-fix confirmHoverPayment is the shipped one with the whole stale branch removed');
  { const old = makePage({ confirmResult: { error: stripeErr('canceled') }, confirmSrcOverride: noStale }); await old.ctx.__confirm();
    ok(old.els.payHoverBtn.disabled === false && old.els.hoverCardErrors.textContent !== STALE_TEXT, 'NC5: without the fix Pay is re-enabled against a dead secret and Stripe\'s raw text is shown'); }
  const noRecovery = confirmSrc.replace("recoveredPaid = true;\n                        paymentIntent = stale.paymentIntent;\n                        stripeError = null;", "return;");
  ok(noRecovery !== confirmSrc, 'NC5b setup: the version that does not record the order for a succeeded intent');
  { const old = makePage({ confirmResult: { error: stripeErr('succeeded') }, confirmSrcOverride: noRecovery }); await old.ctx.__confirm();
    ok(old.orders.length === 0 && !old.els.__success, 'NC5b: the pinned old behaviour (stale sentence for a succeeded intent: no order, no success) is what the fix replaces'); }
  const noGuard = purchaseSrc.replace(/if \(staleIntentShown\) \{ setStaleIntentState\(true\); return; \}\s*/, '');
  ok(noGuard !== purchaseSrc, 'NC6 setup: the card-change handler without the stale guard');
  { const old = makePage({ confirmResult: { error: stripeErr('canceled') }, purchaseSrcOverride: noGuard }); await old.ctx.__purchase(); await old.ctx.__confirm(); old.change()({ error: null });
    ok(old.els.hoverCardErrors.textContent === '', 'NC6: without the guard a card-field change wipes the explanation'); }
  const noRegex = outcomeFn.replace(/\s*&& \(!expectedIntentId \|\| pi\.id === expectedIntentId\)/, '');
  ok(noRegex !== outcomeFn, 'NC7 setup: the outcome function without the expected-intent check');
  { const run = (fn) => { const c = {}; vm.createContext(c); vm.runInContext(fn + '\n;globalThis.__o = measurementStaleIntentOutcome;', c); return c.__o(stripeErr('succeeded', { id: 'pi_other' }), 'pi_old'); };
    ok(run(outcomeFn).kind === 'stale' && run(noRegex).kind === 'paid', 'NC7: another intent\'s id is refused by the shipped check and accepted without it'); }
}

// C8 -- the price-drift answer of create-measurement-order (LEGAL-READ: FAIL 6643004568 and REVIEW: FAIL 6643059729 at 4288f233).
// The drift check runs BEFORE verifyPayment, so the server has read nothing from Stripe when it answers. It must therefore make no
// payment or charge statement at all ("paid", "charged", "refund"): such a sentence is false for an unpaid or invented id and
// misleading after a full refund. It says only that the report is unavailable and sends the buyer to support (the e276ba83 text).
{
  const orderSrc = fs.readFileSync(path.join(root, 'supabase', 'functions', 'create-measurement-order', 'index.ts'), 'utf8');
  const driftFn = extractFn(orderSrc, 'detectPriceDrift');
  const DRIFT_TEXT = 'This report is temporarily unavailable \u2014 its price is misconfigured. Please contact support.';
  const driftReturns = driftFn ? [...driftFn.matchAll(/return "([^"\n]*)";/g)].map((m) => m[1]) : [];
  const claimsPayment = (t) => /paid|charged|charge|refund|payment|\$/i.test(t);
  ok(!!driftFn && driftReturns.includes(DRIFT_TEXT), 'C8 the price-drift answer is exactly the no-payment-claim text of e276ba83');
  ok(driftReturns.length === 1 && !claimsPayment(driftReturns.join('\n')), 'C8 the price-drift answer states no payment, charge or refund fact (the server has not checked one)');
  ok(/contact support/.test(DRIFT_TEXT), 'C8 the price-drift answer still sends the buyer to support');
  // the drift check must stay ahead of verifyPayment in the handler, and nothing in it may read Stripe (so no payment fact can be known)
  ok(!/stripe|verifyPayment|paymentIntent|payment_intent/i.test(driftFn || 'stripe'), 'C8 detectPriceDrift reads no Stripe or payment data, so it cannot know a payment fact');
  // negative controls: the 4288f233 sentence and the 2bb700a4 sentence must both fail the same check
  const PAID_TEXT = 'This report is temporarily unavailable \u2014 its price is misconfigured. The report has already been paid for. Please contact support.';
  const OLD_TEXT = 'This report is temporarily unavailable \u2014 its price is misconfigured. Nothing has been charged. Please contact support.';
  ok(claimsPayment(PAID_TEXT) && claimsPayment(OLD_TEXT) && !claimsPayment(DRIFT_TEXT), 'NC8: the "already been paid for" text (4288f233) and the "Nothing has been charged" text (2bb700a4) both fail the no-payment-claim check');
  const paidFn = driftFn && driftFn.replace(DRIFT_TEXT, PAID_TEXT);
  const paidReturns = paidFn ? [...paidFn.matchAll(/return "([^"\n]*)";/g)].map((m) => m[1]) : [];
  ok(!!paidFn && paidFn !== driftFn && claimsPayment(paidReturns.join('\n')), 'NC8b: the function with the 4288f233 sentence put back is caught by the same check');
}

// C9 -- the API `error` text of the already-paid refusal (LEGAL-READ: FAIL 6643004568, sentence 7). On the superseded-race path a new
// unpaid PaymentIntent does exist, so "no new payment was created" is not true there. The text says only what is known.
{
  const gateSrc = fs.readFileSync(path.join(root, 'supabase', 'functions', 'create-payment-intent', 'measurement-paid-gate.ts'), 'utf8');
  const m = gateSrc.match(/export const ALREADY_PAID_ERROR = "([^"\n]*)";/);
  ok(!!m && m[1] === 'A report has already been paid for on this claim.', 'C9 the already-paid error says the claim has paid and makes no "no payment was created" claim');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
