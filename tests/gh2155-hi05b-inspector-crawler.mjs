/**
 * gh-2155 HI-05b -- inspector-context CRAWLER, the mechanism named in the
 * dispatch brief to stop the whack-a-mole (Ben, #2152 comment 5839667108).
 * Starts at hi-1.html and at partner-inspectors.html and follows every
 * SAME-SITE link a real visitor would actually see -- both the page's own
 * static markup AND every link js/nav.js's header/footer inject -- 3 levels
 * deep with the inspector-context session flag set (JS ON), plus 1 level
 * with no JS at all (JS OFF, static markup only, no nav.js-injected links).
 * Fails on any rendered fee/bonus/commission/payout/"Get paid"/$ text other
 * than the approved no-fee disclosure sentences. A negative control crawls
 * from partner-re.html (a realtor, untouched by D-333) and must still find
 * fee text, proving the crawl+regex methodology is not vacuous.
 *
 * Playwright/headless Chromium is not installed in this worktree (same
 * constraint tests/gh2155-hi0c-inspector-sweep.mjs already documents), so
 * this crawler uses the two techniques already established in this repo's
 * own test suite instead of a real browser:
 *   - static-HTML text/link extraction for the raw markup a browser parses
 *     (mirrors Playwright's own inner_text("body") + link harvesting), and
 *   - the `vm` module running the REAL js/nav.js source against a minimal
 *     DOM/window shim for the header/footer links nav.js injects at
 *     runtime -- never a hand-retyped reimplementation of what nav.js
 *     renders.
 * The "3 levels deep" graph is therefore built from real edges (either
 * extracted from the page's own bytes, or produced by actually running
 * nav.js), not a hand-maintained sitemap.
 *
 * Run: node tests/gh2155-hi05b-inspector-crawler.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

// ── Shared text/regex machinery, SAME regex + allowlist as the established,
// Ben-negotiated standard in tests/gh2155-hi0c-inspector-sweep.mjs (comment
// 5836510515, item 4: "generic residual contract wording with no dollar
// figure ... On its own I would not fail the box for this"). The dispatch
// brief's word list (fee/bonus/commission/payout/"Get paid"/$) describes
// the SPECIFIC, inspector-facing promise this PR must never show -- not
// every occurrence of those words anywhere in the shared legal document,
// which routinely uses them to describe payment MECHANICS for every OTHER
// partner type in sections this PR's scope (removal/href/visibility only)
// never touches. A dollar amount or an explicit "referral fee"/"recruit
// bonus" grant is exactly the SPECIFIC promise; this crawler flags those.
const FEE_TERM_RE = /\$[\d,]+|referral fee|recruit bonus/gi;

const SAFE_SENTENCES = [
  'Home-inspector partners do not receive a referral fee or recruit bonus.',
  'receives no Referral Fee and no Recruit Bonus under this Agreement.',
  'No Referral Fee',
  '4. Referral Fee Structure',
  'Referral fees and bonuses under Section 4 are paid through a third-party payment service',
];

function decodeEntities(s) {
  return s
    .replace(/&rsquo;/g, '’')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-zA-Z0-9#]+;/g, ' ');
}

/** Elements already display:none in the raw markup (inline style attribute)
 *  -- stays invisible with JS off too (CSS, not JS). */
