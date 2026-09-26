/**
 * gh-2154 P-5 frontend round (Ben's LEGAL ruling, bus
 * 2026-09-25T14:11:18Z): "Activation happens only when the partner accepts
 * v3-2026-09 through the real signup/accept step (P-1 flow, prefilled via
 * a signed invite link)". The backend half (supabase/functions/
 * partner-invite-accept/, GET prefill + POST accept) shipped at head
 * 64c1ebb9 with no client to call it. This file covers the ONE dedicated
 * page that client is: partner-invite.html.
 *
 * FAIL-FIRST: partner-invite.html does not exist at 64c1ebb9 (or on any
 * earlier commit) -- there was no partner-*.html page in this repo whose
 * name matched before this round. `git show 64c1ebb9:partner-invite.html`
 * fails with "does not exist" and is asserted as check (0) below, so this
 * file fails outright against the base commit and passes only once the
 * page exists with the right behavior.
 *
 * Technique: extract the REAL inline <script> IIFE out of
 * partner-invite.html by anchor text (never a hand-retyped copy) and run
 * it in a Node `vm` context behind a minimal DOM/fetch/CONFIG shim -- same
 * technique as tests/gh2154-p1-short-signup.mjs and
 * tests/gh2154-p2-app-activation.mjs. The page itself exposes its testable
 * seams on `window.__partnerInvite` (getInviteToken, agreementLinkFor,
 * loadInvite, onAcceptClick) specifically so this harness can drive the
 * exact functions a real page load runs, without re-implementing them.
 *
 * Run: node tests/gh2154-p5-invite-page.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const PAGE_PATH = path.join(repoRoot, 'partner-invite.html');
const BASE_SHA = '64c1ebb9988c48c94ada44b59acc7b3a4f34ba72';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

// ── (0) FAIL-FIRST evidence: the page did not exist at the base commit ──
{
  try {
    execSync(`git show ${BASE_SHA}:partner-invite.html`, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    failWithReason('(0) FAIL-FIRST: partner-invite.html did not exist at base ' + BASE_SHA, 'git show unexpectedly succeeded -- the page already existed at the base commit');
  } catch (e) {
    ok(true, '(0) FAIL-FIRST: partner-invite.html did not exist at base ' + BASE_SHA + ' (git show failed, as expected)');
  }
}

if (!fs.existsSync(PAGE_PATH)) {
  console.log('');
  console.log('partner-invite.html does not exist in the working tree -- every remaining scenario is a hard FAIL.');
  console.log('TOTAL: ' + pass + ' passed, ' + (fail + 6) + ' failed');
  process.exit(1);
}

const pageSrc = fs.readFileSync(PAGE_PATH, 'utf8');
// gh-914: partner-invite.html loads js/agent-types.js for its agent-type
// display labels (AGENT_TYPE_CHOOSER_LABELS) rather than a local map, same
// as every other partner-*.html signup page -- the vm sandbox below loads
// the REAL file's source too, so this harness exercises the real single
// source of truth, not a hand-retyped copy of its values.
const agentTypesSrc = fs.readFileSync(path.join(repoRoot, 'js', 'agent-types.js'), 'utf8');
ok(/<script src="js\/agent-types\.js"><\/script>/.test(pageSrc), '(1b) partner-invite.html loads js/agent-types.js (gh-914 single source of truth)');

// ── static, no-JS-execution checks ───────────────────────────────────────
ok(/<meta name="robots" content="noindex,nofollow">/.test(pageSrc), '(1) noindex,nofollow meta tag present (token-gated page)');
ok(/js\/nav\.js/.test(pageSrc) && /id="site-footer"/.test(pageSrc), '(2) footer + js/nav.js included (site convention)');
ok(/js\/ga-gate\.js/.test(pageSrc) && /js\/meta-pixel-gate\.js/.test(pageSrc), '(3) ga-gate.js + meta-pixel-gate.js included (partner-page gtag/pixel convention)');
ok(/I agree to Otter Quotes's <a href="partner-agreement\.html" id="agreementLink">Partner Terms<\/a>/.test(pageSrc), '(4) agreement checkbox label reuses P-1\'s verbatim "I agree to Otter Quotes\'s Partner Terms" copy');
ok(/Check your employment agreement and your governing licensing agency to make sure it is lawful for you to accept referral fees\./.test(pageSrc), '(5) reuses P-1\'s verbatim referral-fee disclaimer sentence');
ok(pageSrc.includes('PLACEHOLDER'), '(6) at least one clearly-marked PLACEHOLDER for non-approved new copy');
ok(!/\u0000/.test(pageSrc), '(7) null-byte gate: file contains no null bytes');

// ── REVIEW FAIL 5841303507 must-fix 1 / LEGAL-READ FAIL 5841305700 (D-333) ──
ok(!/Review your details below and accept the Partner Terms to activate your account\./.test(pageSrc),
  "(7b) NEGATIVE CONTROL: the unapproved 'Review your details below...' sentence must not appear anywhere in the page source");
ok(!/Accept &amp; Activate My Account/.test(pageSrc),
  "(7c) NEGATIVE CONTROL: the unapproved 'Accept & Activate My Account' button copy must not appear anywhere in the page source");
ok(/Create My Partner Account/.test(pageSrc),
  '(7d) the accept button reuses P-1\'s byte-identical live "Create My Partner Account" label (partner-re.html:1013 / partner-insurance.html:756)');

// ── REVIEW FAIL 5841303507 must-fix 6 / LEGAL-READ FAIL 5841305700: token-gate ──
// All four states must default to display:none in the RAW markup -- a
// crawler, a slow/disabled-JS load, or a plain view-source must never see
// any of them painted before the script decides which one to reveal.
for (const id of ['inviteLoading', 'inviteInvalid', 'inviteForm', 'inviteSuccess']) {
  const re = new RegExp('id="' + id + '"[^>]*style="display:\\s*none;?"');
  ok(re.test(pageSrc), '(7e) #' + id + ' defaults to display:none in the raw HTML (token-gated: nothing rendered without JS deciding)');
}

// ── extract the real inline script IIFE ──────────────────────────────────
function extractScript(src) {
  const startAnchor = "(function () {\n  'use strict';";
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor (start) not found');
  const endAnchor = '})();\n</script>';
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor (end) not found');
  return src.slice(startIdx, endIdx + '})();'.length);
}

function makeEl(id) {
  return {
    id,
    style: { display: '' },
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    _attrs: {},
    _listeners: {},
    setAttribute(name, value) { this._attrs[name] = value; },
    getAttribute(name) { return this._attrs[name] !== undefined ? this._attrs[name] : null; },
    addEventListener(evt, fn) { this._listeners[evt] = this._listeners[evt] || []; this._listeners[evt].push(fn); },
  };
}

const ELEMENT_IDS = [
  'inviteLoading', 'inviteInvalid', 'inviteForm', 'inviteSuccess',
  'prefillName', 'prefillEmail', 'prefillAgentType', 'agreementLink',
  'agreeToTerms', 'inviteAcceptError', 'acceptBtn', 'inviteInvalidSignupLink',
  'feeDisclaimer',
];

function runPageScript({ search, fetchImpl }) {
  const els = new Map();
  ELEMENT_IDS.forEach((id) => els.set(id, makeEl(id)));
  els.get('inviteForm').setAttribute('data-agent-type', '');

  const documentListeners = {};
  const sandbox = {
    window: {
      location: { search: search || '' },
    },
    document: {
      getElementById: (id) => els.get(id) || null,
      addEventListener(evt, fn) { documentListeners[evt] = documentListeners[evt] || []; documentListeners[evt].push(fn); },
    },
    URLSearchParams,
    CONFIG: { SUPABASE_URL: 'https://yeszghaspzwwstvsrioa.supabase.co', SUPABASE_ANON: 'sb_publishable_test' },
    fetch: fetchImpl,
    console,
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.CONFIG = sandbox.CONFIG;
  sandbox.window.fetch = sandbox.fetch;
  vm.createContext(sandbox);

  // Load the REAL js/agent-types.js first, same as the page's own
  // <script src="js/agent-types.js"> tag, so AGENT_TYPE_CHOOSER_LABELS
  // exists in scope before the extracted script runs.
  vm.runInContext(agentTypesSrc, sandbox, { filename: 'js/agent-types.js' });

  const scriptSrc = extractScript(pageSrc);
  vm.runInContext(scriptSrc, sandbox, { filename: 'partner-invite.html (extracted script)' });

  // Note: the real page's DOMContentLoaded listener (registered here on
  // documentListeners, not fired automatically) calls showLoading() and
  // loadInvite() itself on a real page load. Each scenario below drives
  // window.__partnerInvite's exposed functions directly instead of firing
  // that listener, so a scenario's own loadInvite()/onAcceptClick() call is
  // the only one that runs -- firing both would double-count fetch calls.
  return { sandbox, els, api: sandbox.window.__partnerInvite, documentListeners };
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ── (8) agreementLinkFor(): home_inspector carries ?track=home_inspector + #track-home-inspector, same as gh-2166 ──
{
  try {
    const { api } = runPageScript({ search: '', fetchImpl: async () => { throw new Error('not used'); } });
    ok(api.agreementLinkFor('home_inspector') === 'partner-agreement.html?track=home_inspector#track-home-inspector',
      '(8a) agreementLinkFor("home_inspector") === "partner-agreement.html?track=home_inspector#track-home-inspector" (gh-2166 convention)');
    ok(api.agreementLinkFor('re_agent') === 'partner-agreement.html',
      '(8b) agreementLinkFor("re_agent") === "partner-agreement.html" (no track param for a non-inspector track)');
  } catch (e) {
    failWithReason('(8) agreementLinkFor()', e.message);
  }
}

// ── (9) loadInvite(): calls the EF's GET with the page's ?token= value, prefills the form, and sets the inspector-safe agreement link ──
{
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ ok: true, agent_type: 'home_inspector', first_name: 'Jamie', last_name: 'Rivera', email: 'jamie@example.com' }),
    };
  };
  try {
    const { api, els } = runPageScript({ search: '?token=tok.sig', fetchImpl });
    await api.loadInvite();
    await settle();
    ok(calls.length === 1, '(9a) loadInvite() makes exactly one GET call to partner-invite-accept -- got ' + calls.length);
    if (calls.length === 1) {
      ok(calls[0].url.includes('/functions/v1/partner-invite-accept') && calls[0].url.includes('t=tok.sig'),
        '(9b) prefill call carries the page\'s ?token= value as the EF\'s own ?t= param -- got ' + calls[0].url);
      ok((calls[0].opts.method || 'GET') === 'GET', '(9c) prefill call is a GET');
    }
    ok(els.get('inviteForm').style.display === '', '(9d) the accept form is shown after a successful prefill');
    ok(els.get('inviteLoading').style.display === 'none', '(9e) the loading state is hidden after a successful prefill');
    ok(els.get('prefillName').textContent === 'Jamie Rivera', '(9f) prefill populates the name from the EF response');
    ok(els.get('agreementLink').getAttribute('href') === 'partner-agreement.html?track=home_inspector#track-home-inspector',
      '(9g) a home_inspector prefill wires the agreement link to the track-safe URL, so an inspector never sees fee terms');
  } catch (e) {
    failWithReason('(9) loadInvite() happy path', e.message);
  }
}

// ── (10) onAcceptClick(): the accept POST is sent ONLY after the checkbox is ticked ──
{
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const { api, els } = runPageScript({ search: '?token=tok.sig', fetchImpl });
    els.get('agreeToTerms').checked = false;
    await api.onAcceptClick();
    await settle();
    ok(calls.length === 0, '(10a) NEGATIVE CONTROL: unchecked checkbox -> zero accept POST calls -- got ' + calls.length);
  } catch (e) {
    failWithReason('(10a) NEGATIVE CONTROL: unchecked checkbox', e.message);
  }

  try {
    const { api, els } = runPageScript({ search: '?token=tok.sig', fetchImpl });
    els.get('agreeToTerms').checked = true;
    await api.onAcceptClick();
    await settle();
    ok(calls.length === 1, '(10b) checked checkbox -> exactly one accept POST call -- got ' + calls.length);
    if (calls.length === 1) {
      ok(calls[0].url.includes('/functions/v1/partner-invite-accept'), '(10c) accept call hits partner-invite-accept');
      ok(calls[0].opts.method === 'POST', '(10d) accept call is a POST');
      const body = JSON.parse(calls[0].opts.body);
      ok(body.t === 'tok.sig' && body.agreement_accepted === true,
        '(10e) accept POST body is { t: <token>, agreement_accepted: true } -- got ' + calls[0].opts.body);
    }
    ok(els.get('inviteSuccess').style.display === '', '(10f) the success/next-steps panel is shown after a successful accept');
  } catch (e) {
    failWithReason('(10b-f) checked checkbox -> accept POST + success panel', e.message);
  }
}

// ── (9h/9i) D-333 / REVIEW FAIL 5841303507 must-fix 1: the referral-fee
// disclaimer must be hidden for home_inspector and shown for every other
// track, mirroring HI-0b's own partner-inspectors.html precedent ──
{
  const fetchImplFor = (agentType) => async () => ({
    ok: true,
    json: async () => ({ ok: true, agent_type: agentType, first_name: 'Jamie', last_name: 'Rivera', email: 'jamie@example.com' }),
  });
  try {
    const { api, els } = runPageScript({ search: '?token=tok.sig', fetchImpl: fetchImplFor('home_inspector') });
    await api.loadInvite();
    await settle();
    ok(els.get('feeDisclaimer').style.display === 'none',
      '(9h) NEGATIVE CONTROL: home_inspector prefill hides the referral-fee disclaimer (D-333) -- FAILS on 051ab432, where it is unconditionally shown');
  } catch (e) {
    failWithReason('(9h) home_inspector hides fee disclaimer', e.message);
  }
  try {
    const { api, els } = runPageScript({ search: '?token=tok.sig', fetchImpl: fetchImplFor('re_agent') });
    await api.loadInvite();
    await settle();
    ok(els.get('feeDisclaimer').style.display === '',
      '(9i) a non-inspector track (re_agent) still shows the referral-fee disclaimer');
  } catch (e) {
    failWithReason('(9i) re_agent shows fee disclaimer', e.message);
  }
}

// ── (11) an invalid/expired token (EF GET returns ok:false or non-200) shows the fallback message + link to the normal signup page, never a 500 ──
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: false, error: 'not_found' }) });
  try {
    const { api, els } = runPageScript({ search: '?token=bogus', fetchImpl });
    await api.loadInvite();
    await settle();
    ok(els.get('inviteInvalid').style.display === '', '(11a) invalid-token response shows the invalid/expired panel');
    ok(els.get('inviteForm').style.display === 'none', '(11b) invalid-token response never shows the accept form');
    // The fallback link's href is static markup (never rewritten by JS), so
    // this is checked directly against the source rather than through the
    // DOM shim, which does not parse initial HTML attribute values.
    ok(/id="inviteInvalidSignupLink"[^>]*>/.test(pageSrc) &&
       /<a href="\/partners\.html"[^>]*id="inviteInvalidSignupLink"/.test(pageSrc),
      '(11c) invalid-token panel links to the normal signup hub page (partners.html)');
  } catch (e) {
    failWithReason('(11) invalid/expired token fallback', e.message);
  }
}

// ── (12) a network/fetch failure also falls back to the invalid panel -- never an uncaught exception, never a 500 page ──
{
  const fetchImpl = async () => { throw new TypeError('network error'); };
  try {
    const { api, els } = runPageScript({ search: '?token=tok.sig', fetchImpl });
    await api.loadInvite();
    await settle();
    ok(els.get('inviteInvalid').style.display === '', '(12a) a thrown fetch error still resolves to the invalid/expired panel, not an unhandled exception');
  } catch (e) {
    failWithReason('(12) fetch throws -> invalid panel, not a crash', e.message);
  }
}

// ── (13) no ?token= at all -> invalid panel, zero network calls (never guesses/forges a token) ──
{
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    const { api, els } = runPageScript({ search: '', fetchImpl });
    await api.loadInvite();
    await settle();
    ok(calls.length === 0, '(13a) no ?token= -> zero network calls -- got ' + calls.length);
    ok(els.get('inviteInvalid').style.display === '', '(13b) no ?token= -> invalid panel shown');
    ok(els.get('inviteLoading').style.display === 'none',
      '(13c) REVIEW FAIL 5841303507 must-fix 6: no ?token= -> the loading state (which carried placeholder copy pre-fix) is never shown at all');
  } catch (e) {
    failWithReason('(13) missing ?token=', e.message);
  }
}

console.log('');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
