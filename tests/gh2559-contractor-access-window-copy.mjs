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
// REVIEW: FAIL 6254502819 -- pin three changed passages each to ITS OWN element (not a whole-page search), so a
// revert of any one of them fails even though the same words appear elsewhere on the page.
{
  const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|\s+/g, ' ');
  // (a) how-it-works step 5 "Win the Contract": the <p> right after that <h3>.
  const hiw = rd('contractor-how-it-works.html');
  const s5 = hiw.match(/<h3>Win the Contract<\/h3>\s*<p>([\s\S]*?)<\/p>/);
  ok(!!s5, 'how-it-works step 5 "Win the Contract" paragraph found');
  const s5t = s5 ? strip(s5[1]) : '';
  ok(s5t.includes(D386), 'how-it-works step 5 carries the D-386 sentence itself (not just the receive card)');
  ok(!/loss sheet|aerial/i.test(s5t), 'how-it-works step 5 does not hand over the loss sheet or aerial measurements "at signing"');
  // (b) FAQ answer holding the D-386 sentence (FAQ:330): its <p> must not promise the "project package" at signing.
  const faq = rd('contractor-faq.html');
  const f330 = [...faq.matchAll(/<p>([^<]*?Once a homeowner selects you, the contract is sent to both of you for signature[\s\S]*?)<\/p>/g)].map(m => strip(m[1]));
  ok(f330.length === 1, 'FAQ contract-signing answer (FAQ:330) found exactly once');
  const a330 = f330[0] || '';
  ok(!/project package/i.test(a330), 'FAQ:330 does not promise "the rest of the project package"/"full project package" at signing');
  ok(/Once both parties have signed, you receive your signed contract\.\s*$/.test(a330), 'FAQ:330 ends at "you receive your signed contract."');
  // (c) FAQ:350 "How do I contact the homeowner?" answer: only the 48-hour expectation, no contact-timing claim.
  const q = faq.match(/How do I contact the homeowner\?[\s\S]*?<\/(?:h3|button|summary|div)>\s*(?:<div[^>]*>\s*)?((?:<p>[\s\S]*?<\/p>\s*)+)/);
  ok(!!q, 'FAQ "How do I contact the homeowner?" answer found');
  const a350 = q ? strip(q[1]).trim() : '';
  ok(a350 === 'Contractors are expected to contact the homeowner within 48 hours.', 'FAQ:350 is exactly the 48-hour expectation, with no contact-timing sentence (got: ' + a350 + ')');
}
process.exit(failed ? 1 : 0);
