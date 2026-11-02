/**
 * gh-2598 slice 2 -- string diff of the staging page against the two approved design files.
 *
 * The approved design (2026-10-07) is Recommended-desktop.dc.html and Recommended-phone.dc.html. Committed verbatim under
 * tests/fixtures/gh2598-design/ (with a .txt suffix) so CI can read them (the originals live on the owner's drive, Marketing/site-reskin-2026-10/).
 * DESIGN_DIR=<dir> points the test at another copy of the two files (used to check the fixture against the originals).
 * ONE RULED EXCEPTION to "verbatim" (Dustin, #2719 comment 6169077489, 2026-10-14, option (b)): the Questions answer to "Do you work with my insurance company?"
 * reads "Once you have your insurance estimate, we can walk you through what it includes and what it pays for." in the page AND in both committed
 * fixtures. The drive originals in Marketing/site-reskin-2026-10/ still carry the approved "No. But we can read a loss sheet and tell you what is and is
 * not covered.", so DESIGN_DIR=<drive> reports exactly that one string pair as different until the originals are re-approved with the new line.
 *
 * SECOND RULED EXCEPTION to "verbatim" (Dustin, #2813 comment 6253699223, 2026-10-18, option (b), \"Narrow: \"...that contractors use to bid\" (Recommended)\"): the #paid
 * sentence reads "You pay as little as $22.63 up front for professional measurements that contractors use to bid." in the page AND in both committed fixtures
 * (the approved drive originals still say "that every contractor uses"). Re-run the legal read on that line.
 * Slice 3 (How we're paid, What we do not do, You can change your mind) is built; it restates the fee, the $22.63 measurement charge and its refund and the
 * switch-contractor promise, so the PR that adds it carries an independent LEGAL-READ and the CEO's R-177 SIGNED line (D-377, D-378, D-291, D-313, D-371).
 *
 * What it pins, for every section the page has built so far (BUILT below):
 *   S1  desktop view: the page's visible strings equal the desktop design's strings, same order, none extra, none missing
 *   S2  phone view:   the same against the phone design (elements the CSS hides on phones are dropped for the phone view and the
 *                     elements it hides on desktop are dropped for the desktop view; the class lists are DESKTOP_ONLY / PHONE_ONLY)
 *   S3  section order on the page follows the design
 *   S4  money and promise wording stays where it was approved: the fee, the $22.63 charge, its refund and the switch promise appear only inside #paid and #promise,
 *       never in any other section, never in an attribute text (placeholder, value, title, alt, aria-label), and the design's own strings for those two
 *       sections are not repeated anywhere else (reviewer m1 of #2716: attribute text was never compared)
 * Every check has a NEGATIVE CONTROL: a mutation of the page or of a design copy that must turn it red.
 * HOME_NEXT_ROOT=<dir> points the test at another checkout.
 * Run: node tests/gh2598-home-next-sections.mjs      Exit 0 = all green including every control going red.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.HOME_NEXT_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN_DIR = process.env.DESIGN_DIR || path.join(ROOT, 'tests/fixtures/gh2598-design');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
function control(id, red) { ok(red, id + ' NEGATIVE CONTROL goes red on the mutated source'); }

const PAGE = fs.readFileSync(path.join(ROOT, 'home-next.html'), 'utf8');
/* the committed copies carry a .txt suffix so that no page-level guard (footer link, sitemap, vendor scrub) mistakes a design file for a page */
const readDesign = (name) => { for (const f of [name + '.txt', name]) { const p = path.join(DESIGN_DIR, f); if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } throw new Error('design file not found: ' + name + ' in ' + DESIGN_DIR); };
const DESK = readDesign('Recommended-desktop.dc.html');
const PHONE = readDesign('Recommended-phone.dc.html');

const BUILT = ['header', 'hero', 'facts', 'how', 'contractor', 'paid', 'promise', 'questions', 'closing'];       /* slices 1, 2 and 3 */
const MONEY_SECTIONS = ['paid', 'promise'];                                                    /* slice 3: the only sections allowed to carry money or promise wording */
/* slice 4 owns the footer (the page carries a minimal legal-links footer until then), so it is in neither list */
const IDLE = 'Sample layout. Your bids appear here, side by side.';                            /* the design's {{ explain }} default */
const DESKTOP_ONLY = new Set(['hr-full', 'hr-phone-long', 'hr-brand-tag', 'hr-nav', 'hr-btn-outline', 'hr-promise-side']);   /* display:none under 768 px */
const PHONE_ONLY = new Set(['hr-short', 'hr-call-short', 'hr-promise-call']);                                      /* display:none from 768 px up */
const BREAK_TAGS = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'li', 'ul', 'ol', 'section', 'header', 'footer', 'nav', 'main', 'label', 'button', 'a', 'br', 'input']);
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link']);

