/**
 * gh-3356 -- the static measurement checkout handles create-payment-intent's refusal to sell a second report on a paid claim.
 *   C1  Services.createHoverPaymentIntent turns the 409 MEASUREMENT_ALREADY_PAID / 503 MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE answers into
 *       {client_secret: null, refused: true, code}; every other failure is still the old placeholder; a success is untouched.
 *   C2  the REAL showHoverRefusal() from help-measurements.html: already paid -> Purchase button hidden, plain message, no card form;
 *       check unavailable -> button kept (re-enabled) and a retry message.
 *   C3  purchaseHover() checks `refused` BEFORE it reads client_secret, and nothing on the refusal path mounts Stripe elements.
 *   C4  the claims.hover_paid / hover_order_id / hover_status columns are not written by any code, so the page does not gate on them.
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
  const other = await (await loadServices(src, async () => httpError(500, { error: 'boom' }))).createHoverPaymentIntent(PARAMS);
  const unknownCode = await (await loadServices(src, async () => httpError(422, { code: 'SOMETHING_ELSE' }))).createHoverPaymentIntent(PARAMS);
  const network = await (await loadServices(src, async () => { throw new TypeError('offline'); })).createHoverPaymentIntent(PARAMS);
  const success = await (await loadServices(src, async () => ({ data: { client_secret: 'cs_1', payment_intent_id: 'pi_1' }, error: null }))).createHoverPaymentIntent(PARAMS);
  return {
    refusedPaid: paid.refused === true && paid.code === 'MEASUREMENT_ALREADY_PAID' && paid.client_secret === null,
    refusedUnavailable: unavailable.refused === true && unavailable.code === 'MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE',
    othersUnchanged: [other, unknownCode, network].every((r) => r.placeholder === true && r.client_secret === null && !r.refused),
    successUnchanged: success.client_secret === 'cs_1' && !success.refused,
  };
}
const r = await c1(services, 'shipped');
ok(r.refusedPaid, 'C1 a 409 MEASUREMENT_ALREADY_PAID becomes {refused: true, code, client_secret: null}');
ok(r.refusedUnavailable, 'C1 a 503 MEASUREMENT_PAYMENT_CHECK_UNAVAILABLE becomes {refused: true, code}');
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
  ok(!m.refusedPaid && !m.refusedUnavailable && m.successUnchanged, "NC: the pre-fix wrapper loses the refusal (placeholder only), so C1 fails against it");
}

// C2
const showSrc = extractFn(html, 'showHoverRefusal');
ok(!!showSrc, 'C2 help-measurements.html defines showHoverRefusal');
function runShow(code) {
  const messages = [];
  const btn = { style: { display: '' }, disabled: true, innerHTML: 'Loading' };
  const ctx = { showMessage: (t, ty) => messages.push([t, ty]) };
  vm.createContext(ctx);
  vm.runInContext(showSrc + '\n;globalThis.__show = showHoverRefusal;', ctx);
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
  for (const [label, text] of [['paid', PAID_TEXT], ['unavailable', UNAVAILABLE_TEXT]]) {
    ok(!/not been charged|have already paid|can't take|second payment/i.test(text), 'C2 ' + label + ': none of the rejected wording survives');
    ok(html.includes(text.replace(/'/g, "\\'")) || html.includes(text), 'C2 ' + label + ': the sentence is in help-measurements.html verbatim');
  }
  ok(!/You have not been charged|You have already paid for the Aerial Roof Report|can't take a second payment/.test(html), 'C2 the page carries none of the rejected wording');
  ok(!/\$|rebate|refund|free|guarantee/i.test(PAID_TEXT + UNAVAILABLE_TEXT), 'C2 the sentences state no price, rebate, refund or promise');
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
  ok(/showHoverRefusal\(/.test(refusedBlock) && /return;/.test(refusedBlock) && !/elements|mount|hoverPaymentForm/.test(refusedBlock), 'C3 the refusal path shows the message and returns: no card form');
}

// C4
const gated = /hover_paid|hover_order_id|hover_status/.test(purchaseSrc || '') || /currentClaim\??\.hover_(paid|order_id|status)/.test(html);
ok(!gated, 'C4 the page does not gate the Purchase button on claims.hover_paid / hover_order_id / hover_status (nothing writes them)');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
