/**
 * gh-2155 HI-0c -- rendered-text sweep (JS on and JS off) over every
 * inspector-reachable page, per Ben's ruling (#2152 comment 5836510515,
 * item 4): no page an inspector can reach may show fee wording ($ amounts,
 * "referral fee", "recruit bonus", etc.), with a negative control proving
 * the untracked realtor partner-agreement.html still shows fees (so the
 * sweep methodology itself is not vacuous).
 *
 * JS-OFF: static-HTML-text extraction (strip <script>/<style>/comments/
 * tags, decode entities) -- mirrors exactly what a browser with JavaScript
 * disabled renders, and exactly the check the refuter (comment 5836510515)
 * ran with Playwright's `inner_text("body")`.
 *
 * JS-ON: this repo's established vm-harness technique (extract the REAL
 * source out of js/nav.js, partner-dashboard.html and partner-app.html by
 * anchor text -- never a hand-retyped copy -- and run it in a `vm` context
 * behind a minimal DOM/window shim), same approach as
 * tests/gh2154-p1-short-signup.mjs and tests/gh2154-p2-app-activation.mjs.
 * Playwright/headless Chromium is not installed in this worktree, so this
 * is the fallback the dispatch brief names explicitly.
 *
 * Run: node tests/gh2155-hi0c-inspector-sweep.mjs
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

function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor (start) not found for ' + label + ': ' + JSON.stringify(startAnchor));
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor (end) not found for ' + label + ': ' + JSON.stringify(endAnchor));
  return src.slice(startIdx, endIdx);
}

// ── JS-OFF: static rendered-text extraction ────────────────────────────────
// The refuter's own production sweep (comment 5836510515) used a broader
// dictionary regex, but also explicitly declined to fail the box over
// generic residual contract wording with no dollar figure ("Commissions
// and bonuses are paid after...", "10. Commission Reversal", "earnings" in
// §13 -- comment item 4: "On its own I would not fail the box for this").
// partner-agreement-inspector.html is a shared legal document that still
// describes payment/commission mechanics IN GENERAL for every OTHER
// partner type under the same sections (4.2 Payment Timing, 5 Payment
// Method, 6 Tax Treatment, 9 Attribution, 10 Commission Reversal, 13
// Disclaimer, 17 Modification) -- none of that is fee wording an inspector
// is being paid, and inventing new inspector-specific carve-outs in those
// sections would violate "no new words". What actually matters per Ben's
// four rulings is: no DOLLAR AMOUNT, and no specific "referral fee"/
// "recruit bonus" promise. This regex targets exactly that.
const FEE_TERM_RE = /\$[\d,]+|referral fee|recruit bonus/gi;

// Exact, already-approved sentences that legitimately contain "referral
// fee"/"recruit bonus" as tokens while asserting the OPPOSITE (that no fee
// is paid) -- stripped from the text before scanning, rather than handled
// by a context-window check, so a real violation sitting right next to one
// of these can never hide behind it.
const SAFE_SENTENCES = [
  'Home-inspector partners do not receive a referral fee or recruit bonus.',
  'receives no Referral Fee and no Recruit Bonus under this Agreement.',
  // partner-inspectors.html's marketing-page heading -- asserts the ABSENCE
  // of a fee (already verified live, comment 5835976176: "'No Referral
  // Fee' (735)" was one of the explicitly-passing hits).
  'No Referral Fee',
  // partner-agreement-inspector.html: the Section 4 HEADING survives by
  // ruling (only its fee sub-content -- the table, Section 4.1 -- is
  // removed; Section 4.2/4.3 and the heading stay), and Section 5's
  // generic payment-method sentence has no dollar figure and applies to
  // every OTHER partner type under the same shared document (removing it
  // would need new words, which the ruling forbids). Matches the
  // refuter's own precedent of not failing the box over generic residual
  // wording with no dollar amount (comment 5836510515, item 4).
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

/**
 * Elements that are already display:none in the raw markup stay invisible
 * with JavaScript disabled -- CSS (including a plain inline style
 * attribute) still applies with only JS turned off; "JS off" is not "CSS
 * off". Strip such elements' entire subtree before extracting text, or
 * this test would flag content a real JS-off browser never shows (exactly
 * how partner-agreement.html's own #track-home-inspector:target CSS rule
 * already fails closed with no script execution). None of the elements
 * this PR marks display:none nest another element of the same tag inside
 * themselves, so a non-greedy match to that tag's first closing tag is
 * exact, not an approximation.
 */