function body(html) {
  let b = html;
  const dc = b.match(/<x-dc>([\s\S]*)<\/x-dc>/); if (dc) { b = dc[1]; }
  const bd = b.match(/<body[^>]*>([\s\S]*)<\/body>/); if (bd) { b = bd[1]; }
  return b.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|svg|helmet)\b[\s\S]*?<\/\1>/g, '');
}
const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&middot;/g, '·').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
/* hr-brand-name / hr-brand-tag are spans the CSS makes display:block: give each its own line */
const prep = (html) => html.replace(/(<span class="hr-brand-(?:name|tag)">[^<]*<\/span>)/g, '$1<br>');

/* split into chunks at <header>, <section>, <footer>; key each chunk */
function chunks(html) {
  const b = body(prep(html));
  const parts = b.split(/(?=<(?:header|section|footer)\b)/).filter((p) => /^<(header|section|footer)\b/.test(p));
  const out = [];
  for (const p of parts) {
    const tag = p.match(/^<(\w+)/)[1];
    const id = (p.match(/^<\w+[^>]*\sid="([^"]+)"/) || [])[1] || '';
    let key = null;
    if (tag === 'header') key = 'header'; else if (tag === 'footer') key = 'footer';
    else if (id === 'top') key = 'hero'; else if (id === 'how') key = 'how'; else if (id === 'paid') key = 'paid'; else if (id === 'promise') key = 'promise';
    else if (id === 'questions') key = 'questions'; else if (id === 'start') key = 'closing'; else if (id === 'facts') key = 'facts'; else if (id === 'contractor') key = 'contractor';
    else if (p.includes('Your details stay yours')) key = 'facts';
    else if (p.includes('What you see about each contractor')) key = 'contractor';
    else if (/<h2[^>]*>Questions<\/h2>/.test(p)) key = 'questions';
    out.push({ key: key || 'unknown:' + p.slice(0, 60), html: p });
  }
  return out;
}

/* visible strings of one chunk for one view ('desktop' | 'phone') */
function strings(chunkHtml, view) {
  const drop = view === 'phone' ? DESKTOP_ONLY : PHONE_ONLY;
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let m, text = '', skipDepth = 0, skipTag = null;
  while ((m = re.exec(chunkHtml))) {
    if (m[4] !== undefined) { if (!skipTag) text += m[4]; continue; }
    const closing = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3] || '';
    const cls = ((attrs.match(/\sclass="([^"]*)"/) || [])[1] || '').split(/\s+/);
    if (!closing) {
      if (skipTag) { if (tag === skipTag) skipDepth++; continue; }
      if (cls.some((c) => drop.has(c))) { if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) { skipTag = tag; skipDepth = 1; } continue; }
      if (BREAK_TAGS.has(tag)) text += '\n';
    } else {
      if (skipTag) { if (tag === skipTag && --skipDepth === 0) skipTag = null; continue; }
      if (BREAK_TAGS.has(tag)) text += '\n';
    }
  }
  return decode(text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).map((l) => l.replace('{{ explain }}', IDLE));
}

function byKey(html) { const o = {}; for (const c of chunks(html)) { if (o[c.key]) { o[c.key].html += c.html; } else { o[c.key] = { ...c }; } } return o; }
function diff(a, b) {   /* a = page, b = design; ordered comparison */
  const missing = b.filter((s) => !a.includes(s)), extra = a.filter((s) => !b.includes(s));
  const same = a.length === b.length && a.every((s, i) => s === b[i]);
  return { same, missing, extra };
}
function sectionResults(page, desk, phone) {
  const P = byKey(page), D = byKey(desk), H = byKey(phone), res = [];
  for (const k of BUILT) {
    for (const [view, design] of [['desktop', D], ['phone', H]]) {
      if (!P[k]) { res.push({ k, view, same: false, missing: ['(section absent from the page)'], extra: [] }); continue; }
      if (!design[k]) { res.push({ k, view, same: false, missing: [], extra: ['(section absent from the design file)'] }); continue; }
      res.push({ k, view, ...diff(strings(P[k].html, view), strings(design[k].html, view)) });
    }
  }
  return res;
}
const bad = (r) => r.filter((x) => !x.same);

