/**
 * gh-2559 -- contractor pages state the real document access window. D-386 (Dustin, #2696 comment 6084050178,
 * "Approve default (Recommended)"): the homeowner's full insurance estimate is released to the contractor only
 * after the Platform Fee has been successfully collected -- NOT at selection.
 * Run: node tests/gh2559-contractor-access-window-copy.mjs   (GH2559_ROOT = another tree for a negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.GH2559_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
function ok(c, m) { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) failed++; }
const D386 = "The homeowner's full insurance estimate is released to you only after the Platform Fee has been successfully collected.";
for (const [f, label] of [['contractor-how-it-works.html', 'how-it-works'], ['contractor-faq.html', 'FAQ']]) {
  const t = rd(f);
  ok(t.includes(D386), label + ' states the D-386 wording (estimate released only after the Platform Fee is collected)');
  ok(!/As soon as the homeowner selects you/i.test(t), label + ' does not say documents open "as soon as the homeowner selects you"');
  ok(!/(at|upon) selection/i.test(t.replace(/<[^>]+>/g, ' ')), label + ' has no "at selection" / "upon selection" access wording');
  const txt = t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');
  ok(!/phone number and email address are released/i.test(txt), label + ' makes no phone/email release-timing claim (contact-flow ruling vs D-386 pending, #2559)');
  ok(!/released the moment the contract is fully signed/i.test(txt), label + ' does not release contact information "the moment the contract is fully signed"');
  ok(!/(phone|email|contact)[^.]{0,80}released[^.]{0,80}(signed|signing|selects? you|selection)/i.test(txt) && !/released[^.]{0,80}(phone|email|contact)[^.]{0,80}(signed|signing|selects? you|selection)/i.test(txt), label + ' has no "released ... signed" promise of phone/email/contact before the Platform Fee');
  ok(!/project package[^.]*contact information|contact information[^.]*project package/i.test(txt), label + ' does not put contact information in the project package');
  ok(!/Once both parties have signed[^.]*contact information/i.test(txt), label + ' does not tie contact information to "Once both parties have signed"');
  ok(!/contact information[^.]*after both parties have signed the contract/i.test(txt), label + ' does not release contact information "after both parties have signed the contract"');
  ok(!/you can open the homeowner's uploaded documents/i.test(t), label + ' does not promise the uploaded documents are openable on selection');
}
process.exit(failed ? 1 : 0);