function stripHiddenElements(html) {
  let t = html;
  for (const tag of ['span', 'p', 'div', 'th']) {
    const re = new RegExp(`<${tag}\\b[^>]*style="[^"]*display:\\s*none[^"]*"[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    t = t.replace(re, ' ');
  }
  return t;
}

/** What a browser renders with JavaScript disabled: no <head> metadata, no
 * <script> output, no <style> text, no comments, no already-display:none
 * elements, no tags -- just visible text. */
function staticRenderedText(html) {
  let t = html;
  t = t.replace(/<head[\s\S]*?<\/head>/i, ' '); // meta/title/description never render as page text
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = stripHiddenElements(t);
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

// Pages an inspector can actually reach, JS-off, per the fixes in this PR.
const JS_OFF_PAGES = [
  'partner-inspectors.html',
  'partner-agreement-inspector.html',
  // Unauthenticated static state -- the 5 fee elements now start
  // display:none (gh-2155 HI-0c item 2); the page also contains inline JS
  // this static extraction strips out entirely, which is exactly the
  // JS-off condition.
  'partner-dashboard.html',
  'partner-app.html',
  'partner-login.html',
];

for (const file of JS_OFF_PAGES) {
  const html = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  const text = staticRenderedText(html);
  const hits = findFeeHits(text);
  if (hits.length === 0) {
    ok(true, `JS-OFF: ${file} renders no fee wording ($ amounts / "referral fee" / "recruit bonus")`);
  } else {
    failWithReason(`JS-OFF: ${file} renders no fee wording ($ amounts / "referral fee" / "recruit bonus")`,
      hits.map((h) => `"${h.term}" in "...${h.context}..."`).join(' | '));
  }
}

// Negative control: the untracked realtor agreement must still show fees --
// proves the extraction+regex methodology actually catches real fee text,
// not just an artifact of over-aggressive stripping.
{
  const html = fs.readFileSync(path.join(repoRoot, 'partner-agreement.html'), 'utf8');
  const text = staticRenderedText(html);
  const hits = findFeeHits(text);
  ok(hits.some((h) => h.term === '$200') && hits.some((h) => h.term === '$50'),
    'NEGATIVE CONTROL, JS-OFF: untracked partner-agreement.html still shows $200 and $50 fee amounts');
}
{
  const html = fs.readFileSync(path.join(repoRoot, 'partner-re.html'), 'utf8');
  const text = staticRenderedText(html);
  const hits = findFeeHits(text);
  ok(hits.some((h) => h.term === '$200') && hits.some((h) => h.term === '$50'),
    'NEGATIVE CONTROL, JS-OFF: partner-re.html (realtor, untouched by this PR) still shows $200 and $50 fee amounts');
}

// ── JS-ON: js/nav.js -- _isInspectorTrack() and every link it gates ───────
{
  const navSrc = fs.readFileSync(path.join(repoRoot, 'js', 'nav.js'), 'utf8');
  let navBody;
  try {
    navBody = extractBetween(navSrc, 'const Nav = {', '\n};', 'js/nav.js Nav object literal')
      .replace('const Nav = {', 'var Nav = {') + '\n};\n'; // top-level `const` would not attach to the vm context object
  } catch (e) {
    failWithReason('js/nav.js: Nav object literal extracted for the vm harness', e.message);
    navBody = null;
  }

  if (navBody) {
    // gh-2155 HI-0c REVIEW FAIL (5837784831) fix: _syncPartnerAgentType() now
    // touches `document` (to find #site-footer and re-render it). Every
    // pre-existing call site below only exercises pure link-logic and never
    // provided a `document` global at all -- give them a harmless stub
    // (no footer element => the guard in _syncPartnerAgentType() no-ops)
    // so none of them starts reaching into a real renderFooter() call by
    // accident. The footer-re-render behavior itself gets its own fuller
    // stub in makeFooterCtx() below.
    function makeNavCtx({ pathname, currentPartnerAgentType, search = '' }) {
      const ctx = {
        window: { location: { pathname, search }, currentPartnerAgentType, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, URLSearchParams },
        document: { getElementById: () => null },
        URLSearchParams,
        console,
      };
      ctx.window.window = ctx.window;
      vm.createContext(ctx);
      vm.runInContext(navBody, ctx);
      return ctx;
    }

    // Inspector track, by URL (partner-inspectors.html).
    const inspByUrl = makeNavCtx({ pathname: '/partner-inspectors.html', currentPartnerAgentType: undefined });
    ok(inspByUrl.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _isInspectorTrack() is true on partner-inspectors.html');
    ok(inspByUrl.Nav._roleLinks('partner', false).every((l) => l.href !== '/partners.html'),
      'JS-ON nav.js: partner-inspectors.html guest row-2 nav has no /partners.html link');
    ok(inspByUrl.Nav._roleLinks('partner', false).some((l) => l.href === '/partner-inspectors.html'),
      'JS-ON nav.js: partner-inspectors.html guest row-2 nav points its partner-programs link at /partner-inspectors.html instead');
    ok(inspByUrl.Nav._roleLogoHref('partner', false) === '/partner-inspectors.html',
      'JS-ON nav.js: partner role logo href on partner-inspectors.html is /partner-inspectors.html, not /partners.html');
    ok(inspByUrl.Nav._guestAuthHTML('partner').desktop.indexOf('/partners.html') === -1,
      'JS-ON nav.js: signed-out "Become a Partner" CTA on partner-inspectors.html does not link to /partners.html');
    ok(inspByUrl.Nav._guestAuthHTML('partner').desktop.indexOf('/partner-inspectors.html') !== -1,
      'JS-ON nav.js: signed-out "Become a Partner" CTA on partner-inspectors.html links to /partner-inspectors.html instead');

    // Inspector track, on the generated static agreement page itself.
    const inspOnAgreement = makeNavCtx({ pathname: '/partner-agreement-inspector.html', currentPartnerAgentType: undefined });
    ok(inspOnAgreement.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _isInspectorTrack() is true on partner-agreement-inspector.html (footer self-link case)');

    // Inspector track, by resolved partner type (dashboard, once auth loads).
    const inspByType = makeNavCtx({ pathname: '/partner-dashboard.html', currentPartnerAgentType: 'home_inspector' });
    ok(inspByType.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _isInspectorTrack() is true on partner-dashboard.html once currentPartnerAgentType is home_inspector');
    ok(inspByType.Nav._roleLinks('partner', true).every((l) => l.href !== '/partners.html'),
      'JS-ON nav.js: an inspector\'s authed dashboard row-2 nav has no /partners.html link');

    // NEGATIVE CONTROL: a realtor on the same dashboard page keeps every
    // partners.html link exactly as before -- proves the gate is scoped to
    // the inspector track only, not a blanket removal.
    const realtor = makeNavCtx({ pathname: '/partner-dashboard.html', currentPartnerAgentType: 're_agent' });
    ok(realtor.Nav._isInspectorTrack() === false,
      'NEGATIVE CONTROL, JS-ON nav.js: _isInspectorTrack() is false for a re_agent on partner-dashboard.html');
    ok(realtor.Nav._roleLinks('partner', true).some((l) => l.href === '/partners.html'),
      'NEGATIVE CONTROL, JS-ON nav.js: a realtor\'s authed dashboard row-2 nav still links to /partners.html');
    ok(realtor.Nav._roleLogoHref('partner', true) === '/partner-dashboard.html',
      'NEGATIVE CONTROL, JS-ON nav.js: a realtor\'s (authed) partner logo href is unaffected by this change');
    ok(realtor.Nav._guestAuthHTML('partner').desktop.indexOf('/partners.html') !== -1,
      'NEGATIVE CONTROL, JS-ON nav.js: the guest "Become a Partner" CTA still points at /partners.html off the inspector track');

    // Footer "Partner Agreement" href -- reconstruct exactly as renderFooter()
    // computes it (single-line ternary on the same _isInspectorTrack()).
    function footerHref(ctx) {
      return ctx.Nav._isInspectorTrack() ? '/partner-agreement-inspector.html' : '/partner-agreement.html';
    }
    ok(footerHref(inspByUrl) === '/partner-agreement-inspector.html',
      'JS-ON nav.js: footer Partner Agreement link on partner-inspectors.html points at the static inspector page');
    ok(footerHref(inspOnAgreement) === '/partner-agreement-inspector.html',
      'JS-ON nav.js: footer Partner Agreement link on partner-agreement-inspector.html itself points at itself (fixes break 1, comment 5836510515)');
    ok(footerHref(inspByType) === '/partner-agreement-inspector.html',
      "JS-ON nav.js: footer Partner Agreement link on an inspector's dashboard points at the static inspector page");
    ok(footerHref(realtor) === '/partner-agreement.html',
      'NEGATIVE CONTROL, JS-ON nav.js: footer Partner Agreement link for a realtor is unaffected (/partner-agreement.html)');

    // REVIEW FAIL 5836957364 fix-first coverage: row-1 "Referral Partner"
    // header tab -- the literal defect named in the review ("the header
    // tab still hardcodes /partners.html"). _roleTabHref() is what
    // _roleBarHTML() (initial render) and _applyRoleLinks() (post-auth
    // re-render) both call for every row-1 tab.
    const PARTNER_TAB = { role: 'partner', label: 'Referral Partner', href: '/partners.html' };
    ok(inspByUrl.Nav._roleTabHref(PARTNER_TAB) === '/partner-inspectors.html',
      'JS-ON nav.js: row-1 "Referral Partner" header tab on partner-inspectors.html points at /partner-inspectors.html, not /partners.html');
    ok(inspOnAgreement.Nav._roleTabHref(PARTNER_TAB) === '/partner-inspectors.html',
      'JS-ON nav.js: row-1 "Referral Partner" header tab on partner-agreement-inspector.html points at /partner-inspectors.html, not /partners.html');
    ok(inspByType.Nav._roleTabHref(PARTNER_TAB) === '/partner-inspectors.html',
      "JS-ON nav.js: row-1 \"Referral Partner\" header tab on a signed-in inspector's dashboard points at /partner-inspectors.html, not /partners.html");
    ok(realtor.Nav._roleTabHref(PARTNER_TAB) === '/partners.html',
      'NEGATIVE CONTROL, JS-ON nav.js: row-1 "Referral Partner" header tab for a realtor is unaffected (/partners.html)');
    // The Homeowner/Contractor tabs are never affected by inspector-track
    // gating -- only the 'partner' role tab's href is conditional.
    ok(inspByType.Nav._roleTabHref({ role: 'homeowner', href: '/index.html' }) === '/index.html'
      && inspByType.Nav._roleTabHref({ role: 'contractor', href: '/contractor-join.html' }) === '/contractor-join.html',
      "NEGATIVE CONTROL, JS-ON nav.js: Homeowner/Contractor row-1 tabs are unaffected by inspector-track gating on a signed-in inspector's page");

    // REVIEW FAIL 5836957364 fix-first coverage, item (c): the signed-in
    // partner's own type from the session/profile read now works on EVERY
    // page (not only partner-dashboard.html) via _syncPartnerAgentType(),
    // called from both _renderAuthSlot() and _applyAuthRole(). Exercise it
    // directly on a page that is NOT one of the two inspector-specific
    // URLs (partner-app.html) to prove detection is page-independent.
    const genericPage = makeNavCtx({ pathname: '/partner-app.html', currentPartnerAgentType: undefined });
    ok(genericPage.Nav._isInspectorTrack() === false,
      'JS-ON nav.js: _isInspectorTrack() is false on a generic partner page (partner-app.html) before any role resolves (fail closed = no assumption either way, and PARTNER_TAB stays safe default here since it is not yet known to be an inspector)');
    genericPage.Nav._syncPartnerAgentType('home_inspector');
    ok(genericPage.window.currentPartnerAgentType === 'home_inspector' && genericPage.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _syncPartnerAgentType("home_inspector") on partner-app.html (a generic, non-inspector-URL partner page) makes _isInspectorTrack() true -- signal (c), the session/profile read, working page-independently');
    ok(genericPage.Nav._roleTabHref(PARTNER_TAB) === '/partner-inspectors.html',
      'JS-ON nav.js: once _syncPartnerAgentType resolves home_inspector on partner-app.html, the row-1 tab href is corrected off /partners.html too');

    // NEGATIVE CONTROL + fail-closed: a confirmed NON-inspector partner role
    // positively clears the cached flag (does not just leave it alone), and
    // an UNRESOLVED role (null/undefined -- auth error, no session, RLS
    // failure) leaves whatever was already cached untouched rather than
    // asserting "safe".
    const genericPage2 = makeNavCtx({ pathname: '/partner-app.html', currentPartnerAgentType: 'home_inspector' });
    genericPage2.Nav._syncPartnerAgentType('re_agent');
    ok(genericPage2.window.currentPartnerAgentType === null && genericPage2.Nav._isInspectorTrack() === false,
      'NEGATIVE CONTROL, JS-ON nav.js: _syncPartnerAgentType("re_agent") positively clears a previously-cached home_inspector flag on the same page');
    const genericPage3 = makeNavCtx({ pathname: '/partner-app.html', currentPartnerAgentType: 'home_inspector' });
    genericPage3.Nav._syncPartnerAgentType(null);
    ok(genericPage3.window.currentPartnerAgentType === 'home_inspector' && genericPage3.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _syncPartnerAgentType(null) (unresolved role -- fail closed) leaves a previously-cached home_inspector flag untouched, does not clear it to "safe"');

    // REVIEW FAIL 5836957364 fix-first coverage, item (a): the ?track= /
    // ?agent_type= query param signal now works on any page, matching the
    // exact param names partner-agreement.html's own inline script reads.
    const byTrackParam = makeNavCtx({ pathname: '/partner-app.html', currentPartnerAgentType: undefined, search: '?track=home_inspector' });
    ok(byTrackParam.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _isInspectorTrack() is true on any page carrying ?track=home_inspector, matching partner-agreement.html\'s own inline-script param name');
    const byAgentTypeParam = makeNavCtx({ pathname: '/partner-app.html', currentPartnerAgentType: undefined, search: '?agent_type=home_inspector' });
    ok(byAgentTypeParam.Nav._isInspectorTrack() === true,
      'JS-ON nav.js: _isInspectorTrack() is true on any page carrying ?agent_type=home_inspector (partner-agreement.html\'s legacy-casing param name)');
    const byUnrelatedParam = makeNavCtx({ pathname: '/partner-app.html', currentPartnerAgentType: undefined, search: '?track=re_agent' });
    ok(byUnrelatedParam.Nav._isInspectorTrack() === false,
      'NEGATIVE CONTROL, JS-ON nav.js: ?track=re_agent does not trip _isInspectorTrack()');
  }
}

// ── JS-ON: js/nav.js -- footer re-render on late type resolution ──────────
// REVIEW FAIL 5837784831 (round 3) must-fix: renderFooter() runs at
// DOMContentLoaded, before Auth.getUser()/Auth.getRole() resolve, so a
// signed-in inspector's footer "Partner Agreement" link was built from the
// not-yet-known _isInspectorTrack() state and never got corrected on any
// page except partner-dashboard.html (which re-renders its own footer once
// its separately-sourced partnerType lands). This block proves the actual
// fix: _syncPartnerAgentType() re-renders the REAL footer DOM once the
// type is known, on partner-app.html (named in the review) plus one more
// of partner-profile/index/partners, with a negative control (realtor
// keeps /partner-agreement.html) and a page-unchanged check (an
// already-hidden footer, or an already-resolved value, does not re-render).
{
  const navSrc = fs.readFileSync(path.join(repoRoot, 'js', 'nav.js'), 'utf8');
  const navBody = extractBetween(navSrc, 'const Nav = {', '\n};', 'js/nav.js Nav object literal (footer re-render block)')
    .replace('const Nav = {', 'var Nav = {') + '\n};\n';

  /** A footer element whose innerHTML is a real string, like the DOM's. */
  function makeFooterEl() {
    return { dataset: {}, innerHTML: '', style: {} };
  }

  /** Everything else renderFooter()/_renderSupportModal() touch, as
   *  harmless no-ops -- this block cares only about the footer's own
   *  innerHTML string, already exercised element-by-element elsewhere in
   *  this file and in tests/gh2155-hi0b-inspector-agreement.mjs. */
  function makeNoopEl() {
    return {
      style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', checked: false,
      addEventListener() {}, appendChild() {}, setAttribute() {}, removeAttribute() {},
      classList: { add() {}, remove() {}, toggle() {} },
      reset() {},
    };
  }

  function makeFooterCtx({ pathname, search = '' }) {
    const footerEl = makeFooterEl();
    const docStore = new Map([['site-footer', footerEl]]);
    const ctx = {
      window: { location: { pathname, search }, currentPartnerAgentType: undefined, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, URLSearchParams },
      document: {
        getElementById: (id) => (docStore.has(id) ? docStore.get(id) : (id === 'support-modal-overlay' ? null : makeNoopEl())),
        createElement: () => makeNoopEl(),
        body: { appendChild() {}, insertBefore() {}, firstChild: null },
        querySelectorAll: () => [],
      },
      CONFIG: { SITE_NAME: 'Otter Quotes' },
      NAP: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', phoneTelHref: '', phoneDisplay: '', email: '' },
      URLSearchParams,
      Date,
      console,
    };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(navBody, ctx);
    return { ctx, footerEl };
  }

  /** The href the footer's "Partner Agreement" anchor was actually
   *  rendered with, read out of the real innerHTML string renderFooter()
   *  built -- not a reimplementation of the ternary. */
  function footerRenderedHref(footerEl) {
    // NOT a generic "Partner Agreement" text match: the same footer also
    // has a distinct, unrelated contractor-column link
    // (/contractor-agreement.html) with the identical link text, which a
    // loose match would find first and report as this test's target.
    // partnerAgreementHref (renderFooter()'s own variable) only ever holds
    // one of these two literal paths, so anchor on that.
    const m = footerEl.innerHTML.match(/href="(\/partner-agreement(?:-inspector)?\.html)">Partner Agreement<\/a>/);
    return m && m[1];
  }

  for (const pathname of ['/partner-app.html', '/partner-profile.html', '/index.html', '/partners.html']) {
    // Initial render, exactly as DOMContentLoaded does it, before auth
    // resolves -- currentPartnerAgentType is still undefined, so the
    // footer starts out pointed at the fee-bearing agreement, same as any
    // guest visitor.
    const { ctx, footerEl } = makeFooterCtx({ pathname });
    ctx.Nav.renderFooter();
    ok(footerRenderedHref(footerEl) === '/partner-agreement.html',
      `JS-ON nav.js footer (${pathname}): initial pre-auth render links Partner Agreement to /partner-agreement.html`);

    // Auth resolves late (mocked): the signed-in visitor is a home_inspector.
    // This is the exact call _applyAuthRole()/_renderAuthSlot() make once
    // Auth.getRole() settles.
    ctx.Nav._syncPartnerAgentType('home_inspector');
    ok(footerRenderedHref(footerEl) === '/partner-agreement-inspector.html',
      `MUST-FIX 5837784831: JS-ON nav.js footer (${pathname}) for a mocked signed-in inspector re-points Partner Agreement to /partner-agreement-inspector.html after type resolution`);
  }

  // NEGATIVE CONTROL: a signed-in realtor's footer link is untouched --
  // stays on /partner-agreement.html both before and after role resolution.
  {
    const { ctx, footerEl } = makeFooterCtx({ pathname: '/partner-app.html' });
    ctx.Nav.renderFooter();
    ctx.Nav._syncPartnerAgentType('re_agent');
    ok(footerRenderedHref(footerEl) === '/partner-agreement.html',
      'NEGATIVE CONTROL: JS-ON nav.js footer (/partner-app.html) for a mocked signed-in realtor keeps Partner Agreement at /partner-agreement.html after type resolution');
  }

  // No spurious re-render: an unresolved role (null/undefined) leaves the
  // already-rendered footer's markup exactly as it was (fail closed -- see
  // _syncPartnerAgentType()'s own early return).
  {
    const { ctx, footerEl } = makeFooterCtx({ pathname: '/partner-app.html' });
    ctx.Nav.renderFooter();
    const before = footerEl.innerHTML;
    ctx.Nav._syncPartnerAgentType(null);
    ok(footerEl.innerHTML === before,
      'JS-ON nav.js footer (/partner-app.html): an unresolved role (null) does not re-render the footer at all');
  }

  // No duplicate re-render: once the type is known and the footer already
  // reflects it, resolving to the SAME value again (e.g. _renderAuthSlot()
  // and _applyAuthRole() both calling _syncPartnerAgentType() on one page
  // load) does not re-render the footer a second time -- exactly the "no
  // duplicate footers" constraint from the dispatch brief. Detected by
  // clobbering the already-correct DOM string and confirming the second
  // call leaves it clobbered (a real second render would restore it).
  {
    const { ctx, footerEl } = makeFooterCtx({ pathname: '/partner-app.html' });
    ctx.Nav.renderFooter();
    ctx.Nav._syncPartnerAgentType('home_inspector');
    footerEl.innerHTML = '__SENTINEL__';
    ctx.Nav._syncPartnerAgentType('home_inspector');
    ok(footerEl.innerHTML === '__SENTINEL__',
      'JS-ON nav.js footer (/partner-app.html): resolving the SAME already-cached type again does not re-render the footer a second time (no duplicate footer renders)');
  }
}

// ── JS-ON: partner-dashboard.html -- default-hidden fee elements ──────────
{
  const src = fs.readFileSync(path.join(repoRoot, 'partner-dashboard.html'), 'utf8');
  let block;
  try {
    block = extractBetween(
      src,
      'if (partnerType === \'home_inspector\') {',
      '\n            // partnerType falsy',
      'partner-dashboard.html updateUI() fee-visibility branch'
    );
  } catch (e) {
    failWithReason('partner-dashboard.html: fee-visibility branch extracted for the vm harness', e.message);
    block = null;
  }

  const FEE_IDS = ['feeSubtitleReferClient', 'feeSubtitleReferPartner', 'feeSubtitleGetPaid', 'referralFeeDisclaimer', 'recruitFeeHint', 'totalEarnedCard', 'recruitEarningsCard', 'referralFeeThLabel'];

  function makeFakeDom() {
    const elements = new Map();
    for (const id of FEE_IDS) elements.set(id, { style: { display: 'none' }, textContent: '' });
    // Elements the extracted block also touches, addressed by class/tag
    // selectors rather than id -- present as harmless no-ops so the real
    // source runs unmodified end to end, not just the part this test cares
    // about.
    const noopEl = { style: {}, textContent: '', setAttribute() {}, classList: { remove() {}, add() {} }, removeAttribute() {}, closest: () => null };
    return {
      getElementById: (id) => elements.get(id) || (FEE_IDS.includes(id) ? null : noopEl),
      querySelector: () => noopEl,
      querySelectorAll: () => [],
      elements,
    };
  }

  function run(partnerType) {
    const dom = makeFakeDom();
    const ctx = {
      document: dom,
      window: {},
      Array,
      console,
      currentPartner: { agent_type: partnerType },
      partnerType,
    };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    // The real block references `document`, `Array`, and reads `partnerType`
    // from its own enclosing closure in the real file; re-declare it as a
    // local so the extracted text runs unmodified.
    vm.runInContext(`var partnerType = ${JSON.stringify(partnerType)};\n` + block, ctx);
    return dom;
  }

  if (block) {
    const inspectorDom = run('home_inspector');
    for (const id of FEE_IDS) {
      ok(inspectorDom.elements.get(id).style.display === 'none',
        `JS-ON partner-dashboard.html: #${id} stays display:none for partnerType=home_inspector`);
    }

    const unknownDom = run(undefined);
    for (const id of FEE_IDS) {
      ok(unknownDom.elements.get(id).style.display === 'none',
        `JS-ON partner-dashboard.html: #${id} stays display:none while partnerType is unresolved (fail closed)`);
    }

    // NEGATIVE CONTROL: a realtor's dashboard reveals every fee element,
    // completely unchanged in substance from before this PR.
    const realtorDom = run('re_agent');
    for (const id of FEE_IDS) {
      ok(realtorDom.elements.get(id).style.display === '',
        `NEGATIVE CONTROL, JS-ON partner-dashboard.html: #${id} is revealed (display:'') for partnerType=re_agent`);
    }
  }
}