/* ---------- S1 / S2 ---------- */
const base = sectionResults(PAGE, DESK, PHONE);
for (const r of base) ok(r.same, `S${r.view === 'desktop' ? 1 : 2} ${r.k}, ${r.view} view: page strings equal the design's` + (r.same ? '' : ` | missing ${JSON.stringify(r.missing)} | extra ${JSON.stringify(r.extra)}`));
const total = (() => { const P = byKey(PAGE); return BUILT.reduce((n, k) => n + (P[k] ? strings(P[k].html, 'desktop').length : 0), 0); })();
ok(total > 60, `S1 the comparison covers ${total} desktop strings (a parser that finds nothing must not pass)`);

const word = (html, a, b) => { if (!html.includes(a)) throw new Error('mutation anchor missing: ' + a); return html.replace(a, b); };
control('S1 (one word changed on the page)', bad(sectionResults(word(PAGE, 'they are more likely to include better materials', 'they are more likely to include best materials'), DESK, PHONE)).length > 0);
control('S1 (one word changed in the desktop design)', bad(sectionResults(PAGE, word(DESK, 'Nobody sits at your kitchen table.', 'Nobody sits at your dining table.'), PHONE)).length > 0);
control('S2 (one word changed in the phone design)', bad(sectionResults(PAGE, DESK, word(PHONE, 'Who bids on my job?', 'Who bids on the job?'))).length > 0);
control('S1 (a list item removed from the page)', bad(sectionResults(word(PAGE, '<li>Licensing information</li>', ''), DESK, PHONE)).length > 0);
control('S1 (an extra string added to the page)', bad(sectionResults(word(PAGE, '<h2 class="hr-h2">How it works</h2>', '<h2 class="hr-h2">How it works</h2><p class="hr-p">Guaranteed lowest price.</p>'), DESK, PHONE)).length > 0);
control('S2 (phone-only label removed from the page)', bad(sectionResults(word(PAGE, '<span class="hr-short">Reviews</span>', ''), DESK, PHONE)).length > 0);
control('S1 (a whole section removed from the page)', bad(sectionResults(PAGE.replace(/<section class="hr-sec hr-contractor"[\s\S]*?<\/section>/, ''), DESK, PHONE)).length > 0);
control('S1 (two list items swapped on the page)', bad(sectionResults(word(word(word(PAGE, '<li>The materials they propose</li>', '@@A@@'), '<li>The warranty they offer</li>', '<li>The materials they propose</li>'), '@@A@@', '<li>The warranty they offer</li>'), DESK, PHONE)).length > 0);

control('S1 (the Questions header link removed)', bad(sectionResults(word(PAGE, '<a href="#questions">Questions</a>', ''), DESK, PHONE)).length > 0);
control('S1 (the How we\'re paid header link removed)', bad(sectionResults(word(PAGE, '<a href="#paid">How we\'re paid</a>', ''), DESK, PHONE)).length > 0);
control('S1 (one word changed in the fee sentence)', bad(sectionResults(word(PAGE, 'Contractors pay Otter Quotes a fee on the bid you accept.', 'Contractors pay Otter Quotes a fee on the bid they accept.'), DESK, PHONE)).length > 0);
control('S1 (the $22.63 sentence loses its refund sentence)', bad(sectionResults(word(PAGE, ' If you complete a job on the platform, that money is refunded to you.', ''), DESK, PHONE)).length > 0);
control('S1 (switch promise changed from 3 days to 5 days)', bad(sectionResults(word(PAGE, 'up to 3 days before your start date', 'up to 5 days before your start date'), DESK, PHONE)).length > 0);
control('S1 (a "What we do not do" item removed)', bad(sectionResults(word(PAGE, '<li>We do not sell upgrades.</li>', ''), DESK, PHONE)).length > 0);
control('S1 (the desktop side block of the promise band removed)', bad(sectionResults(PAGE.replace(/<div class="hr-promise-side hr-full">[\s\S]*?<\/div>\s*<\/div>/, ''), DESK, PHONE)).length > 0);
control('S2 (the phone call link of the promise band removed)', bad(sectionResults(PAGE.replace(/<a class="hr-promise-call"[\s\S]*?<\/a>/, ''), DESK, PHONE)).length > 0);

/* ---------- S3: section order ---------- */
const orderOf = (html) => chunks(html).map((c) => c.key).filter((k) => BUILT.includes(k));
const want = orderOf(DESK);
ok(JSON.stringify(orderOf(PAGE)) === JSON.stringify(want), 'S3 section order on the page follows the design: ' + orderOf(PAGE).join(' > '));
const swapped = PAGE.replace(/(<section class="hr-sec hr-how"[\s\S]*?<\/section>)\s*(<section class="hr-sec hr-contractor"[\s\S]*?<\/section>)/, '$2\n$1');
control('S3', swapped !== PAGE && JSON.stringify(orderOf(swapped)) !== JSON.stringify(want));
const swapped2 = PAGE.replace(/(<section class="hr-sec hr-paid"[\s\S]*?<\/section>)\s*(<section class="hr-sec hr-promise"[\s\S]*?<\/section>)/, '$2\n$1');
control('S3 (paid and promise swapped)', swapped2 !== PAGE && JSON.stringify(orderOf(swapped2)) !== JSON.stringify(want));

