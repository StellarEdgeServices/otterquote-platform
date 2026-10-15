/**
 * gh-2564 C4 (PR #2612 comment 6066958013; D-369, D-382) -- contractor-bid-form.html must not open "Change Your Bid"
 * for a bid the homeowner has selected; it shows a lock message and offers no edit path.
 *
 * Checks: (1) the existing-quote loader tests isSelectedBidLocked() BEFORE it sets changeBidMode / calls
 * activateChangeBidMode; (2) isSelectedBidLocked behaves (selected status, or claim.selected_contractor_id match, locks;
 * a submitted bid does not; another contractor's selection does not); (3) the lock card exists and showSelectedBidLock
 * hides the form cards, sets the message, hides the submit button; (4) the submit handler returns early when locked;
 * (5) the message is neutral: no price, promise, or legal claim words, and it points to support.
 * (6) startUp() returns right after init() when locked (executes the real startUp with spies).
 * Negative control: ROOT=<checkout of main before this change> node tests/gh2564-bidform-selected-lock.mjs  (expected exit 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
let fail = 0;
const check = (name, cond) => { if (!cond) fail++; console.log((cond ? 'PASS: ' : 'FAIL: ') + name); };

const html = fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8');

// (1) order in the loader
const loader = html.match(/if \(existingQuoteData && isSelectedBidLocked\(existingQuoteData, currentClaim, data\)\) \{[\s\S]*?showSelectedBidLock\(\);\s*\} else if \(existingQuoteData\) \{\s*existingQuote = existingQuoteData;\s*changeBidMode = true;/);
check('loader branches to showSelectedBidLock() before changeBidMode = true', !!loader);
check('loader branch does not call activateChangeBidMode for the locked case', !!loader && !/activateChangeBidMode/.test(loader[0]));

// (2) behaviour of the predicate
const fnSrc = html.match(/function isSelectedBidLocked\(quote, claim, contractor\) \{[\s\S]*?\n    \}\n/);
check('isSelectedBidLocked is defined', !!fnSrc);
if (fnSrc) {
  const f = new Function(fnSrc[0] + '; return isSelectedBidLocked;')();
  const me = { id: 'c1' };
  check('status selected -> locked', f({ status: 'selected' }, { selected_contractor_id: null }, me) === true);
  check('claim selected_contractor_id is me -> locked', f({ status: 'submitted' }, { selected_contractor_id: 'c1' }, me) === true);
  check('submitted bid, nobody selected -> not locked', f({ status: 'submitted' }, { selected_contractor_id: null }, me) === false);
  check("another contractor selected -> not locked", f({ status: 'submitted' }, { selected_contractor_id: 'c2' }, me) === false);
  check('no quote -> not locked', f(null, {}, me) === false);
}

// (3) lock card + show function
check('lock card element exists', /id="selectedBidLockCard"/.test(html) && /id="selectedBidLockMessage"/.test(html));
const show = html.match(/function showSelectedBidLock\(\) \{[\s\S]*?\n    \}\n/);
check('showSelectedBidLock hides bidFormCard, wizard cards and the Change Bid banner',
  !!show && ['bidFormCard', 'wizardStep1Card', 'wizardStep3Card', 'changeBidBanner'].every(id => show[0].includes("'" + id + "'")));
check('showSelectedBidLock shows the card, sets the message, hides submit, sets the lock flag',
  !!show && /selectedBidLockCard/.test(show[0]) && /BID_LOCKED_MESSAGE/.test(show[0]) && /submitBtnEl\.style\.display = 'none'/.test(show[0]) && /_bidLockedSelected = true/.test(show[0]));

// (4) submit guard
check('submit handler returns early when locked', /bidForm\.addEventListener\('submit', async \(e\) => \{\s*e\.preventDefault\(\);\s*if \(window\._bidLockedSelected\) return;/.test(html));

// (5) wording
const msg = (html.match(/const BID_LOCKED_MESSAGE = '([^']*)';/) || [])[1] || '';
check('message exists and points to support', /contact support/i.test(msg));
check('message makes no price, promise, guarantee or legal claim', msg.length > 0 && !/\$|guarantee|promise|will |refund|liable|legal|\bcontract\b|binding|law/i.test(msg));
check('message is exactly the legal-reader text', msg === 'The homeowner has already chosen a contractor, so this bid can no longer be changed here. Contact support for help.');
// "your bid" is false after a contractor switch (the old contractor's quote stays selected): refuse it anywhere in the lock text
const lockCardHtml = (html.match(/<div id="selectedBidLockCard"[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
check('lock text never says "your bid" (message, lock card, lock heading/title)',
  msg.length > 0 && lockCardHtml.length > 0 && !/your bid/i.test(msg + ' ' + lockCardHtml + ' ' + (show ? show[0] : '')));
// D-381 notes: they save only through the same submit that writes price and fee, so the form stays hidden (follow-up)
check('hide list adds no vendor-named card id (D-312 ratchet)', !!show && !/hoverHomePhotosCard/.test(show[0]));

// (6) startUp must not undo the lock (review MF2): executes the real startUp source with spies
const su = html.match(/async function startUp\(\) \{[\s\S]*?\n      \}\n/);
check('startUp is defined', !!su);
if (su) {
  const calls = [];
  const spy = n => () => { calls.push(n); };
  const win = {};
  const run = new Function('window', 'init', 'updateFeeCalculator', 'initTradeSelection', 'initHoverHomePhotos', 'initWizard',
    'document', 'URLSearchParams', 'localStorage', su[0] + '; return startUp;');
  const startUp = run(win, async () => { calls.push('init'); win._bidLockedSelected = true; }, spy('updateFeeCalculator'),
    spy('initTradeSelection'), spy('initHoverHomePhotos'), spy('initWizard'),
    new Proxy({}, { get: () => () => null }), URLSearchParams, { getItem: () => null, setItem() {}, removeItem() {} });
  let threw = null;
  try { await startUp(); } catch (e) { threw = e; }
  check('startUp returns right after init() when the bid is locked (no re-shown cards, no wizard)',
    !threw && calls.join(',') === 'init');
}

console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
