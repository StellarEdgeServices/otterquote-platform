/**
 * gh-3239 (#3238) -- Partner Agreement v4-2026-10 publish and acceptance flows.
 *
 * Asserts:
 *   (v) version strings: partner-agreement.html serves v4-2026-10; partner-agreement-v3.html is the v3-2026-09 page byte-for-byte
 *       (sha256 pinned to the page main served before this change), noindex; every place that writes or compares the current
 *       version agrees on one string (draft migration, partner-invite-accept EF, dashboard, refer-a-friend).
 *   (s) the legal text on partner-agreement.html is exactly docs/legal/partner-agreement-v4-2026-10.md: the renderer's --check
 *       passes, and an independent text comparison (markdown stripped vs page text) matches clause by clause.
 *   (h) home-inspector track: the v4 page keeps the fail-closed :target hide and marks the same four elements as v3.
 *   (n) dashboard notice wiring, run in a vm: v3 partner sees the notice with the exact #3236 prompt and an "I accept" button that
 *       calls accept_partner_agreement_v4() with no arguments; v4 partner and home inspector see nothing; window.partnerAcceptedV4.
 *   (r) refer-a-friend, run in a vm: checkbox + link to the agreement; no RPC unless the box is ticked; ticked -> the customer row is
 *       created first, then accept_partner_agreement_v4(); the link and share tools are hidden until acceptance.
 *   (c) no "commission" in partner-facing copy (agreement page, refer-a-friend, partner dashboard); no "$200 referral bonus".
 *   (m) draft migration shape: SECURITY DEFINER + pinned search_path + auth.uid() only for the accept RPC; column-lock trigger;
 *       rollback restores the audited register_partner md5; STATUS headers; proof runner present.
 * Every detector has a NEGATIVE CONTROL that feeds it a known-bad input and requires it to fire.
 *
 * Run: node tests/gh3239-partner-agreement-v4.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('PASS: ' + label); } else { fail++; console.log('FAIL: ' + label); } }

const V4 = 'v4-2026-10';
const V3 = 'v3-2026-09';
const V3_PAGE_SHA256 = '96949433650e2f9bd1154427bf65d288da8916cf97f78f0d02454dca55d1e101'; // partner-agreement.html on main 8be717b2 (v3-2026-09)
const PROMPT = 'Accept the updated agreement to earn the $5 measurement referral fee';

const agreement = read('partner-agreement.html');
const archive = read('partner-agreement-v3.html');
const legalMd = read('docs/legal/partner-agreement-v4-2026-10.md');
const dashboard = read('partner-dashboard.html');
const raf = read('refer-a-friend.html');
const fwd = read('supabase/migrations_drafts/gh3239_partner_agreement_v4.sql');
const rb = read('supabase/migrations_drafts/gh3239_partner_agreement_v4_rollback.sql');
const ef = read('supabase/functions/partner-invite-accept/index.ts');

// ---------------------------------------------------------------- (v) versions
ok(/<strong>Version:<\/strong> <span id="agreementVersion">v4-2026-10<\/span>/.test(agreement), '(v1) partner-agreement.html shows Version v4-2026-10');
ok(!/Version:<\/strong>\s*v3-2026-09/.test(agreement), '(v2) partner-agreement.html no longer shows Version v3-2026-09');
ok(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'partner-agreement-v3.html'))).digest('hex') === V3_PAGE_SHA256,
  '(v3) partner-agreement-v3.html is the v3-2026-09 page byte-for-byte (so every v3 acceptance resolves to the text accepted)');
ok(/<meta name="robots" content="noindex/.test(archive), '(v4) the v3 archive is noindex');
ok(agreement.includes('href="partner-agreement-v3.html"'), '(v5) the v4 page links the archived v3');
ok(/v_agreement_version CONSTANT text := CASE WHEN p_agent_type = 'home_inspector' THEN 'v3-2026-09' ELSE 'v4-2026-10' END;/.test(fwd),
  '(v6) register_partner rewrite stamps v4-2026-10 (home_inspector keeps the inspector agreement v3-2026-09)');
ok(/SELECT 'v4-2026-10'::text/.test(fwd) && /v_version\s+CONSTANT text := 'v4-2026-10';/.test(fwd), '(v7) current-version function and accept RPC name v4-2026-10');
ok(/const AGREEMENT_VERSION = "v4-2026-10";/.test(ef) && /const INSPECTOR_AGREEMENT_VERSION = "v3-2026-09";/.test(ef)
  && /partner_agreement_version: acceptedVersion/.test(ef) && /\[acceptedVersion\]:/.test(ef), '(v8) partner-invite-accept stamps the per-type version');
ok(/var PARTNER_AGREEMENT_CURRENT_VERSION = 'v4-2026-10';/.test(dashboard), '(v9) dashboard compares against v4-2026-10');
ok(/const PARTNER_AGREEMENT_CURRENT_VERSION = 'v4-2026-10';/.test(raf), '(v10) refer-a-friend compares against v4-2026-10');
const versionsSeen = new Set([...`${fwd}\n${ef}\n${dashboard}\n${raf}`.matchAll(/(?<![-\w])v(\d+)-2026-(\d\d)/g)].map(m => m[0]));
ok([...versionsSeen].every(v => v === V4 || v === V3), '(v11) no other agreement version string appears in the wired files: ' + [...versionsSeen].join(','));

// ---------------------------------------------------------------- (s) legal text = single source
let checkOut = '';
try { checkOut = execFileSync('python3', [path.join(root, 'scripts/render-partner-agreement.py'), '--check'], { encoding: 'utf8' }); } catch (e) { checkOut = 'ERR ' + (e.stdout || '') + (e.stderr || ''); }
ok(/agreement block is current/.test(checkOut), '(s1) scripts/render-partner-agreement.py --check: page matches docs/legal source');

function mdToText(md) {
  return md.replace(/^<!--[\s\S]*?-->\s*/, '').split('\n')
    .map(l => l.replace(/^#{1,3} /, '').replace(/^> ?/, '').replace(/^- /, ''))
    .map(l => l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
    .filter(l => l.trim()).map(l => l.trim());
}
function htmlBlockText(h) {
  const a = h.indexOf('<!-- BEGIN gh3239 AGREEMENT-V4'), b = h.indexOf('<!-- END gh3239 AGREEMENT-V4 -->');
  return h.slice(a, b).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .split('\n').map(l => l.trim()).filter(Boolean);
}
const mdLines = mdToText(legalMd).slice(2);           // title + subtitle live in the page hero
const pageLines = htmlBlockText(agreement);
const firstDiff = mdLines.findIndex((l, i) => l !== pageLines[i]);
ok(mdLines.length === pageLines.length && firstDiff === -1,
  `(s2) page text equals the source clause by clause (${mdLines.length} lines)` + (firstDiff >= 0 ? ` -- first diff at ${firstDiff}: ${JSON.stringify(mdLines[firstDiff])} vs ${JSON.stringify(pageLines[firstDiff])}` : ''));
const tampered = agreement.replace('earns no Measurement Referral Fee', 'earns no Measurement Fee');
ok(htmlBlockText(tampered).join('\n') !== mdLines.join('\n'), '(s3) NEGATIVE CONTROL: a one-word edit to the page is caught by (s2)');
ok(/Effective Date:<\/strong> <span id="agreementEffectiveDate">October 30, 2026<\/span>/.test(agreement) && !/\[publication date\]/.test(agreement.replace(/<!--[\s\S]*?-->/g, "") + legalMd.replace(/^<!--[\s\S]*?-->/, "")),
  '(s4) Effective Date is October 30, 2026 (Dustin "PUBLISH V4", 2026-10-30) and no placeholder remains');
ok(/<a href="#creator-guide-pending" data-placeholder="creator-guide-v2-2026-10">Otter Quotes Creator Guide<\/a>, version v2-2026-10/.test(agreement),
  '(s5) Section 8.2 Creator Guide link is the marked placeholder');

// ---------------------------------------------------------------- (h) inspector track
const legal = agreement.slice(agreement.indexOf('<div class="legal-content">'));
ok(/^<div class="legal-content">\s*(<!--[\s\S]*?-->\s*)*<span id="track-home-inspector"><\/span>/.test(legal), '(h1) #track-home-inspector is still the first child of .legal-content');
ok(agreement.includes('#track-home-inspector:target ~ * .inspector-hide'), '(h2) the fail-closed :target CSS rule is present');
const hidden = [...agreement.matchAll(/<(div|section|span)[^>]*class="[^"]*inspector-hide[^"]*"[^>]*>/g)].map(m => m[0]);
ok(hidden.length === 4 && hidden[0].includes('feeStructureBlock') && hidden[2].startsWith('<section'), '(h3) four elements hidden for inspectors: fee block, 4.1, Section 7, 14(a) span');
const feeBlock = agreement.slice(agreement.indexOf('id="feeStructureBlock"'), agreement.indexOf('<h3>4.1 '));
ok(/Measurement Referral Fee: \$5/.test(feeBlock) && /Job Referral Fee: \$200/.test(feeBlock) && /Recruit Bonus: \$50/.test(feeBlock), '(h4) every fee clause sits inside the hidden fee block');
ok(!/inspector-hide/.test(agreement.slice(agreement.indexOf('<h3>4.3 Home Inspector Partners</h3>'), agreement.indexOf('<h2>5. '))), '(h5) Section 4.3 (no fee for inspectors) stays visible');

// ---------------------------------------------------------------- (n) dashboard notice (vm)
function extractFn(src, name) {
  const start = src.indexOf((src.includes(`async function ${name}(`) ? 'async function ' : 'function ') + name + '(');
  if (start < 0) throw new Error('missing ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}
function fakeDom() {
  const els = {};
  const mk = (id) => (els[id] = els[id] || { id, style: {}, innerHTML: '', textContent: '', disabled: false, checked: false, listeners: {},
    addEventListener(ev, fn) { this.listeners[ev] = fn; }, classList: { add() {} } });
  return { els, document: { getElementById: (id) => {
    if (id === 'agreementV4Notice') return mk(id);
    if (els.agreementV4Notice && els.agreementV4Notice.innerHTML.includes(`id="${id}"`)) return mk(id);
    return els[id] || null;
  } } };
}
const dashSrc = ['PARTNER_AGREEMENT_CURRENT_VERSION', 'AGREEMENT_V4_FEE_PROMPT'].map(v => (dashboard.match(new RegExp(`var ${v} = [^\\n]+`)) || [''])[0]).join('\n')
  + '\n' + extractFn(dashboard, 'partnerHasAcceptedV4') + '\n' + extractFn(dashboard, 'refreshAgreementV4Notice') + '\n' + extractFn(dashboard, 'acceptAgreementV4');
function runDashboard(partner) {
  const dom = fakeDom();
  const calls = [];
  const ctx = { window: {}, document: dom.document, CONFIG: { DEMO_MODE: false }, currentPartner: partner, console,
    CustomEvent: function () {}, sb: { rpc: async (name, args) => { calls.push([name, args]); return { data: { agreement_version: V4, accepted_at: '2026-11-01T00:00:00Z', already_accepted: false }, error: null }; } } };
  vm.createContext(ctx);
  vm.runInContext(dashSrc.replace(/^var /gm, 'var ') + '\nrefreshAgreementV4Notice();', ctx);
  return { ctx, dom, calls };
}
const v3row = { agent_type: 're_agent', partner_agreement_version: V3, partner_agreement_attestation: { [V3]: {} } };
let r1 = runDashboard(v3row);
const box1 = r1.dom.els.agreementV4Notice;
ok(box1.style.display === '' && /I accept<\/button>/.test(box1.innerHTML) && /href="\/partner-agreement\.html"/.test(box1.innerHTML), '(n1) v3 partner: notice shown with a link to v4 and an "I accept" button');
ok(r1.dom.els.agreementV4FeePrompt && r1.dom.els.agreementV4FeePrompt.textContent === PROMPT + '.', '(n2) v3 partner sees the exact #3236 prompt: "' + PROMPT + '"');
ok(r1.ctx.window.partnerAcceptedV4 === false, '(n3) window.partnerAcceptedV4 is false for a v3 partner');
await r1.dom.els.agreementV4Accept.listeners.click();
ok(r1.calls.length === 1 && r1.calls[0][0] === 'accept_partner_agreement_v4' && r1.calls[0][1] === undefined, '(n4) "I accept" calls accept_partner_agreement_v4() with no arguments (identity from auth.uid() only)');
ok(r1.ctx.window.partnerAcceptedV4 === true && box1.style.display === 'none', '(n5) after acceptance: notice hidden, window.partnerAcceptedV4 true');
const r2 = runDashboard({ agent_type: 're_agent', partner_agreement_version: V4, partner_agreement_attestation: { [V4]: {} } });
ok(r2.dom.els.agreementV4Notice.style.display === 'none' && r2.ctx.window.partnerAcceptedV4 === true, '(n6) v4 partner: no notice, partnerAcceptedV4 true');
const r3 = runDashboard({ agent_type: 'home_inspector', partner_agreement_version: V3, partner_agreement_attestation: { [V3]: {} } });
ok(r3.dom.els.agreementV4Notice.style.display === 'none' && !/\$5/.test(r3.dom.els.agreementV4Notice.innerHTML), '(n7) home inspector: no notice and no fee wording');
const r4 = runDashboard({ agent_type: 'other', partner_agreement_version: null, partner_agreement_attestation: {} });
ok(r4.dom.els.agreementV4Notice.style.display === '', '(n8) partner with no recorded acceptance (pre-gh-1059 / v2) also sees the notice');
const forged = runDashboard({ agent_type: 're_agent', partner_agreement_version: V3, partner_agreement_attestation: { 'v4-2026-1': {} } });
ok(forged.ctx.window.partnerAcceptedV4 === false, '(n9) NEGATIVE CONTROL: a near-miss key does not count as v4');
const staticNotice = dashboard.match(/<div class="referral-link-section agreement-v4-notice" id="agreementV4Notice"[^>]*><\/div>/);
ok(!!staticNotice && /display:none/.test(staticNotice[0]), '(n10) static notice placeholder is empty and hidden (no fee wording without JS, gh-2155 HI-0)');
const initOrder = dashboard.indexOf('refreshSetPasswordCard(currentUser.id);\n\n                    // gh-3239') ;
ok(initOrder > 0 && dashboard.indexOf('refreshAgreementV4Notice();', initOrder) < dashboard.indexOf('updateUI();', initOrder), '(n11) notice refreshed right after the partner row resolves, before updateUI()');

// ---------------------------------------------------------------- (r) refer-a-friend (vm)
ok(/<input type="checkbox" id="agreement-v4-checkbox" required>/.test(raf) && /I agree to the Otter Quotes <a href="\/partner-agreement\.html"[^>]*>Partner Terms<\/a> \(Partner Agreement v4-2026-10\)\./.test(raf), '(r1) checkbox plus link, labelled "Partner Terms" as Agreement Section 1 names it');
ok(/id="agreement-v4-accept" type="button" disabled>/.test(raf), '(r2) the accept button starts disabled');
ok(/\.requires-agreement \{ display: none; \}/.test(raf) && /<!-- Your Referral Link -->\s*<section class="refer-section requires-agreement">/.test(raf)
  && /<!-- Share Options -->\s*<section class="refer-section requires-agreement">/.test(raf), '(r3) link and share tools hidden until acceptance');
const rafSrc = 'const PARTNER_AGREEMENT_CURRENT_VERSION = "v4-2026-10";\n' + extractFn(raf, 'acceptAgreementV4');
async function runRaf(checked) {
  const calls = [];
  const els = { 'agreement-v4-checkbox': { checked }, 'agreement-v4-accept': { disabled: !checked }, 'agreement-v4-status': { style: {} }, 'agreement-accept-section': { style: {} } };
  const ctx = { document: { getElementById: (id) => els[id], body: { classList: { add: (c) => calls.push(['body', c]) } } }, console,
    userReferralCode: null,
    fetchOrCreateReferralCode: async () => { calls.push(['get_or_create_customer_referral_code']); ctx.userReferralCode = 'ABC'; },
    startReferring: async () => calls.push(['startReferring']),
    sb: { rpc: async (n, a) => { calls.push([n, a]); return { data: { agreement_version: V4, accepted_at: '2026-11-01T00:00:00Z' }, error: null }; } } };
  vm.createContext(ctx);
  vm.runInContext(rafSrc.replace('if (!userReferralCode) await', 'if (!globalThis.userReferralCode) await').replace("if (!userReferralCode) throw", "if (!globalThis.userReferralCode) throw") + '\nglobalThis.__p = acceptAgreementV4();', ctx);
  await ctx.__p;
  return calls;
}
const unticked = await runRaf(false);
ok(unticked.length === 0, '(r4) box not ticked: no RPC, nothing recorded');
const ticked = await runRaf(true);
ok(ticked.map(c => c[0]).join(',') === 'get_or_create_customer_referral_code,accept_partner_agreement_v4,body,startReferring',
  '(r5) box ticked: customer row created, then acceptance recorded, then the link is shown: ' + ticked.map(c => c[0]).join(','));

// ---------------------------------------------------------------- (c) copy
function partnerCopy(h) {
  const noComments = h.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
  const visible = noComments.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
  const attrs = [...noComments.replace(/<script[\s\S]*?<\/script>/g, ' ').matchAll(/\s(?:title|alt|aria-label|placeholder|content)="([^"]*)"/g)].map(m => m[1]);
  const scripts = [...noComments.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n').replace(/^\s*\/\/.*$/gm, '');
  // string literals that read as copy: contain a space and a letter (identifiers like commission_paid have no space)
  const strings = [...scripts.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)].map(m => m[1] ?? m[2] ?? m[3]).filter(s => / /.test(s) && /[a-z]/i.test(s));
  return [visible, ...attrs, ...strings].join('\n');
}
const commissionHits = (h) => (partnerCopy(h).match(/[^\n]{0,40}\bcommissions?\b[^\n]{0,40}/gi) || []);
for (const [name, src] of [['partner-agreement.html', agreement], ['refer-a-friend.html', raf], ['partner-dashboard.html', dashboard]]) {
  const hits = commissionHits(src);
  ok(hits.length === 0, `(c1) no "commission" in ${name} partner-facing copy` + (hits.length ? ': ' + JSON.stringify(hits) : ''));
}
ok(commissionHits('<p>You earn a $200 commission.</p>').length === 1 && commissionHits('<button title="Your commission is under review">x</button>').length === 1
  && commissionHits("<script>el.textContent = 'Commission payments are subject to approval';</script>").length === 1
  && commissionHits("<script>const s = { commission_paid: 1 };</script>").length === 0, '(c2) NEGATIVE CONTROL: the detector fires on text, attributes and JS copy, not on identifiers');
let mainRaf = null;
try { mainRaf = execFileSync('git', ['show', '8be717b2:refer-a-friend.html'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* shallow clone */ }
if (mainRaf) ok(commissionHits(mainRaf).length >= 4, '(c3) NEGATIVE CONTROL: the detector finds the pre-change refer-a-friend.html wording (' + commissionHits(mainRaf).length + ' hits)');
else console.log('SKIP: (c3) base commit not available');
ok(!/referral bonus/i.test(partnerCopy(raf)), '(c4) refer-a-friend.html: no "$200 referral bonus"');
ok(/you earn a \$200 referral fee/.test(raf) && /Referral fee payments are subject to Otter Quotes' approval process/.test(raf), '(c5) refer-a-friend.html says "referral fee" (D-301)');

ok(/We'll send payment via Venmo or PayPal, whichever you prefer\./.test(raf) && !/bank transfer|\bcheck, whichever/i.test(raf), '(c6) refer-a-friend FAQ names Venmo or PayPal (Section 5.2, D-401), not bank transfer or check');

// ---------------------------------------------------------------- (i)/(o) cross-system effects (#3242 REVIEW 6526029821)
const invite = read('partner-invite.html');
ok(/if \(agentType === 'home_inspector'\) \{\s*return 'partner-agreement-inspector\.html';/.test(invite),
  '(i1) partner-invite.html: an invited inspector is shown the inspector agreement (v3-2026-09), the version partner-invite-accept records');
const onbIndex = read('supabase/functions/send-partner-onboarding/index.ts');
const onbStage = read('supabase/functions/send-partner-onboarding/onboarding-stage.ts');
ok(/\.select\("[^"]*partner_agreement_attestation[^"]*"\)/.test(onbIndex), '(o1) send-partner-onboarding reads partner_agreement_attestation');
ok(/const effectiveStartMs = onboardingStartMs\(partner\);/.test(onbStage) && /e\.method === "click_to_accept"/.test(onbStage),
  '(o2) the onboarding clock comes from onboardingStartMs(), which never starts at a click-to-accept (Deno run-sweep tests cover behaviour)');

// ---------------------------------------------------------------- (m) migration shape
const acceptFn = fwd.slice(fwd.indexOf('CREATE OR REPLACE FUNCTION public.accept_partner_agreement_v4()'), fwd.indexOf('COMMENT ON FUNCTION public.accept_partner_agreement_v4()'));
ok(/accept_partner_agreement_v4\(\)\s*\n RETURNS jsonb/.test(acceptFn) && /SECURITY DEFINER/.test(acceptFn) && /SET search_path TO 'public', 'pg_temp'/.test(acceptFn), '(m1) accept RPC: no arguments, SECURITY DEFINER, search_path pinned');
ok(/v_uid\s+uuid := auth\.uid\(\);/.test(acceptFn) && /WHERE user_id = v_uid/.test(acceptFn) && !/p_[a-z_]+/.test(acceptFn), '(m2) accept RPC identifies the caller by auth.uid() only');
ok(/REVOKE ALL ON FUNCTION public\.accept_partner_agreement_v4\(\) FROM PUBLIC, anon;/.test(fwd) && /GRANT EXECUTE ON FUNCTION public\.accept_partner_agreement_v4\(\) TO authenticated;/.test(fwd), '(m3) accept RPC: anon revoked, authenticated granted');
ok(/CREATE TRIGGER referral_agents_guard_agreement_columns\s+BEFORE UPDATE ON public\.referral_agents/.test(fwd), '(m4) column-lock trigger on referral_agents');
ok(/042da30fdc75423c32383035b27f2fa4/.test(fwd) && /f4affeb5b17e2b4d242ce452686ada4d/.test(fwd) && /042da30fdc75423c32383035b27f2fa4/.test(rb), '(m5) forward and rollback pin the audited and rewritten register_partner md5');
for (const f of ['gh3239_partner_agreement_v4.sql', 'gh3239_partner_agreement_v4_rollback.sql', 'gh3239_partner_agreement_v4_pre-flight.md'])
  ok(/STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(read('supabase/migrations_drafts/' + f)), `(m6) ${f} carries the STATUS header`);
ok(/REVOKE EXECUTE ON FUNCTION public\.record_partner_agreement_reacceptance\(uuid, text\) FROM authenticated;/.test(fwd)
  && /GRANT EXECUTE ON FUNCTION public\.record_partner_agreement_reacceptance\(uuid, text\) TO authenticated;/.test(rb), '(m8) re-acceptance RPC revoked from authenticated; rollback grants it back');
ok(fs.existsSync(path.join(root, 'supabase/tests/gh3239_partner_agreement_v4_proof_run.sh')) && fs.existsSync(path.join(root, 'supabase/tests/gh3239_partner_agreement_v4_proof.sql')), '(m7) throwaway-Postgres proof and runner are in the repo');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
