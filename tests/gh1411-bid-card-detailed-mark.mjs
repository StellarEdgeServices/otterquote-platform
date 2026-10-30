/**
 * gh-1411 / gh-3152 / D-317 cl. 5 -- homeowner bids.html: the bid card carries the mark
 * "Bid on detailed measurements" on Shape B ('full') claims only, keyed to claims.measurement_shape.
 * Static checks on the page source (negative control: Shape A path renders '').
 * Run: node tests/gh1411-bid-card-detailed-mark.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(process.env.GH1411_BIDS_PAGE || path.join(root, 'bids.html'), 'utf8');
let pass = 0, fail = 0;
function ok(c, l) { if (c) { console.log('PASS: ' + l); pass++; } else { console.log('FAIL: ' + l); fail++; } }
ok(html.includes('Bid on detailed measurements'), 'page carries the D-317 cl. 5 wording exactly');
ok((html.match(/Bid on detailed measurements/g) || []).length === 1, 'wording appears once (one render site)');
ok(/const isShapeBClaim = !!currentClaim && currentClaim\.measurement_shape === 'full';/.test(html), "Shape B is exactly measurement_shape === 'full' (NULL/absent/other = Shape A)");
ok(/\$\{isShapeBClaim \? '<div class="bid-detailed-mark"[^']*Bid on detailed measurements<\/div>' : ''\}/.test(html), 'mark is conditional on Shape B, empty string otherwise (negative control)');
const card = html.slice(html.indexOf('<div class="bid-card ${'));
ok(card.indexOf('bid-detailed-mark') > 0 && card.indexOf('bid-detailed-mark') < card.indexOf('bid-card-meta'), 'mark is inside the bid card header');
ok(!/detailedBidContractors/.test(html), 'per-contractor purchase set removed (mark no longer shown on Shape A claims)');
ok(!/hover_orders/.test(html), 'homeowner page never reads hover_orders directly');
// Behavioural check of the gate expression itself
const gate = (claim) => !!claim && claim.measurement_shape === 'full';
ok(gate({ measurement_shape: 'full' }) === true, 'gate: full -> mark');
ok([{ measurement_shape: 'basic' }, { measurement_shape: null }, {}, null].every((c) => gate(c) === false), 'gate: basic/null/absent/no claim -> no mark');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
