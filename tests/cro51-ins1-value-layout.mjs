/**
 * CRO51 -- INS-1 value layout (Dustin, 2026-09-30, verbatim; intro paragraph Dustin 2026-10-01; canonical source
 * Claude's Memories/otterquote-value-proposition.md section 5 item 5).
 * Pins Dustin's copy byte-for-byte (the ONLY edit is the obvious typo "all this" -> "allow this" in the fee section), the seven
 * "Become a partner today" buttons (top + six sections, each an in-page link to the EXISTING #signup form), the photo
 * manifest/size/lazy-loading rules, banned phrases from section 3/4 (with a negative control), and -- in a real browser -- no
 * horizontal scroll at 390px, the alternating desktop layout, photo-above-text on phones and the top button above the fold.
 * Run: node tests/cro51-ins1-value-layout.mjs   (browser half needs Playwright; PW_MODULE_DIR like cro47; set INS1_BASE_URL to
 * drive a deploy preview instead of the local files)
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

const html = fs.readFileSync(path.join(repoRoot, 'ins-1.html'), 'utf8');
const mainM = /<div class="ins1-value"[\s\S]*?\n        <\/div>\n/.exec(html);
const main = mainM ? mainM[0] : '';
ok(!!main, 'value block <div class="ins1-value"> exists');

// ── Dustin's copy, byte for byte ────────────────────────────────────────────
const H1_A = "Don't just send a check.";
const H1_B = 'SEND HELP AFTER THE STORM';
// CRO51 v2 (Dustin, 2026-10-01, verbatim request; his ruling on the two outcome sentences: 'Soften to "can" (Recommended)'):
// the one-line subhead was REPLACED by this three-sentence intro paragraph. Pinned byte for byte (straight apostrophe, single spaces).
const SUBHEAD = "Otter Quotes sends your client's scope of work to multiple contractors and makes them compete for the business. Your client can get better materials and warranties. You can get fewer claims, more referrals, and $200 for qualified jobs signed through the platform.";
const SUBHEAD_FIRST = "Otter Quotes sends your client's scope of work to multiple contractors and makes them compete for the business.";
const OLD_SUBHEAD = 'Otter Quotes gets multiple competitive bids for your clients.';
const SECTIONS = [
  ['Easier Service.', 'Otter Quotes generates a scope of work and submits it to multiple contractors for bid. In less time than it takes for them to sign with a door to door canvasser, your client can get multiple bids from local, well-known contractors.'],
  ['Educated Clients.', 'We show your clients how higher grade materials can reduce damage from hail and wind. So you have fewer claims in the future and you get to surprise them with discounted rates.'],
  ['Better Warranties and Materials.', "Otter Quotes helps contractors reduce or eliminate the cost of sales and marketing and forces them to compete. So they can funnel those savings into better material and warranties to win your clients' jobs."],
  ['No cost, no obligation.', 'There is no obligation to work with our contractors and no cost for homeowners who provide a copy of their insurance estimate.'],
  ['Simple and easy to send.', "We know it's hard to reach out to everyone affected by a storm. So we make it easy to send your link to clients."],
  ['$200 referral fee.', 'For every client you refer who does $10,000 or more of work through Otter Quotes, we will send you $200. Please make sure your employment and licensing terms allow this.'],
];
ok(main.includes('<h1><span class="ins1-h1-a">' + H1_A + '</span> <span class="ins1-h1-b">' + H1_B + '</span></h1>'), 'headline is "' + H1_A + '" then "' + H1_B + '" in the h1');
ok(main.includes('<p class="ins1-sub">' + SUBHEAD + '</p>'), 'intro paragraph is exactly "' + SUBHEAD + '"');
ok((html.match(/<p class="ins1-sub">/g) || []).length === 1, 'exactly one intro paragraph (.ins1-sub)');
const oldSubheadAbsent = (h) => !h.includes(OLD_SUBHEAD);
const introPinned = (h) => h.includes('<p class="ins1-sub">' + SUBHEAD + '</p>');
ok(oldSubheadAbsent(html), 'the old subhead "' + OLD_SUBHEAD + '" is absent from the whole page (body, meta description, og:description)');
ok(!oldSubheadAbsent(html.replace(SUBHEAD, OLD_SUBHEAD)) && !introPinned(html.replace(SUBHEAD, OLD_SUBHEAD)) && !introPinned(html.replace('Your client can get', 'Your client  can get')), 'negative control: the old-subhead and intro-paragraph checks fire when the old subhead is put back, and the byte-exact pin fires on a doubled space');
// Dustin's ruling: outcomes are softened to "can"; the unsoftened wording must not be on the page.
ok(SUBHEAD.includes('Your client can get better materials and warranties.') && SUBHEAD.includes('You can get fewer claims, more referrals, and $200 for qualified jobs signed through the platform.') && !/Your client gets better|You fewer claims|You get fewer claims/.test(html), 'intro outcomes use "can get" (ruling: soften to "can"); the unsoftened wording is absent');
ok(/Your client gets better/.test(html.replace('Your client can get better', 'Your client gets better')), 'negative control: the unsoftened-wording check fires when "can get" is swapped back to "gets"');
ok(!/[\u2018\u2019\u00a0]/.test(SUBHEAD) && !/  /.test(SUBHEAD) && SUBHEAD.length === 263, 'intro paragraph uses a straight apostrophe and single spaces (263 characters)');
ok(html.includes('<meta name="description" content="' + SUBHEAD_FIRST + '">') && html.includes('<meta property="og:description" content="' + SUBHEAD_FIRST + '">') && SUBHEAD.startsWith(SUBHEAD_FIRST + ' '), 'meta description and og:description are the first sentence of the intro paragraph');
const secs = main.match(/<section class="ins1-section[^"]*"[\s\S]*?<\/section>/g) || [];
ok(secs.length === 6, 'exactly six value sections -- got ' + secs.length);
SECTIONS.forEach(([h, body], i) => {
  const sec = secs[i] || '';
  ok(sec.includes('<h2>' + h + '</h2>'), 'section ' + (i + 1) + ' blue header is the first sentence, verbatim: ' + h);
  ok(sec.includes('<p>' + body + '</p>'), 'section ' + (i + 1) + ' body is verbatim');
  const btns = sec.match(/<a class="ins1-cta"[^>]*>[^<]*<\/a>/g) || [];
  ok(btns.length === 1 && /href="#signup"/.test(btns[0]) && />Become a partner today<\/a>$/.test(btns[0]), 'section ' + (i + 1) + ' has one "Become a partner today" button -> #signup');
  const im = /<img[^>]*>/.exec(sec);
  ok(!!im && /width="900"/.test(im[0]) && /height="600"/.test(im[0]) && /loading="lazy"/.test(im[0]) && /alt="[^"]{8,}"/.test(im[0]), 'section ' + (i + 1) + ' photo has width/height, lazy loading and alt text');
});
// Dustin 2026-09-30 ruling: "local, well-known contractors" (replaces "trusted"); "trusted" must not appear in the value block.
ok(!/trusted/i.test(main) && main.includes('local, well-known contractors'), 'Easier Service says "local, well-known contractors" and "trusted" is absent from the value block');
ok(/trusted/i.test(main.replace('well-known', 'trusted')), 'negative control: the "trusted" check fires when "well-known" is swapped back');
// the one typo fix, and only that one
ok(main.includes('licensing terms allow this.') && !/\ball this\b/.test(main), 'typo fix: "allow this" (Dustin wrote "all this"; fixed, flagged in the PR body)');
// Top button directly under the subhead, same style + target.
ok(main.includes('<p class="ins1-sub">' + SUBHEAD + '</p>\n                <a class="ins1-cta ins1-cta--top" href="#signup" data-ins1-cta="top">Become a partner today</a>'), 'one "Become a partner today" button sits directly under the intro paragraph -> #signup, same ins1-cta style');
ok((main.match(/<a class="ins1-cta[ "][^>]*>Become a partner today<\/a>/g) || []).length === 7 && (main.match(/href="#signup"/g) || []).length === 7, 'seven "Become a partner today" buttons in total (top + six sections), all -> #signup');
ok(/gtag\('event', 'partner_cta_click', \{ position: a\.getAttribute\('data-ins1-cta'\)/.test(html) && /querySelectorAll\('\.ins1-cta'\)/.test(html), 'every .ins1-cta (top + six) fires the same partner_cta_click event with a position param (top/1-6)');
ok(/<section class="form-section" id="signup">/.test(html) && /<form id="insuranceAgentForm"/.test(html), 'the button target #signup is the existing form section holding #insuranceAgentForm');
ok((html.match(/id="signup"/g) || []).length === 1, 'exactly one #signup');
ok(html.indexOf('<div class="ins1-value"') < html.indexOf('id="signup"'), 'value block precedes the signup form');
ok(html.includes('Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees.'), 'D-266 disclaimer retained verbatim');
ok(html.includes('$200 when a homeowner you refer completes a project of $10,000 or more. $50 on the same terms for referrals from partners you recruit.'), 'D-301/D-305 flat-fee sentence retained verbatim');
ok(!/class="hero"/.test(html) && !/benefits-sidebar/.test(html) && !html.includes('Track every referral from your phone'), 'the old navy hero, the "What You Get" sidebar and its "Track every referral ... in real time" claim are gone');

// ── banned phrases (value proposition sections 3 and 4) ─────────────────────
const BANNED = [/free (?:roof )?(?:inspection|assessment)/i, /damage assessment/i, /\bvetted\b/i, /\bendorsed?\b/i, /\bcertified\b/i, /\bunbiased\b/i, /\bindependent\b/i,
  /work(?:s|ing)? with your insurance/i, /\bupgrades? (?:for )?free\b/i, /\d+\s?(?:–|-|to)\s?\d+ percent/i, /most insurance companies/i, /\bpercent(?:age)?\b/i, /\d\s?%/, /844-|317-|\(317\)/, /we (?:will )?call you/i, /track(?:ing)? (?:every|your)/i, /\b(?:a )?percentage of\b/i];
function bannedHits(text) { return BANNED.filter((re) => re.test(text)).map(String); }
const alts = (main.match(/alt="[^"]*"/g) || []).join(' ');
const visible = (main.replace(/<[^>]+>/g, ' ') + ' ' + alts + ' ' + (/<title>[^<]*<\/title>/.exec(html) || [''])[0] + ' ' + (/<meta name="description"[^>]*>/.exec(html) || [''])[0]).replace(/<[^>]+>/g, ' ');
ok(bannedHits(visible).length === 0, 'no banned phrase in the value block, photo alt text, title or meta description -- hits: ' + JSON.stringify(bannedHits(visible)));
// negative control: the detector must fire on known-bad copy
ok(bannedHits('Get a free inspection from our vetted, certified, unbiased contractors').length >= 4, 'negative control: detector catches free inspection / vetted / certified / unbiased');
ok(bannedHits('Save 20-50 percent on your premium').length >= 1, 'negative control: detector catches the retired "20-50 percent" claim');
ok(bannedHits('Helping you work with your insurance. Track every referral.').length >= 2, 'negative control: detector catches "work with your insurance" and "track every referral"');

// ── photos: manifest, size, no stray files ──────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'img/ins1/manifest.json'), 'utf8'));
ok(manifest.images.length === 6, 'manifest lists six photos');
for (const m of manifest.images) {
  const fp = path.join(repoRoot, m.file);
  ok(fs.existsSync(fp) && fs.statSync(fp).size <= 150 * 1024, m.file + ' exists and is <= 150 KB');
  ok(m.photographer && /^https:\/\/www\.pexels\.com\/photo\//.test(m.page_url) && m.licence_url === 'https://www.pexels.com/license/' && m.section, m.file + ' manifest row has photographer, source URL, licence URL, section');
  ok(html.includes('/' + m.file), m.file + ' is referenced by ins-1.html');
}
ok(new Set(manifest.images.map((m) => m.page_url)).size === 6, 'six different photos');
ok(!fs.readdirSync(path.join(repoRoot, 'img/ins1')).some((f) => /^TODO-photo/.test(f)), 'no TODO placeholder photos left');
for (const m of manifest.images) {
  const im = new RegExp('src="/' + m.file.replace(/[.\/]/g, '\\$&') + '" width="(\\d+)" height="(\\d+)"').exec(html);
  const buf = fs.readFileSync(path.join(repoRoot, m.file));
  ok(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP', m.file + ' is a WebP file');
  ok(im && Number(im[1]) === 900 && Number(im[2]) === 600, m.file + ' declared width/height 900x600');
}
ok(/\.form-section \{ background: #FFFFFF; color: #000000;/.test(html) && /\.form-section \.btn-primary \{ background: #1E4FA8;/.test(html), 'signup section is white with the page blue submit button');

// ── browser half ────────────────────────────────────────────────────────────
let chromium = null;
try {
  const pwDir = process.env.PW_MODULE_DIR || path.join(repoRoot, 'tests', 'e2e');
  ({ chromium } = createRequire(path.join(pwDir, 'package.json'))('playwright'));
} catch (e) { console.log('SKIP: Playwright not resolvable (' + e.code + ') -- browser checks not run'); }
if (chromium) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json' };
  let BASE = process.env.INS1_BASE_URL || '';
  let server = null;
  if (!BASE) {
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const fp = path.join(repoRoot, rel);
      if (!fp.startsWith(repoRoot) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
      res.end(fs.readFileSync(fp));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    BASE = 'http://127.0.0.1:' + server.address().port;
  }
  const browser = await chromium.launch();
  async function open(w, h, mobile) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    if (!process.env.INS1_BASE_URL) await page.route((u) => !u.href.startsWith(BASE), (r) => r.abort());
    await page.goto(BASE + '/ins-1.html?oq_internal=1', { waitUntil: 'load' });
    await page.waitForTimeout(800);
    return page;
  }
  const geo = (page) => page.evaluate(() => {
    const r = (e) => e.getBoundingClientRect();
    return {
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      // body has overflow-x:hidden (site base), which masks scrollWidth, so ALSO measure the right edge of every element
      maxRight: Math.max(...Array.from(document.querySelectorAll('.ins1-value, .ins1-value *, #signup, #signup *')).map((e) => e.getBoundingClientRect().right)),
      sections: Array.from(document.querySelectorAll('.ins1-section')).map((s) => {
        const p = r(s.querySelector('.ins1-photo')), t = r(s.querySelector('.ins1-text'));
        return { photoLeft: p.left, textLeft: t.left, photoTop: p.top, textTop: t.top, photoW: p.width };
      }),
      h1Color: getComputedStyle(document.querySelector('.ins1-value h1')).color,
      h2Color: getComputedStyle(document.querySelector('.ins1-value h2')).color,
      pColor: getComputedStyle(document.querySelector('.ins1-text p')).color,
      bg: getComputedStyle(document.querySelector('.ins1-value')).backgroundColor,
      font: getComputedStyle(document.querySelector('.ins1-value h1')).fontFamily,
      formBg: getComputedStyle(document.querySelector('#signup')).backgroundColor,
      btnBg: getComputedStyle(document.querySelector('#signup button[type=submit]')).backgroundColor,
    };
  });
  const phone = await open(390, 844, true);
  const g = await geo(phone);
  ok(g.scrollW <= g.innerW && g.maxRight <= g.innerW + 0.5, '390px: no horizontal scroll and no element past the viewport (scrollWidth ' + g.scrollW + ', max right edge ' + Math.round(g.maxRight) + ', viewport ' + g.innerW + ')');
  ok(g.sections.every((s) => s.photoTop < s.textTop && Math.abs(s.photoLeft - s.textLeft) < 2), '390px: every section is stacked, photo above text');
  await phone.evaluate(() => window.scrollTo(0, 0));
  await phone.click('[data-ins1-cta="1"]');
  await phone.waitForTimeout(900);
  const top = await phone.evaluate(() => Math.round(document.getElementById('signup').getBoundingClientRect().top));
  ok(top >= -2 && top < 400, '390px: tapping "Become a partner today" scrolls the signup form into view (top=' + top + ')');
  // top button is visible in the first screen at 390x664 and scrolls to the form
  const small = await open(390, 664, true);
  const tb = await small.evaluate(() => { const b = document.querySelector('[data-ins1-cta="top"]').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, w: b.width }; });
  ok(tb.top >= 0 && tb.bottom <= 664 && tb.w > 100, '390x664: top "Become a partner today" button is fully inside the first screen (top ' + Math.round(tb.top) + ', bottom ' + Math.round(tb.bottom) + ')');
  // intro paragraph: readable body size (never below 16px), centred, a bounded measure, and above the top button
  const ip = await small.evaluate(() => { const e = document.querySelector('.ins1-sub'), cs = getComputedStyle(e), b = e.getBoundingClientRect(); return { fs: parseFloat(cs.fontSize), align: cs.textAlign, top: b.top, bottom: b.bottom, w: b.width, left: b.left, right: b.right }; });
  ok(ip.fs >= 16 && ip.align === 'center' && ip.bottom <= tb.top && ip.left >= 0 && ip.right <= 390.5, '390x664: intro paragraph is >= 16px (' + ip.fs + 'px), centred, inside the viewport and above the top button (y ' + Math.round(ip.top) + '-' + Math.round(ip.bottom) + ')');
  await small.click('[data-ins1-cta="top"]');
  await small.waitForTimeout(900);
  const top2 = await small.evaluate(() => Math.round(document.getElementById('signup').getBoundingClientRect().top));
  ok(top2 >= -2 && top2 < 400, '390x664: tapping the top button scrolls the signup form into view (top=' + top2 + ')');
  const desk = await open(1280, 800, false);
  const d = await geo(desk);
  ok(d.scrollW <= d.innerW && d.maxRight <= d.innerW + 0.5, '1280px: no horizontal scroll and no element past the viewport');
  ok(d.sections.every((s, i) => i % 2 === 0 ? (s.textLeft < s.photoLeft) : (s.photoLeft < s.textLeft)), '1280px: sections alternate (text left/photo right, then photo left/text right ...) -- ' + JSON.stringify(d.sections.map((s) => Math.round(s.photoLeft) + '/' + Math.round(s.textLeft))));
  ok(d.bg === 'rgb(255, 255, 255)' && d.h1Color === 'rgb(30, 79, 168)' && d.h2Color === 'rgb(30, 79, 168)' && d.pColor === 'rgb(0, 0, 0)', 'colours: white background, blue headers, black text -- ' + [d.bg, d.h1Color, d.h2Color, d.pColor].join(' | '));
  ok(d.formBg === 'rgb(255, 255, 255)' && d.btnBg === 'rgb(30, 79, 168)', 'form section is white with a blue submit button -- ' + [d.formBg, d.btnBg].join(' | '));
  ok(/Rubik/.test(d.font), 'site font (Rubik) is used');
  const dp = await desk.evaluate(() => { const e = document.querySelector('.ins1-sub'), cs = getComputedStyle(e), b = e.getBoundingClientRect(); return { fs: parseFloat(cs.fontSize), w: b.width, mid: (b.left + b.right) / 2, align: cs.textAlign, h1fs: parseFloat(getComputedStyle(document.querySelector('.ins1-value h1')).fontSize) }; });
  ok(dp.fs >= 16 && dp.fs < dp.h1fs && dp.w <= 720 && Math.abs(dp.mid - 640) < 2 && dp.align === 'center', '1280px: intro paragraph is body-sized (' + dp.fs + 'px, smaller than the headline), centred, with a bounded measure (' + Math.round(dp.w) + 'px wide)');
  // WCAG AA text contrast (REVIEW FAIL 5916897295): the after-signup confirmation text and the fee/disclaimer fine print sit on the white
  // signup card and must be >= 4.5:1 against their ACTUAL (composited) background. Was #8A9BAB (2.85:1) on the confirmation text.
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const rgbLum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ratio = (a, b) => { const x = rgbLum(a), y = rgbLum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const textContrast = await desk.evaluate(({ sels }) => {
    const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 1) break; }
      let base = { r: 255, g: 255, b: 255 }; for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; } return [base.r, base.g, base.b]; };
    return sels.map((s) => Array.from(document.querySelectorAll(s)).map((el) => { const c = parse(getComputedStyle(el).color); return { sel: s, fg: [c.r, c.g, c.b], bg: bgOf(el) }; })).flat();
  }, { sels: ['#signup .success-message p', '#signup form > p'] });
  const succEls = textContrast.filter((t) => t.sel === '#signup .success-message p'), fineEls = textContrast.filter((t) => t.sel !== '#signup .success-message p');
  ok(succEls.length >= 1 && succEls.every((t) => ratio(t.fg, t.bg) >= 4.5), 'signup confirmation text contrast >= 4.5:1 against its actual background -- ' + succEls.map((t) => ratio(t.fg, t.bg).toFixed(2)).join(', '));
  ok(fineEls.length >= 1 && fineEls.every((t) => ratio(t.fg, t.bg) >= 4.5), 'signup fee/disclaimer fine print contrast >= 4.5:1 against its actual background -- ' + fineEls.map((t) => ratio(t.fg, t.bg).toFixed(2)).join(', '));
  // negative control: the old #8A9BAB on the white card must fail the same test
  ok(ratio(hexRgb('#8A9BAB'), hexRgb('#FFFFFF')) < 4.5 && ratio(hexRgb('#334155'), hexRgb('#FFFFFF')) >= 4.5, 'negative control: old #8A9BAB on white is ' + ratio(hexRgb('#8A9BAB'), hexRgb('#FFFFFF')).toFixed(2) + ':1 (fails 4.5), #334155 passes');
  // negative control for the overflow assertion: a wide element must trip the same measure
  await phone.evaluate(() => { const x = document.createElement('div'); x.style.cssText = 'width:600px;height:2px'; document.querySelector('.ins1-value').appendChild(x); });
  const g2 = await geo(phone);
  ok(g2.maxRight > 390.5, 'negative control: an injected 600px element is detected as horizontal overflow');
  await browser.close(); if (server) server.close();
}
console.log(''); console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