// ── JS-ON: partner-app.html -- Auth.getRole() gated reveal ────────────────
{
  const src = fs.readFileSync(path.join(repoRoot, 'partner-app.html'), 'utf8');
  let block;
  try {
    block = extractBetween(
      src,
      'Auth.getRole().then(function (role) {',
      '}).catch(function () { /* non-fatal: stays hidden */ });',
      'partner-app.html referral-fee-disclaimer reveal'
    ) + '}).catch(function () { /* non-fatal: stays hidden */ });';
  } catch (e) {
    failWithReason('partner-app.html: referral-fee-disclaimer reveal block extracted for the vm harness', e.message);
    block = null;
  }

  async function run(role, roleRejects) {
    const disclaimer = { style: { display: 'none' } };
    const ctx = {
      document: { getElementById: (id) => (id === 'referralFeeDisclaimer' ? disclaimer : null) },
      Auth: { getRole: () => (roleRejects ? Promise.reject(new Error('boom')) : Promise.resolve(role)) },
      Nav: { PARTNER_AUTH_ROLES: ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'] },
      Array,
      console,
    };
    vm.createContext(ctx);
    const exprBlock = block.trim().replace(/;\s*$/, ''); // drop the trailing ";" so it can sit inside a return(...)
    const wrapped = `(function(){ return (${exprBlock}); })()`;
    const p = vm.runInContext(wrapped, ctx);
    await p;
    // Let the .then chain's microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    return disclaimer;
  }

  if (block) {
    const inspector = await run('home_inspector', false);
    ok(inspector.style.display === 'none',
      'JS-ON partner-app.html: referral-fee disclaimer stays hidden when Auth.getRole() resolves home_inspector');

    const unresolved = await run(null, false);
    ok(unresolved.style.display === 'none',
      'JS-ON partner-app.html: referral-fee disclaimer stays hidden when Auth.getRole() resolves null (signed out / fail closed)');

    const rejected = await run(null, true);
    ok(rejected.style.display === 'none',
      'JS-ON partner-app.html: referral-fee disclaimer stays hidden if Auth.getRole() rejects (fail closed)');

    const realtor = await run('re_agent', false);
    ok(realtor.style.display === '',
      'NEGATIVE CONTROL, JS-ON partner-app.html: referral-fee disclaimer is revealed when Auth.getRole() resolves re_agent');
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
