/**
 * gh-2803 (D-381; Dustin's ruling on #2846, option (b) "At contractor signature") -- the bid form's selected-bid notes box is offered
 * only while NEITHER party has signed: homeowner_signed_at IS NULL AND contractor_signed_at IS NULL (same bound as update_selected_bid_notes()).
 * Executes the real notesEligible expression extracted from contractor-bid-form.html.
 * Negative control: ROOT=<checkout of PR #2844 head b8f21caf> node tests/gh2803-bidform-notes-gate.mjs  (expected exit 1: contractor-signed-only still eligible)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
let fail = 0;
const check = (name, cond) => { if (!cond) fail++; console.log((cond ? 'PASS: ' : 'FAIL: ') + name); };
const html = fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8');
const m = html.match(/const notesEligible = (!!\([\s\S]*?\));\n/);
check('notesEligible expression found', !!m);
const elig = m ? new Function('existingQuote', 'return ' + m[1]) : () => null;
const base = { id: 'q1', status: 'selected', bid_status: 'active', homeowner_signed_at: null, contractor_signed_at: null };
check('neither signed: eligible', elig({ ...base }) === true);
check('awarded, neither signed: eligible', elig({ ...base, status: 'awarded' }) === true);
check('homeowner signed only: not eligible', elig({ ...base, homeowner_signed_at: '2026-10-18T00:00:00Z' }) === false);
check('contractor signed only: not eligible', elig({ ...base, contractor_signed_at: '2026-10-18T00:00:00Z' }) === false);
check('both signed: not eligible', elig({ ...base, homeowner_signed_at: 'x', contractor_signed_at: 'y' }) === false);
check('submitted bid: not eligible', elig({ ...base, status: 'submitted' }) === false);
check('expired bid_status: not eligible', elig({ ...base, bid_status: 'expired' }) === false);
check('no quote: not eligible', elig(null) === false);
console.log(fail ? `FAILED ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
