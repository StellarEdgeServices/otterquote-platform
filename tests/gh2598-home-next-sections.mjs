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
 * What it pins, for every section the page has built so far (BUILT below):
 *   S1  desktop view: the page's visible strings equal the desktop design's strings, same order, none extra, none missing
 *   S2  phone view:   the same against the phone design (elements the CSS hides on phones are dropped for the phone view and the
 *                     elements it hides on desktop are dropped for the desktop view; the class lists are DESKTOP_ONLY / PHONE_ONLY)
 *   S3  section order on the page follows the design
 *   S4  the sections that restate the fee, the $15 charge and its refund, or the switch promise (slice 3, needs a LEGAL-READ and an
 *       R-177 signature) are not on the page: none of their design strings, and no money or promise words, appear in the page text
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

const BUILT = ['header', 'hero', 'facts', 'how', 'contractor', 'questions', 'closing'];       /* slices 1 and 2 */
const DEFERRED = ['paid', 'promise'];                                                          /* slice 3 */
const NOT_YET = { header: ["How we're paid"] };   /* the header link returns with its section in slice 3; tolerated as missing until then, nothing else is */
/* slice 4 owns the footer (the page carries a minimal legal-links footer until then), so it is in neither list */
const IDLE = 'Sample layout. Your bids appear here, side by side.';                            /* the design's {{ explain }} default */
const DESKTOP_ONLY = new Set(['hr-full', 'hr-phone-long', 'hr-brand-tag', 'hr-nav', 'hr-btn-outline']);   /* display:none under 768 px */
const PHONE_ONLY = new Set(['hr-short', 'hr-call-short']);                                      /* display:none from 768 px up */
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
      res.push({ k, view, ...diff(strings(P[k].html, view), strings(design[k].html, view).filter((s) => !(NOT_YET[k] || []).includes(s))) });
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

control('S1 (a header link other than the deferred one removed)', bad(sectionResults(word(PAGE, '<a href="#questions">Questions</a>', ''), DESK, PHONE)).length > 0);

/* ---------- S3: section order ---------- */
const orderOf = (html) => chunks(html).map((c) => c.key).filter((k) => BUILT.includes(k));
const want = orderOf(DESK);
ok(JSON.stringify(orderOf(PAGE)) === JSON.stringify(want), 'S3 section order on the page follows the design: ' + orderOf(PAGE).join(' > '));
const swapped = PAGE.replace(/(<section class="hr-sec hr-how"[\s\S]*?<\/section>)\s*(<section class="hr-sec hr-contractor"[\s\S]*?<\/section>)/, '$2\n$1');
control('S3', swapped !== PAGE && JSON.stringify(orderOf(swapped)) !== JSON.stringify(want));

/* ---------- S4: slice 3 wording is not on the page ---------- */
const pageText = (html) => { const P = byKey(html), all = []; for (const k of Object.keys(P)) { if (k === 'footer') continue; all.push(...strings(P[k].html, 'desktop'), ...strings(P[k].html, 'phone')); } return all; };
const builtStrings = new Set();
for (const d of [byKey(DESK), byKey(PHONE)]) for (const k of BUILT) if (d[k]) for (const v of ['desktop', 'phone']) strings(d[k].html, v).forEach((s) => builtStrings.add(s));
const deferredStrings = new Set();
for (const d of [byKey(DESK), byKey(PHONE)]) for (const k of DEFERRED) if (d[k]) for (const v of ['desktop', 'phone']) strings(d[k].html, v).forEach((s) => { if (!builtStrings.has(s)) deferredStrings.add(s); });
ok(deferredStrings.size >= 8, `S4 the deferred sections yield ${deferredStrings.size} strings of their own to look for`);
const MONEY = /\$\s?\d|\brefund|\bfee\b|\bswitch (?:to )?another|at no cost|up to \d+ days/i;
function leaks(html) { const t = pageText(html), j = t.join('\n'); return { exact: t.filter((s) => deferredStrings.has(s)), words: (j.match(MONEY) || [])[0] || '' }; }
const l0 = leaks(PAGE);
ok(l0.exact.length === 0 && l0.words === '', 'S4 no deferred string and no money or promise word on the page' + (l0.exact.length || l0.words ? ' | ' + JSON.stringify(l0) : ''));
const withPaid = word(PAGE, '<section class="hr-sec hr-questions"', '<section class="hr-sec" id="paid"><div class="hr-wrap"><h2 class="hr-h2">How we\'re paid</h2><p class="hr-p">You pay as little as $15 up front.</p></div></section>\n<section class="hr-sec hr-questions"');
control('S4 (a fee section added)', leaks(withPaid).exact.length > 0 || leaks(withPaid).words !== '');
control('S4 (a refund word added to a built paragraph)', leaks(word(PAGE, 'Nobody sits at your kitchen table.', 'Nobody sits at your kitchen table. Any fee is refunded.')).words !== '');
ok(!/id="(paid|promise)"/.test(PAGE), 'S4 the page has no #paid or #promise section yet');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
