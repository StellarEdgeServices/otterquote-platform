/**
 * gh-1796 -- "Mark reviewed" must not be offered on a loss-sheet-queue row whose
 * loss sheet is "Not uploaded" (loss_sheet === 'missing'), and the
 * mark-loss-sheet-reviewed Edge Function must refuse to set loss_sheet_reviewed_at
 * on a claim with no loss-sheet file. Real claims were cleared out of the queue
 * this way (f57c49a0 on 2026-10-03; 5c16cc1e and 16e18349 on 2026-09-09).
 *
 * reviewBtnHtml() is inline in admin-homeowners.html, so the real function is
 * extracted and run in vm (the gh1570 idiom), rather than testing a copy.
 *
 * Run: node tests/gh1796-no-review-without-loss-sheet.mjs
 * GH1796_ROOT points at another tree for negative controls (e.g. a checkout of main).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH1796_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'admin-homeowners.html'), 'utf8');
const ef = fs.readFileSync(path.join(ROOT, 'supabase/functions/mark-loss-sheet-reviewed/index.ts'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const end = html.indexOf('\n}\n', start);
  return html.slice(start, end + 3);
}
const escSrc = extract('esc');
const btnSrc = extract('reviewBtnHtml');
ok(!!escSrc && !!btnSrc, 'admin-homeowners.html defines esc() and reviewBtnHtml()');
const ctx = vm.createContext({});
vm.runInContext(escSrc + '\n' + btnSrc, ctx);
const btn = (r, reviewed, busy) => ctx.reviewBtnHtml(r, reviewed, !!busy);

const missing = { claim_id: 'aaaaaaaa-0000-4000-8000-000000000001', loss_sheet: 'missing', loss_sheet_path: null };
const uploaded = { claim_id: 'aaaaaaaa-0000-4000-8000-000000000002', loss_sheet: 'uploaded_unreviewed', loss_sheet_path: 'u/c/estimate.pdf' };

// the bug: a "Not uploaded" row offered "Mark reviewed"
ok(!/js-review|Mark reviewed|<button/.test(btn(missing, true)), 'a Not-uploaded row renders NO review button');
ok(!/js-review|<button/.test(btn(missing, true, true)), 'a Not-uploaded row renders no button while busy either');
// no regression: a row with a file keeps its button
const b = btn(uploaded, true);
ok(/<button[^>]*class="btn-review js-review"/.test(b) && /Mark reviewed/.test(b) && b.includes('data-claim-id="' + uploaded.claim_id + '"'),
  'an uploaded row still renders the Mark reviewed button, bound to its claim id');
ok(/disabled/.test(btn(uploaded, true, true)) && /Working/.test(btn(uploaded, true, true)), 'an uploaded row still shows the disabled Working state when busy');
// Undo is never hidden
ok(/btn-undo js-review/.test(btn({ claim_id: 'x', loss_sheet: 'reviewed' }, false)), 'the Undo button still renders on a reviewed row');
ok(/btn-undo js-review/.test(btn(missing, false)), 'Undo still renders even on a file-less row (a legacy marker must stay removable)');

// server side: the Edge Function refuses mark-reviewed with no loss sheet, with a 4xx
const guard = ef.match(/if \(reviewed && !String\(claim\.estimate_filename \?\? ""\)\.trim\(\)\) \{[\s\S]*?\n    \}\n/);
ok(!!guard, 'mark-loss-sheet-reviewed: has a no-loss-sheet guard on the mark-reviewed path');
ok(!!guard && /code: "no_loss_sheet"/.test(guard[0]) && /\}, 409, corsHeaders\)/.test(guard[0]), 'the guard returns a clear 409 with code no_loss_sheet');
const gAt = guard ? ef.indexOf(guard[0]) : -1;
ok(gAt > ef.indexOf('const { data: claim, error: claimError }') && gAt < ef.indexOf('const patch: Record<string, string | null>'),
  'the guard runs after the claim is read and before the loss_sheet_reviewed_at write');
ok(gAt > ef.indexOf('Was not marked reviewed'), 'the guard sits after the idempotency branches, so clearing/undoing is never blocked');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
