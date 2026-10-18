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
// LEGAL-READ FAIL 6227107231: the how-it-works "What You Receive When You Win" section (receive-section) must not
// imply contact info or the estimate file arrive with the signed contract package; it is fee-timed (D-386, Agreement 6.2).
{
  const t = rd('contractor-how-it-works.html');
  const m = t.match(/<div class="receive-section">[\s\S]*?<!-- Cost \/ Fee Model -->/);
  ok(!!m, 'how-it-works has the "What You Receive When You Win" section');
  const sec = m ? m[0] : '';
  const txt = sec.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');
  ok(!/Every signed contract package/i.test(txt), 'receive section does not say "Every signed contract package includes" (package is not released at signing)');
  ok(/Once the Platform Fee is collected, your project package includes/i.test(txt), 'receive section intro is fee-timed ("Once the Platform Fee is collected, your project package includes ...")');
  ok(!/Homeowner Contact Info/i.test(txt), 'receive section has no "Homeowner Contact Info" card (D-386 / Agreement 6.2 / #2828)');
  ok(!/(phone|e-?mail|contact info)/i.test(txt.replace(/Contractors are expected to contact the homeowner within 48 hours\./i, '')), 'receive section lists no phone/email/contact info');
  ok(txt.includes(D386), 'receive section Insurance Estimate card carries the D-386 sentence (estimate released only after the Platform Fee is collected)');
}
process.exit(failed ? 1 : 0);
