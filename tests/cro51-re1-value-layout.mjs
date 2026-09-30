/**
 * CRO51 -- RE-1 value layout (Dustin, 2026-09-30, verbatim; canonical source
 * Claude's Memories/otterquote-value-proposition.md section 5 item 4).
 * Pins Dustin's copy byte-for-byte, the four "Become a partner today" buttons
 * (each an in-page link to the EXISTING #signup-section form), the photo
 * manifest/size/lazy-loading rules, banned phrases from section 3/4 (with a
 * negative control), and -- in a real browser -- no horizontal scroll at
 * 390px, the alternating desktop layout and photo-above-text on phones.
 * Run: node tests/cro51-re1-value-layout.mjs   (browser half needs Playwright; PW_MODULE_DIR like cro47)
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

const html = fs.readFileSync(path.join(repoRoot, 're-1.html'), 'utf8');
const mainM = /<main class="re1-value"[\s\S]*?<\/main>/.exec(html);
const main = mainM ? mainM[0] : '';
ok(!!main, 'value block <main class="re1-value"> exists');

// ── Dustin's copy, byte for byte ────────────────────────────────────────────
const HEADLINE = 'MEET YOUR NEW BEST FRIEND.';
const SUBHEAD = 'Otter Quotes help realtors close deals faster.';
const SECTIONS = [
  ['Get repairs done faster.', 'Otter Quotes will create a scope of work and submit it to multiple contractors. No leaving messages for multiple contractors, no meeting someone on site. No waiting for schedules to line up. Just submit your job and start getting bids in one to two days.'],
  ['Get multiple competitive bids.', 'Contractors know they are competing for work on Otter Quotes. So they offer the best pricing they can.'],
  ['See subcontractor pricing.', 'Clients can choose from local, well known contractors or work directly with the subcontractors who do the work.'],
  ['Reduce unnecessary expenses.', 'Otter Quotes reduces the need for sales and marketing costs, so contractors can pass those savings along to your clients.'],
];
ok(main.includes('<h1>' + HEADLINE + '</h1>'), 'headline is exactly "' + HEADLINE + '" in the h1');
ok(main.includes('<p class="re1-sub">' + SUBHEAD + '</p>'), 'subhead is exactly "' + SUBHEAD + '"');
const secs = main.match(/<section class="re1-section[^"]*"[\s\S]*?<\/section>/g) || [];
ok(secs.length === 4, 'exactly four value sections -- got ' + secs.length);
SECTIONS.forEach(([h, body], i) => {
  const sec = secs[i] || '';
  ok(sec.includes('<h2>' + h + '</h2>'), 'section ' + (i + 1) + ' blue header is the first sentence, verbatim: ' + h);
  ok(sec.includes('<p>' + body + '</p>'), 'section ' + (i + 1) + ' body is verbatim');
  const btns = sec.match(/<a class="re1-cta"[^>]*>[^<]*<\/a>/g) || [];
  ok(btns.length === 1 && /href="#signup-section"/.test(btns[0]) && />Become a partner today<\/a>$/.test(btns[0]), 'section ' + (i + 1) + ' has one "Become a partner today" button -> #signup-section');
  const im = /<img[^>]*>/.exec(sec);
  ok(!!im && /width="900"/.test(im[0]) && /height="600"/.test(im[0]) && /loading="lazy"/.test(im[0]) && /alt="[^"]{8,}"/.test(im[0]), 'section ' + (i + 1) + ' photo has width/height, lazy loading and alt text');
});
// Top button (Dustin 2026-09-30, "Keep page headline; add form link at top"): directly under the subhead, same style + target.
ok(main.includes('<p class="re1-sub">' + SUBHEAD + '</p>\n    <a class="re1-cta re1-cta--top" href="#signup-section" data-re1-cta="top">Become a partner today</a>'), 'one "Become a partner today" button sits directly under the subhead -> #signup-section, same re1-cta style');
ok((main.match(/<a class="re1-cta[ "][^>]*>Become a partner today<\/a>/g) || []).length === 5 && (main.match(/href="#signup-section"/g) || []).length === 5, 'five "Become a partner today" buttons in total (top + four sections), all -> #signup-section');
ok(/gtag\('event', 'partner_cta_click', \{ position: a\.getAttribute\('data-re1-cta'\)/.test(html) && /querySelectorAll\('\.re1-cta'\)/.test(html), 'every .re1-cta (top + four) fires the same partner_cta_click event with a position param (top/1-4)');
ok(/id="signup-section"/.test(html) && /<form[^>]*id="partner-form"/.test(html), 'the button target #signup-section is the existing short-signup section holding #partner-form');
ok((html.match(/id="signup-section"/g) || []).length === 1, 'exactly one #signup-section');
// The four sections all sit before the form (buttons scroll DOWN to the existing form).
ok(html.indexOf('<main class="re1-value"') < html.indexOf('id="signup-section"'), 'value block precedes the signup form');
// Unchanged legal/fee wording still present
ok(html.includes('Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.'), 'D-266 disclaimer retained verbatim');
ok(html.includes('$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.'), 'D-301/D-305 flat-fee sentence retained verbatim');

// ── banned phrases (value proposition sections 3 and 4) ─────────────────────
const BANNED = [/free (?:roof )?(?:inspection|assessment)/i, /damage assessment/i, /\bvetted\b/i, /\bendorsed?\b/i, /\bcertified\b/i, /\bunbiased\b/i, /\bindependent\b/i,
  /work(?:s|ing)? with your insurance/i, /\bupgrades? (?:for )?free\b/i, /\d+\s?(?:–|-|to)\s?\d+ percent/i, /most insurance companies/i, /\bpercent(?:age)?\b/i, /\d\s?%/, /844-|317-|\(317\)/, /we (?:will )?call you/i, /track(?:ing)? (?:every|your)/i];
function bannedHits(text) { return BANNED.filter((re) => re.test(text)).map(String); }
const visible = (main + ' ' + (/<title>[^<]*<\/title>/.exec(html) || [''])[0] + ' ' + (/<meta name="description"[^>]*>/.exec(html) || [''])[0]).replace(/<[^>]+>/g, ' ');
ok(bannedHits(visible).length === 0, 'no banned phrase in the value block, title or meta description -- hits: ' + JSON.stringify(bannedHits(visible)));
// negative control: the detector must fire on known-bad copy
ok(bannedHits('Get a free inspection from our vetted, certified, unbiased contractors').length >= 4, 'negative control: detector catches free inspection / vetted / certified / unbiased');
ok(bannedHits('Save 20-50 percent on your premium').length >= 1, 'negative control: detector catches the retired "20-50 percent" claim');

// ── photos: manifest, size, no stray files ──────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'img/re1/manifest.json'), 'utf8'));
ok(manifest.images.length === 4, 'manifest lists four photos');
for (const m of manifest.images) {
  const fp = path.join(repoRoot, m.file);
  ok(fs.existsSync(fp) && fs.statSync(fp).size <= 150 * 1024, m.file + ' exists and is <= 150 KB');
  ok(m.photographer && /^https:\/\/www\.pexels\.com\/photo\//.test(m.page_url) && m.licence_url === 'https://www.pexels.com/license/' && m.section, m.file + ' manifest row has photographer, source URL, licence URL, section');
  ok(html.includes('/' + m.file), m.file + ' is referenced by re-1.html');
}
ok(!fs.readdirSync(path.join(repoRoot, 'img/re1')).some((f) => /^TODO-photo/.test(f)), 'no TODO placeholder photos left');

// v2 (Dustin review 2026-09-30): real-estate photos for sections 3-4 (closing, SOLD sign), no tool photos; form matches the page.
ok(manifest.images[2].page_url.includes('8470836') && manifest.images[3].page_url.includes('8293717'), 'sections 3-4 use the closing/signing and SOLD-sign photos');
ok(!/saw|drill|lumber|mitre/i.test(main), 'value block has no saw/drill/lumber photo alt text');
for (const m of manifest.images) {
  const im = new RegExp('src="/' + m.file.replace(/[.\/]/g, '\\$&') + '" width="(\\d+)" height="(\\d+)"').exec(html);
  const buf = fs.readFileSync(path.join(repoRoot, m.file));
  const w = buf.readUIntLE(26, 2) & 0x3fff, h = buf.readUIntLE(28, 2) & 0x3fff;
  ok(im && Number(im[1]) === w && Number(im[2]) === h, m.file + ' WebP dimensions match declared width/height');
}
ok(/\.signup-section \{ background: #FFFFFF; color: #000000;/.test(html) && /\.signup-section \.btn-primary \{ background: #1E4FA8;/.test(html), 'signup section is white with the page blue submit button');

// ── browser half ────────────────────────────────────────────────────────────
let chromium = null;
try {
  const pwDir = process.env.PW_MODULE_DIR || path.join(repoRoot, 'tests', 'e2e');
  ({ chromium } = createRequire(path.join(pwDir, 'package.json'))('playwright'));
} catch (e) { console.log('SKIP: Playwright not resolvable (' + e.code + ') -- browser checks not run'); }
if (chromium) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const fp = path.join(repoRoot, rel);
    if (!fp.startsWith(repoRoot) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(fs.readFileSync(fp));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  async function open(w, h, mobile) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    await page.route((u) => !u.href.startsWith(BASE), (r) => r.abort());
    await page.goto(BASE + '/re-1.html', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    return page;
  }
  const geo = (page) => page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      // body has overflow-x:hidden (site base), which masks scrollWidth, so ALSO measure the right edge of every element
      maxRight: Math.max(...Array.from(document.querySelectorAll('.re1-value, .re1-value *, #signup-section, #signup-section *')).map((e) => e.getBoundingClientRect().right)),
      sections: Array.from(document.querySelectorAll('.re1-section')).map((s) => {
        const p = r(s.querySelector('.re1-photo')), t = r(s.querySelector('.re1-text'));
        return { photoLeft: p.left, textLeft: t.left, photoTop: p.top, textTop: t.top, photoW: p.width };
      }),
      h1Color: getComputedStyle(document.querySelector('.re1-value h1')).color,
      h2Color: getComputedStyle(document.querySelector('.re1-value h2')).color,
      pColor: getComputedStyle(document.querySelector('.re1-text p')).color,
      bg: getComputedStyle(document.querySelector('.re1-value')).backgroundColor,
      font: getComputedStyle(document.querySelector('.re1-value h1')).fontFamily,
    };
  });
  const phone = await open(390, 844, true);
  const g = await geo(phone);
  ok(g.scrollW <= g.innerW && g.maxRight <= g.innerW + 0.5, '390px: no horizontal scroll and no element past the viewport (scrollWidth ' + g.scrollW + ', max right edge ' + Math.round(g.maxRight) + ', viewport ' + g.innerW + ')');
  ok(g.sections.every((s) => s.photoTop < s.textTop && Math.abs(s.photoLeft - s.textLeft) < 2), '390px: every section is stacked, photo above text');
  await phone.evaluate(() => window.scrollTo(0, 0));
  // tap the first button: must land on the existing form section
  await phone.click('[data-re1-cta="1"]');
  await phone.waitForTimeout(900);
  const top = await phone.evaluate(() => Math.round(document.getElementById('signup-section').getBoundingClientRect().top));
  ok(top >= -2 && top < 400, '390px: tapping "Become a partner today" scrolls the signup form into view (top=' + top + ')');
  // top button is visible in the first screen at 390x664 and scrolls to the form
  const small = await open(390, 664, true);
  const tb = await small.evaluate(() => { const b = document.querySelector('[data-re1-cta="top"]').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, w: b.width }; });
  ok(tb.top >= 0 && tb.bottom <= 664 && tb.w > 100, '390x664: top "Become a partner today" button is fully inside the first screen (top ' + Math.round(tb.top) + ', bottom ' + Math.round(tb.bottom) + ')');
  await small.click('[data-re1-cta="top"]');
  await small.waitForTimeout(900);
  const top2 = await small.evaluate(() => Math.round(document.getElementById('signup-section').getBoundingClientRect().top));
  ok(top2 >= -2 && top2 < 400, '390x664: tapping the top button scrolls the signup form into view (top=' + top2 + ')');
  const desk = await open(1280, 800, false);
  const d = await geo(desk);
  ok(d.scrollW <= d.innerW && d.maxRight <= d.innerW + 0.5, '1280px: no horizontal scroll and no element past the viewport');
  ok(d.sections.every((s, i) => i % 2 === 0 ? (s.textLeft < s.photoLeft) : (s.photoLeft < s.textLeft)), '1280px: sections alternate (text left/photo right, then photo left/text right ...) -- ' + JSON.stringify(d.sections.map((s) => Math.round(s.photoLeft) + '/' + Math.round(s.textLeft))));
  ok(d.bg === 'rgb(255, 255, 255)' && d.h1Color === 'rgb(30, 79, 168)' && d.h2Color === 'rgb(30, 79, 168)' && d.pColor === 'rgb(0, 0, 0)', 'colours: white background, blue headers, black text -- ' + [d.bg, d.h1Color, d.h2Color, d.pColor].join(' | '));
  ok(/Rubik/.test(d.font), 'site font (Rubik) is used');
  // negative control for the overflow assertion: a wide element must trip the same measure
  await phone.evaluate(() => { const x = document.createElement('div'); x.style.cssText = 'width:600px;height:2px'; document.querySelector('.re1-value').appendChild(x); });
  const g2 = await geo(phone);
  ok(g2.maxRight > 390.5, 'negative control: an injected 600px element is detected as horizontal overflow');
  await browser.close(); server.close();
}
console.log(''); console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