function stripInlineHiddenElements(html) {
  let t = html;
  for (const tag of ['span', 'p', 'div', 'th', 'a', 'button']) {
    const re = new RegExp(`<${tag}\\b[^>]*style="[^"]*display:\\s*none[^"]*"[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    t = t.replace(re, ' ');
  }
  return t;
}

/** Elements marked data-hide-when-inspector="true" -- the ONE mechanism
 *  js/nav.js's _applyInspectorContextVisibility() hides at runtime. Removed
 *  before JS-ON extraction (a real inspector-context visitor never sees or
 *  can click these); left ALONE for JS-OFF extraction, since the JS that
 *  hides them never runs. */
function stripInspectorHiddenElements(html) {
  let t = html;
  for (const tag of ['span', 'p', 'div', 'a']) {
    const re = new RegExp(`<${tag}\\b[^>]*data-hide-when-inspector="true"[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    t = t.replace(re, ' ');
  }
  return t;
}

function staticRenderedText(html) {
  let t = html;
  t = t.replace(/<head[\s\S]*?<\/head>/i, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = stripInlineHiddenElements(t);
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  for (const safe of SAFE_SENTENCES) t = t.split(safe).join(' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function findFeeHits(text) {
  const hits = [];
  let m;
  FEE_TERM_RE.lastIndex = 0;
  while ((m = FEE_TERM_RE.exec(text)) !== null) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + m[0].length + 40);
    hits.push({ term: m[0], context: text.slice(start, end) });
  }
  return hits;
}

// ── Same-site link extraction ───────────────────────────────────────────
const SKIP_HREF_RE = /^(#|mailto:|tel:|javascript:|https?:\/\/(?!otterquote\.com))/i;

/**
 * A page's OWN <script> blocks build unrelated dynamic HTML strings at
 * runtime (referral links, signed URLs, etc.) that can contain the literal
 * substring `href="${...}"` -- template-literal JS source, never an actual
 * anchor a crawler could click. Strip <script> content before extracting
 * real <a href> tags, or the link graph fills with garbage nodes like
 * "${referralLink}.html".
 */
function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
}

/**
 * gh-2155 HI-05b: the mechanism this PR adds is scoped to the INSPECTOR's
 * own track through the referral-partner surface (nav/footer partner
 * links, the inspector's own agreement/app/dashboard/login pages, and the
 * two universally-shared entry points now hidden for that track,
 * partner-other.html and partners.html) -- it never touches, and Ben's
 * ruling never asked it to touch, OTHER professions' own dedicated pages
 * (partner-re.html, partner-insurance*.html, partner-adjusters.html each
 * legitimately keep showing THEIR OWN, unrelated fee structure -- an
 * inspector never lands on one through any inspector-gated link), the
 * shared legal document's UNTRACKED variant (only reachable, correctly,
 * from those other professions' own pages), generic site-wide legal
 * boilerplate (terms.html/privacy.html, which mention an unrelated
 * homeowner measurement fee and are linked from literally every footer on
 * the site regardless of partner type), or unrelated content (index.html's
 * homeowner sections, blog, guides, contractor-*, tools-*, the homeowner
 * refer-a-friend program, ref-inspector.html's own unrelated $15
 * measurement-fee mention). A role-tab switch to Homeowner/Contractor is a
 * deliberate, explicit "I am not browsing as a partner anymore" action,
 * not a leak. The crawl therefore stays inside the pages this fix's
 * mechanism actually gates. Any edge outside this set is a real,
 * deliberate exit out of the inspector's own track and is not followed
 * further -- exactly what a visitor who is not ALSO deliberately seeking
 * a different profession's program would encounter.
 */
const IN_SCOPE_PAGES = new Set([
  'hi-1.html',
  'partner-inspectors.html',
  'partner-agreement-inspector.html',
  'partner-app.html',
  'partner-app-install-ios.html',
  'partner-app-install-android.html',
  'partner-dashboard.html',
  'partner-login.html',
  'partner-profile.html',
  'partner-other.html',
  'partners.html',
]);
const IN_SCOPE_RE = { test: (f) => IN_SCOPE_PAGES.has(f.toLowerCase()) };

function extractSameSiteLinks(html) {
  const hrefs = [];
  const re = /<a\b[^>]*\bhref="([^"]+)"/gi;
  let m;
  while ((m = re.exec(stripScripts(html))) !== null) {
    let href = m[1];
    if (SKIP_HREF_RE.test(href)) continue;
    if (href.startsWith('https://otterquote.com')) href = href.slice('https://otterquote.com'.length) || '/';
    // Strip query/hash for the FILE identity used to load the next page's
    // bytes (the query string itself is still exercised via nav.js's own
    // ?track=/?agent_type= handling in the vm harness below), then
    // normalize away a leading "/" and any ".html" so "partner-app.html",
    // "/partner-app.html", "partner-app", and the Netlify pretty URL all
    // resolve to the SAME node -- exactly the normalization gh-2155 HI-05b
    // adds to js/nav.js itself (leak 1's root cause).
    let file = href.split(/[?#]/)[0];
    if (file.startsWith('/')) file = file.slice(1);
    if (!file.toLowerCase().endsWith('.html')) file += '.html';
    hrefs.push(file);
  }
  return hrefs;
}

// ── js/nav.js -- real header/footer link injection, inspector context ON ──
const navSrc = fs.readFileSync(path.join(repoRoot, 'js', 'nav.js'), 'utf8');
function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor (start) not found for ' + label);
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor (end) not found for ' + label);
  return src.slice(startIdx, endIdx);
}
const navBody = extractBetween(navSrc, 'const Nav = {', '\n};', 'js/nav.js Nav object literal')
  .replace('const Nav = {', 'var Nav = {') + '\n};\n';

function makeNoopEl() {
  return {
    style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', checked: false,
    addEventListener() {}, appendChild() {}, setAttribute() {}, removeAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, reset() {},
  };
}

/**
 * Renders the REAL js/nav.js header + footer for `pathname`, with the
 * session-scoped inspector-context flag already set (as it would be after
 * the visitor's first inspector-context page this session) and a guest
 * (signed-out) auth state -- the actual, unauthenticated audience hi-1.html
 * and partner-inspectors.html serve. Returns every href either injected.
 */
async function navInjectedLinks(pathname) {
  const headerEl = { dataset: {}, innerHTML: '' };
  const footerEl = { dataset: {}, innerHTML: '', style: {} };
  const authSlotEl = { innerHTML: '' };
  const mobileAuthSlotEl = { innerHTML: '' };
  const docStore = new Map([
    ['site-header', headerEl],
    ['site-footer', footerEl],
    ['nav-auth-slot', authSlotEl],
    ['nav-mobile-auth-slot', mobileAuthSlotEl],
  ]);
  const ctx = {
    window: {
      location: { pathname, search: '' },
      currentPartnerAgentType: undefined,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      // The persisted session flag gh-2155 HI-05b adds -- already '1'
      // because the visitor landed on hi-1.html/partner-inspectors.html
      // (or a ?track=/?agent_type= URL) earlier this same session.
      sessionStorage: { getItem: (k) => (k === 'oq_inspector_ctx' ? '1' : null), setItem() {}, removeItem() {} },
      URLSearchParams,
    },
    document: {
      getElementById: (id) => (docStore.has(id) ? docStore.get(id) : makeNoopEl()),
      querySelectorAll: () => [],
      createElement: () => makeNoopEl(),
      body: { appendChild() {}, insertBefore() {}, firstChild: null },
    },
    Auth: { getUser: () => Promise.resolve(null), getRole: () => Promise.resolve(null) },
    CONFIG: { SITE_NAME: 'Otter Quotes' },
    NAP: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', phoneTelHref: '', phoneDisplay: '', email: '' },
    URLSearchParams,
    Date,
    console,
    requestAnimationFrame: (fn) => fn(),
  };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(navBody, ctx);

  ctx.Nav.renderHeader({ active: '', showAuth: true });
  await new Promise((r) => setTimeout(r, 0)); // let _renderAuthSlot()'s await settle
  ctx.Nav.renderFooter();

  const combined = headerEl.innerHTML + authSlotEl.innerHTML + mobileAuthSlotEl.innerHTML + footerEl.innerHTML;
  const hrefs = [];
  const re = /href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(combined)) !== null) {
    let href = m[1];
    if (SKIP_HREF_RE.test(href)) continue;
    let file = href.split(/[?#]/)[0];
    if (file.startsWith('/')) file = file.slice(1);
    if (!file) file = 'index.html';
    if (!file.toLowerCase().endsWith('.html')) file += '.html';
    hrefs.push(file);
  }
  return hrefs;
}

/** Does `file` render its header/footer through js/nav.js at all? Both
 *  data-skip-nav="true" (hi-1.html's own S05 perf opt-out) short-circuit --
 *  no dynamic nav edges exist on that page. */
function rendersNav(html) {
  const headerSkip = /<header\b[^>]*id="site-header"[^>]*data-skip-nav="true"/i.test(html);
  const footerSkip = /<footer\b[^>]*id="site-footer"[^>]*data-skip-nav="true"/i.test(html);
  const hasHeader = /<header\b[^>]*id="site-header"/i.test(html);
  const hasFooter = /<footer\b[^>]*id="site-footer"/i.test(html);
  return (hasHeader && !headerSkip) || (hasFooter && !footerSkip);
}

function readPage(file) {
  const p = path.join(repoRoot, file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// ── BFS crawl ────────────────────────────────────────────────────────────
async function crawl({ starts, maxDepth, jsOn, respectInspectorHiding }) {
  const visited = new Map(); // file -> depth
  const hits = []; // { file, term, context }
  let queue = starts.map((f) => ({ file: f, depth: 0 }));
  for (const s of starts) visited.set(s, 0);

  while (queue.length) {
    const { file, depth } = queue.shift();
    const html = readPage(file);
    if (html === null) continue; // link to a page outside this worktree/build step -- not this test's concern

    // Scan THIS page's own rendered text.
    const forText = respectInspectorHiding ? stripInspectorHiddenElements(html) : html;
    const text = staticRenderedText(forText);
    for (const h of findFeeHits(text)) hits.push({ file, term: h.term, context: h.context });

    if (depth >= maxDepth) continue;

    // Outgoing edges: the page's own static links, always.
    const forLinks = respectInspectorHiding ? stripInspectorHiddenElements(html) : html;
    let edges = extractSameSiteLinks(forLinks);

    // JS-ON only: also the links js/nav.js's header/footer inject, unless
    // this specific page opts out of nav.js entirely (data-skip-nav).
    if (jsOn && rendersNav(html)) {
      edges = edges.concat(await navInjectedLinks('/' + file));
    }

    edges = edges.filter((e) => IN_SCOPE_RE.test(e));

    for (const next of edges) {
      const nextDepth = depth + 1;
      if (visited.has(next) && visited.get(next) <= nextDepth) continue;
      visited.set(next, nextDepth);
      if (nextDepth <= maxDepth) queue.push({ file: next, depth: nextDepth });
    }
  }

  return { visited: [...visited.keys()], hits };
}

// ── Scenario 1: JS ON, 3 levels deep, inspector context set ───────────────
{
  const { visited, hits } = await crawl({
    starts: ['hi-1.html', 'partner-inspectors.html'],
    maxDepth: 3,
    jsOn: true,
    respectInspectorHiding: true,
  });

  console.log(`\n[JS-ON crawl] visited ${visited.length} page(s) within 3 hops of hi-1.html / partner-inspectors.html: ${visited.sort().join(', ')}\n`);

  if (hits.length === 0) {
    ok(true, 'JS-ON crawler (3 levels): no fee/bonus/commission/payout/"Get paid"/$ text anywhere reachable from hi-1.html or partner-inspectors.html');
  } else {
    for (const h of hits) {
      failWithReason(`JS-ON crawler: ${h.file} renders no forbidden fee wording`, `"${h.term}" in "...${h.context}..."`);
    }
  }

  // The three leaks named in #2152 comment 5839667108, confirmed FIXED
  // (also exercised in isolation by tests/gh2155-hi0c-inspector-sweep.mjs,
  // but pinned here directly against the crawl's own findings).
  ok(!visited.includes('partner-other.html'),
    'JS-ON crawler: partner-other.html (leak 2 destination -- "Join the referral program") is NOT reachable while inspector context is set');
  ok(!visited.includes('partners.html'),
    'JS-ON crawler: partners.html (fee-program picker) is NOT reachable while inspector context is set');
}

// ── Scenario 2: JS OFF, 1 level, static markup + edges only ───────────────
{
  const { visited, hits } = await crawl({
    starts: ['hi-1.html', 'partner-inspectors.html'],
    maxDepth: 1,
    jsOn: false,
    respectInspectorHiding: false, // the JS that reads data-hide-when-inspector never runs
  });

  console.log(`\n[JS-OFF crawl] visited ${visited.length} page(s) within 1 hop of hi-1.html / partner-inspectors.html: ${visited.sort().join(', ')}\n`);

  if (hits.length === 0) {
    ok(true, 'JS-OFF crawler (1 level, no script execution): no fee/bonus/commission/payout/"Get paid"/$ text on hi-1.html, partner-inspectors.html, or anything one hop from them');
  } else {
    for (const h of hits) {
      failWithReason(`JS-OFF crawler: ${h.file} renders no forbidden fee wording with JavaScript disabled`, `"${h.term}" in "...${h.context}..."`);
    }
  }
}

// ── NEGATIVE CONTROL: partner-re.html (realtor, untouched by D-333) ───────
// Proves the crawl+regex methodology actually finds real fee text, not
// just an artifact of over-aggressive stripping -- same precedent as
// tests/gh2155-hi0c-inspector-sweep.mjs's own negative controls, run
// through the CRAWLER itself this time (no inspector-context stripping,
// since a realtor is never in inspector context).
{
  const { hits } = await crawl({
    starts: ['partner-re.html'],
    maxDepth: 1,
    jsOn: true,
    respectInspectorHiding: false,
  });
  ok(hits.some((h) => h.term === '$200') && hits.some((h) => h.term === '$50'),
    'NEGATIVE CONTROL: the same crawler, started from partner-re.html (a realtor, not inspector context), still finds the $200 and $50 fee amounts -- proves the crawl is not vacuous');
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
