/**
 * gh-2564 C4 (PR #2612 comment 6066958013; D-369, D-382) -- contractor-bid-form.html must not open "Change Your Bid"
 * for a bid the homeowner has selected; it shows a lock message and offers no edit path.
 *
 * Checks: (1) the existing-quote loader tests isSelectedBidLocked() BEFORE it sets changeBidMode / calls
 * activateChangeBidMode; (2) isSelectedBidLocked behaves (selected status, or claim.selected_contractor_id match, locks;
 * a submitted bid does not; another contractor's selection does not); (3) the lock card exists and showSelectedBidLock
 * hides the form cards, sets the message, hides the submit button; (4) the submit handler returns early when locked;
 * (5) the message is neutral: no price, promise, or legal claim words, and it points to support.
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
check('message makes no price, promise, guarantee or legal claim', msg.length > 0 && !/\$|guarantee|promise|will |refund|liable|legal|contract|binding|law/i.test(msg));

console.log(fail ? `FAILED (${fail})` : 'ALL PASS');
process.exit(fail ? 1 : 0);
