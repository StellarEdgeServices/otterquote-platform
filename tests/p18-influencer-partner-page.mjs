/**
 * P18 -- influencer partner signup page (same plan, same agreement as every
 * other partner). Issue #3220.
 *
 * Founder direction (2026-10-30): "a realtor should functionally be the same
 * plan as an influencer. We might use a little different words and phrasing.
 * But I'd like everything else to function almost identically."
 *
 * Agent-type choice: the no-schema fallback. referral_agents_agent_type_check
 * (read live 2026-10-30) allows re_agent, insurance_agent, home_inspector,
 * customer, adjuster, other -- not 'influencer' -- and register_partner
 * hard-codes the same list. The page therefore registers agent_type 'other'
 * with funnel_id 'influencer', so it ships without a Tier 3B migration.
 *
 * Asserts:
 *   (a) partner-influencers.html feeds the SAME register_partner RPC, links the
 *       SAME partner-agreement.html, gates on the same agreement checkbox, and
 *       writes agent_type 'other' (default of the confirm step) with
 *       p_funnel_id 'influencer'.
 *   (b) copy rules: tagline, $200 / $10,000 referral fee, paid-disclosure line,
 *       and none of: vetted/certified/endorsed, "commission" in visible text,
 *       "free roof", deductible, insurance-payout talk, the $5 measurement fee.
 *   (c) partners.html has an influencer tile pointing at the new page.
 *   (d) sitemap.xml lists the page.
 *   (e) ref.html routing, run for real in a vm: 'other' -> '/', and the
 *       NEGATIVE CONTROL 're_agent' still -> '/ref-re.html'.
 *   (f) partner-agreement.html and privacy.html are untouched by this change
 *       (byte-compared to origin/main when a git checkout is available).
 *
 * Run: node tests/p18-influencer-partner-page.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

const page = read('partner-influencers.html');
const re = read('partner-re.html');

// visible text = markup with scripts, styles and comments removed
const visible = page
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// (a) same registration, same agreement
ok((page.match(/\.rpc\('register_partner'/g) || []).length === 1, "(a1) calls register_partner exactly once");
ok(/<a href="partner-agreement\.html">Partner Terms<\/a>/.test(page), '(a2) links the same partner-agreement.html');
ok(/id="terms"[^>]*required/.test(page) && /termsChecked/.test(page), '(a3) same agreement checkbox gate');
ok(/confirmAgentType\('other'\)/.test(page) && !/confirmAgentType\('re_agent'\)/.test(page), "(a4) confirm step defaults to agent_type 'other'");
ok(/p_funnel_id:\s+\(agentType === 'other'\) \? 'influencer' : \(utmContext\.funnelId \|\| null\)/.test(page), "(a5) p_funnel_id is 'influencer' only when the confirmed type is 'other', else the normal funnel");
ok(!/p_funnel_id:\s+'influencer'/.test(page), '(a5b) funnel is not hard-coded to influencer');
ok(!/'influencer'[^;\n]*p_agent_type|p_agent_type:\s+'influencer'/.test(page), "(a6) never sends agent_type 'influencer' (not in the live CHECK constraint)");
ok(/source:\s*'influencer'/.test(page) && !/source:\s*'re_agent'/.test(page), '(a7) leads row is labelled influencer, not re_agent');
ok(!/\/ref-re\.html/.test(page), '(a8) no link to the realtor landing page');
ok(/\.rpc\('register_partner'/.test(re), '(a9) control: partner-re.html still uses register_partner');

// (b) copy rules
ok(/Contractors Compete\. Homeowners Win\./.test(visible), '(b1) tagline present');
ok(/\$200/.test(visible) && /\$10,000 or more/.test(visible) && /referral fee/i.test(visible), '(b2) $200 referral fee on $10,000+ jobs stated');
ok(/say that you're paid for referrals/.test(visible), '(b3) paid-disclosure line present');
ok(!/vetted|certified|endorsed/i.test(visible), '(b4) no vetted/certified/endorsed');
ok(!/commission/i.test(visible), '(b5) no "commission" in visible text');
ok(!/free roof|deductible|insurance|claim/i.test(visible), '(b6) no free-roof, deductible or insurance-payout talk');
ok(!/\$5(?![\d,])/.test(visible) && !/measurement fee/i.test(visible), '(b7) no mention of the planned $5 measurement fee');
ok(!/\$15|\$50|recruit bonus/i.test(visible), '(b8) only the live $200 fee is stated (no $15, $50 or recruit bonus)');
ok(/Check your employment agreement and your governing licensing agency/.test(visible), '(b9) D-266 disclaimer kept verbatim');
ok(!/unbiased|independent/i.test(visible), '(b10) no unbiased/independent');

// (c) partners.html gate tile
const partners = read('partners.html');
ok(/influencer:\s+'partner-influencers\.html'/.test(partners), '(c1) DESTINATIONS maps the influencer tile to the new page');
ok(/\['influencer',/.test(partners), '(c2) GATE_OPTIONS has an influencer tile');
ok(/\['re_agent',/.test(partners) && /partner-re\.html/.test(partners), '(c3) control: realtor tile still present');

// (d) sitemap
ok(/<loc>https:\/\/otterquote\.com\/partner-influencers\.html<\/loc>/.test(read('sitemap.xml')), '(d) sitemap lists partner-influencers.html');

// (e) ref.html routing, executed for real
function route(agentType) {
  const html = read('ref.html');
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2]);
  const code = scripts[scripts.length - 1];
  let dest = null;
  const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  const query = {
    select() { return query; }, eq() { return query; },
    single: () => Promise.resolve({ data: { id: 'a1', agent_type: agentType, first_name: 'T', last_name: 'P', company: '', photo_url: '', status: 'active' }, error: null }),
  };
  const sb = { rpc(name) { return name === 'get_referral_agents_public' ? query : Promise.resolve({ data: 'ref-1', error: null }); } };
  const listeners = [];
  const win = {
    location: { search: '?code=ABC123', set href(v) { dest = v; }, get href() { return ''; } },
    sessionStorage: store(), localStorage: store(),
  };
  const ctx = vm.createContext({
    window: win, sb, sessionStorage: win.sessionStorage, localStorage: win.localStorage,
    URLSearchParams, encodeURIComponent, console: { error() {}, warn() {}, log() {} },
    document: { addEventListener(t, fn) { listeners.push(fn); }, getElementById: () => ({ classList: { add() {}, remove() {} } }) },
  });
  ctx.window.document = ctx.document;
  vm.runInContext(code, ctx);
  return Promise.all(listeners.map((fn) => fn())).then(() => dest);
}
const toOther = await route('other');
ok(toOther === '/?code=ABC123', "(e1) agent_type 'other' (influencer) lands on the homepage (got " + toOther + ')');
const toRe = await route('re_agent');
ok(toRe === '/ref-re.html?code=ABC123', "(e2) NEGATIVE CONTROL: re_agent still lands on ref-re.html (got " + toRe + ')');
const toIns = await route('insurance_agent');
ok(toIns === '/ref-insurance.html?code=ABC123', '(e3) control: insurance_agent unchanged (got ' + toIns + ')');

const toInsp = await route('home_inspector');
ok(toInsp === '/ref-inspector.html?code=ABC123', '(e4) control: home_inspector unchanged (got ' + toInsp + ')');
const toAdj = await route('adjuster');
ok(toAdj === '/ref-insurance.html?code=ABC123', '(e5) control: adjuster unchanged (got ' + toAdj + ')');
const toCust = await route('customer');
ok(toCust === '/ref-re.html?code=ABC123', '(e6) control: customer unchanged (got ' + toCust + ')');

// (g) features claimed on partner pages must exist: no co-branding or monthly-report claims
const partnerPages = fs.readdirSync(repoRoot).filter((f) => /^partner-.*\.html$/.test(f));
ok(partnerPages.includes('partner-influencers.html') && partnerPages.includes('partner-re.html'), '(g0) scan covers the influencer and realtor pages (' + partnerPages.length + ' partner pages)');
for (const f of partnerPages) {
  const h = read(f);
  ok(!/your audience sees who sent them/i.test(h), '(g1) ' + f + ': no "your audience sees who sent them" claim');
  ok(!/Monthly portfolio report/i.test(h), '(g2) ' + f + ': no "Monthly portfolio report" claim');
}
ok(/Referral history by month/.test(page) && /Filter your referrals by month and see each one's status and referral fee\./.test(page), '(g3) influencer page uses the corrected report line');
ok(/Your link identifies your referrals\. A homeowner is credited to the partner whose link they clicked most recently, within 90 days, before creating their Otter Quotes account\. That credit stays with that partner until 90 days after that click\. After that, it can go to a partner whose link the homeowner clicked more recently, within the previous 90 days\./.test(page), '(g4) influencer page uses the corrected link line (P18 credit-lock copy, #3226)');
{
  const all = fs.readdirSync(repoRoot).filter(n => /^partner-.*\.html$/.test(n));
  for (const f of all) ok(!/tracked back to you/i.test(read(f)), '(g5) ' + f + ': no unconditional "tracked back to you" promise (LEGAL-READ 6524846666)');
  for (const f of ['partner-inspectors.html', 'partner-other.html', 'partner-adjusters.html']) ok(/until 90 days after that click/.test(read(f)), '(g6) ' + f + ': carries the credit-lock copy');
}
ok(!/p_funnel_id:\s+'influencer'/.test(re), '(h) control: partner-re.html does not tag influencer');

// (f) legal pages untouched
try {
  const changed = execSync('git diff --name-only origin/main...HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  ok(!changed.includes('partner-agreement.html') && !changed.includes('privacy.html'), '(f) partner-agreement.html and privacy.html not changed on this branch');
} catch (e) {
  console.log('SKIP: (f) no origin/main to diff against');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