/* ---------- S4: money and promise wording stays inside #paid and #promise ---------- */
const MONEY = /\$\s?\d|\brefund|\bfee\b|\bswitch (?:to )?another|at no cost|up to \d+ days|no cost\b/i;
/* visible attribute text: placeholder, value, title, alt, aria-label (the string extractor reads text nodes only) */
function attrTexts(chunkHtml) {
  const out = [], re = /\s(placeholder|value|title|alt|aria-label)="([^"]*)"/g; let m;
  while ((m = re.exec(chunkHtml))) out.push(decode(m[2]));
  return out;
}
const sectionTextAll = (c) => [...strings(c.html, 'desktop'), ...strings(c.html, 'phone'), ...attrTexts(c.html)];
/* every design string that belongs to the two money sections and to no other section */
const moneyOnly = new Set();
{
  const others = new Set();
  for (const d of [byKey(DESK), byKey(PHONE)]) for (const k of BUILT) if (!MONEY_SECTIONS.includes(k) && d[k]) for (const v of ['desktop', 'phone']) strings(d[k].html, v).forEach((x) => others.add(x));
  for (const d of [byKey(DESK), byKey(PHONE)]) for (const k of MONEY_SECTIONS) if (d[k]) for (const v of ['desktop', 'phone']) strings(d[k].html, v).forEach((x) => { if (!others.has(x)) moneyOnly.add(x); });
}
ok(moneyOnly.size >= 8, `S4 the two money sections yield ${moneyOnly.size} strings of their own to look for`);
function stray(html) {   /* money or promise wording found outside #paid and #promise: the header, every other section and the footer all count */
  const P = byKey(html), hits = [];
  for (const k of Object.keys(P)) {
    if (MONEY_SECTIONS.includes(k)) continue;
    for (const x of sectionTextAll(P[k])) { if (MONEY.test(x) || moneyOnly.has(x)) hits.push(k + ': ' + x); }
  }
  return hits;
}
const s0 = stray(PAGE);
ok(s0.length === 0, 'S4 no money or promise word, and none of the #paid or #promise strings, outside those two sections' + (s0.length ? ' | ' + JSON.stringify(s0) : ''));
ok(/id="paid"/.test(PAGE) && /id="promise"/.test(PAGE), 'S4 the page has #paid and #promise');
ok(MONEY_SECTIONS.every((k) => MONEY.test(sectionTextAll(byKey(PAGE)[k] || { html: '' }).join('\n'))), 'S4 the money sections do carry the wording (a MONEY pattern that matches nothing must not pass)');
control('S4 (the fee sentence repeated in the hero)', stray(word(PAGE, '<div class="hr-reassure">No salesperson in your home. No obligation to hire.</div>', '<div class="hr-reassure">No salesperson in your home. Contractors pay Otter Quotes a fee on the bid you accept.</div>')).length > 0);
control('S4 (a refund word added to a built paragraph)', stray(word(PAGE, 'Nobody sits at your kitchen table.', 'Nobody sits at your kitchen table. Any fee is refunded.')).length > 0);
control('S4 (a price in the questions section)', stray(word(PAGE, 'No. There is no obligation to work with our contractors.', 'No. There is no obligation to work with our contractors. Measurements cost $22.63.')).length > 0);
control('S4 (money wording in a placeholder attribute: reviewer m1)', stray(word(PAGE, '<input id="hr-zip-end"', '<input placeholder="Free quote, no fee" id="hr-zip-end"')).length > 0);
control('S4 (money wording in a value attribute: reviewer m1)', stray(word(PAGE, '<input id="hr-zip"', '<input value="$22.63 refunded" id="hr-zip"')).length > 0);
control('S4 (money wording in an aria-label)', stray(word(PAGE, 'aria-label="Call Otter Quotes at 844 875 3412"', 'aria-label="Call us, no cost to switch to another contractor"')).length > 0);
control('S4 (the switch promise copied into the footer)', stray(word(PAGE, '<a href="/privacy.html">Privacy Policy</a>', '<a href="/privacy.html">Switch to another Otter Quotes contractor at no cost</a>')).length > 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
