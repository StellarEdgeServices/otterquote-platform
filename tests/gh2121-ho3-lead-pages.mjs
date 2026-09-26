/**
 * gh-2121 HO-3 (PR #2226 REVIEW D4, D8, L1, L3): static + vm checks on the two
 * no-account pages. Run: node tests/gh2121-ho3-lead-pages.mjs
 *
 *  D4  the first <script> in <head> captures #lead_token= into memory and
 *      strips the fragment with history.replaceState BEFORE any third-party
 *      script tag; both pages send no Referer; gtag config sets page_location
 *      without the fragment; no page reads a token from the query string.
 *  D8  js/cookie-storage.js loads before js/config.js (check-script-load-order).
 *  L1  measure-lead.html has a required, unticked clickwrap whose label text
 *      equals MEASURE_TERMS_CONSENT_TEXT in create-lead-payment-intent/handler.ts.
 *  L3  no dollar amount is typed into measure-lead.html's rendered text or its
 *      script: the price comes only from the server.
 *
 * NEGATIVE CONTROL: the same checks run against the first-draft pages at
 * fb57e7f (git show) when NEG=1 is set, and must FAIL there.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';

let pass = 0, fail = 0;
function ok(c, label) { if (c) { pass++; console.log('PASS: ' + label); } else { fail++; console.log('FAIL: ' + label); } }

const NEG = process.env.NEG === '1';
const read = (f) => NEG ? execSync(`git show fb57e7f:${f}`).toString() : fs.readFileSync(f, 'utf8');
const handlerSrc = fs.readFileSync('supabase/functions/create-lead-payment-intent/handler.ts', 'utf8');
const CONSENT = (/MEASURE_TERMS_CONSENT_TEXT = "([^"]+)"/.exec(handlerSrc) || [])[1];

function runHeadScript(html, url) {
  const first = /<head>\s*(?:<!--[\s\S]*?-->\s*)?<script>([\s\S]*?)<\/script>/.exec(html);
  if (!first) return null;
  const u = new URL(url);
  const calls = [];
  const win = {
    location: { hash: u.hash, pathname: u.pathname, search: u.search, origin: u.origin },
    history: { replaceState: (_s, _t, to) => { calls.push(to); win.location.hash = ''; } },
  };
  try { vm.runInNewContext(first[1], { window: win, decodeURIComponent }); } catch { return null; }
  return { token: win.__HO3_LEAD_TOKEN, calls, hash: win.location.hash };
}

for (const page of ['measure-lead.html', 'loss-sheet-lead.html']) {
  const html = read(page);
  const r = runHeadScript(html, 'https://app.otterquote.com/' + page.replace('.html', '') + '?utm_source=fb&v=f#lead_token=Tok_en-123');
  ok(r && r.token === 'Tok_en-123', `${page}: D4 the head script captures the fragment token`);
  ok(r && r.calls.length === 1 && r.calls[0] === '/' + page.replace('.html', '') + '?utm_source=fb&v=f' && r.hash === '', `${page}: D4 the fragment is stripped with replaceState, keeping the query`);
  const firstScriptAt = html.indexOf('<script');
  for (const third of ['sentry-cdn.com', 'ga-gate.js', 'js.stripe.com', 'fonts.googleapis.com']) {
    const at = html.indexOf(third);
    ok(at === -1 || at > html.indexOf('</script>', firstScriptAt), `${page}: D4 the token is stripped before ${third} loads`);
  }
  ok(/<meta name="referrer" content="no-referrer">/.test(html), `${page}: D4 no-referrer policy`);
  ok(/gtag\('config', 'G-D1Y1TLGEFY', \{ page_location: window\.location\.origin \+ window\.location\.pathname \+ window\.location\.search \}\)/.test(html), `${page}: D4 GA4 page_location set without the fragment`);
  ok(!/URLSearchParams\(window\.location\.search\)[\s\S]{0,80}lead_token/.test(html), `${page}: D4 the token is never read from the query string`);
  const cs = html.indexOf('src="js/cookie-storage.js"'), cf = html.indexOf('src="js/config.js"');
  ok(cs !== -1 && cf !== -1 && cs < cf, `${page}: D8 cookie-storage.js loads before config.js`);
}

{
  const html = read('measure-lead.html');
  const label = /<span id="termsConsentLabel">([\s\S]*?)<\/span>/.exec(html);
  const labelText = label ? label[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  ok(!!CONSENT && labelText === CONSENT, `measure-lead.html: L1 the checkbox label equals the server's consent text ("${labelText}")`);
  ok(/<input type="checkbox" id="termsConsent"(?![^>]*checked)[^>]*>/.test(html), 'measure-lead.html: L1 the consent box is unticked by default');
  ok(/id="purchaseBtn"[^>]*disabled/.test(html), 'measure-lead.html: L1 Pay starts disabled until the box is ticked and the price has loaded');
  const bodyNoComments = html.slice(html.indexOf('<body')).replace(/<!--[\s\S]*?-->/g, '');
  ok(!/\$\s?\d/.test(bodyNoComments), 'measure-lead.html: L3 no dollar amount is typed into the page body or its script');
  ok(!/value:\s*15\b/.test(html), 'measure-lead.html: L3 GA4 purchase value is not hard-coded');
  ok(!/rebated/i.test(bodyNoComments), 'measure-lead.html: L2 no rebate promise in the lead flow');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
