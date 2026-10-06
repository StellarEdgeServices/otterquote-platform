/**
 * gh-2491 -- messaging must label the other party without widening RLS.
 *
 * Rulings: #2491 5969703283 (homeowner sees the contractor's business name) and
 * 5972779494 (AMENDED: a contractor sees the literal "the homeowner" until the platform
 * fee is collected; Contractor Agreement 6.2 / D-277). The label comes from the narrow
 * SECURITY DEFINER rpc get_message_counterpart; the pages never read the other party's
 * profiles row.
 *
 * Three layers, no network, no secrets:
 *   1. static: the dead duplicate Messages panel is gone (each id exactly once) and the
 *      old "--" label expression is gone;
 *   2. behavioural: each page's real messaging <script> runs in a node vm against a fake
 *      Supabase client; the rendered HTML is asserted for every case;
 *   3. migration text: SECURITY DEFINER, authenticated-only grant, the homeowner's name is
 *      selected only after the fee condition, nothing but a label is returned.
 * NEGATIVE CONTROL: the same behavioural checks are run against a copy of each script with
 * the label call swapped back to the pre-gh-2491 expression; they must FAIL there.
 *
 * Run: node tests/gh2491-message-counterpart.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const dash = read('dashboard.html');
const ctr = read('contractor-dashboard.html');
const mig = read('supabase/migrations/20261005210000_gh2491_message_counterpart.sql');
const rb = read('supabase/migrations_rollbacks/20261005210000_gh2491_message_counterpart_rollback.sql');

// ---------- 1. static ----------
const count = (s, re) => (s.match(re) || []).length;
for (const [name, src] of [['dashboard.html', dash], ['contractor-dashboard.html', ctr]]) {
  for (const id of ['messagingClaimSelect', 'messagingThreadContainer', 'messagesList', 'messageBody', 'messageSendBtn', 'messageStatus']) {
    ok(count(src, new RegExp('id="' + id + '"', 'g')) === 1, `${name}: id="${id}" appears exactly once (no dead duplicate panel)`);
  }
  ok(count(src, /class="card messages-section"/g) === 1, `${name}: exactly one Messages panel`);
  ok(!/full_name\) \|\| "--"/.test(src), `${name}: the old "|| \\"--\\"" sender label is gone`);
  ok(/sb\.rpc\("get_message_counterpart", \{ p_claim_id: currentClaimId \}\)/.test(src), `${name}: label comes from sb.rpc(get_message_counterpart)`);
}
ok(count(dash, /id="contractorName"/g) === 1, 'dashboard.html: id="contractorName" appears exactly once');

// ---------- 2. behavioural ----------
function messagingScript(html, page) {
  const marker = '<script>\n// Messaging — ' + page;
  const s = html.indexOf(marker);
  if (s < 0) throw new Error('messaging script not found in ' + page);
  const e = html.indexOf('</script>', s);
  return html.slice(s + '<script>'.length, e);
}
// The label sits in its own div: a placeholder would render as >--< (CSS vars like var(--navy) are not placeholders).
const dashPlaceholder = (h) => />--(\s\(You\))?</.test(h);
const flush = () => new Promise((r) => setTimeout(r, 0));

async function run(page, src, { rpc, messages, claimId = 'claim-1' }) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: '', innerHTML: '', value: '', disabled: false, scrollTop: 0, scrollHeight: 0, style: {}, options: { length: 2 }, listeners: {}, appendChild() {}, addEventListener(t, f) { this.listeners[t] = f; } });
  const rpcCalls = [];
  const q = (data) => { const o = { select: () => o, eq: () => o, order: () => o, single: () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data }), maybeSingle: () => Promise.resolve({ data: null }), then: (f) => Promise.resolve({ data, error: null }).then(f) }; return o; };
  let authCb;
  const sb = {
    auth: { onAuthStateChange: (cb) => { authCb = cb; }, getSession: async () => ({ data: { session: { access_token: 't' } } }) },
    rpc: async (name, args) => { rpcCalls.push({ name, args }); return rpc(); },
    from: (table) => {
      if (table === 'claims') return q([{ id: claimId, property_address: '1 Main St', selected_contractor_id: 'ctr-1', quotes: [{ contractor_id: 'ctr-1', contractors: { id: 'ctr-1', user_id: 'u-ctr' } }] }]);
      if (table === 'contractors') return q({ id: 'ctr-me' });
      if (table === 'quotes') return q([{ claim_id: claimId, claims: { id: claimId, user_id: 'u-ho', property_address: '1 Main St' } }]);
      if (table === 'messages') return q(messages);
      if (table === 'profiles') throw new Error('messaging must not read profiles directly');
      throw new Error('unexpected table ' + table);
    },
  };
  const ctx = { sb, console: { log() {}, warn() {}, error() {} }, setInterval: () => 1, clearInterval() {}, setTimeout, document: { getElementById: el, createElement: () => ({ }) }, fetch: async () => ({}), CONFIG: { SUPABASE_ANON: 'a' }, Date, Array, JSON, Promise, String };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  authCb('INITIAL_SESSION', { user: { id: page === 'dashboard.html' ? 'u-ho' : 'u-ctr-me' } });
  await flush(); await flush();
  el('messagingClaimSelect').listeners.change({ target: { value: claimId } });
  await flush(); await flush(); await flush();
  return { html: el('messagesList').innerHTML, header: el('contractorName').textContent, rpcCalls };
}

const NAME = 'Dana Smith';
async function contractorChecks(src, label) {
  const msgs = [
    { id: 'm1', sender_id: 'u-ho', sender_role: 'homeowner', body: 'hello', created_at: '2026-10-05T00:00:00Z', profiles: { full_name: NAME } }, // even if the embed leaked a name
    { id: 'm2', sender_id: 'u-ctr-me', sender_role: 'contractor', body: 'hi', created_at: '2026-10-05T00:01:00Z', profiles: { full_name: 'My Co' } },
    { id: 'm3', sender_id: 'u-other', sender_role: 'contractor', body: 'x', created_at: '2026-10-05T00:02:00Z', profiles: null },
  ];
  const generic = await run('contractor-dashboard.html', src, { rpc: async () => ({ data: [{ counterpart_user_id: 'u-ho', counterpart_role: 'homeowner', display_label: 'the homeowner' }], error: null }), messages: msgs });
  const failing = await run('contractor-dashboard.html', src, { rpc: async () => ({ data: null, error: { message: 'function does not exist' } }), messages: msgs });
  const feePaid = await run('contractor-dashboard.html', src, { rpc: async () => ({ data: [{ counterpart_user_id: 'u-ho', counterpart_role: 'homeowner', display_label: NAME }], error: null }), messages: msgs });
  return [
    [generic.html.includes('the homeowner'), `${label}: before the fee the homeowner's messages read "the homeowner"`],
    [!generic.html.includes(NAME), `${label}: before the fee no homeowner name is rendered even if the profiles embed carried one`],
    [!dashPlaceholder(generic.html), `${label}: no "--" placeholder`],
    [generic.html.includes('Another contractor'), `${label}: a message from a different contractor is labelled "Another contractor", not the homeowner`],
    [generic.rpcCalls.length > 0 && generic.rpcCalls.every((c) => c.name === 'get_message_counterpart' && c.args.p_claim_id === 'claim-1'), `${label}: rpc called as get_message_counterpart({p_claim_id})`],
    [failing.html.includes('the homeowner') && !failing.html.includes(NAME) && !dashPlaceholder(failing.html), `${label}: rpc missing/failing still renders the safe literal "the homeowner", never a name or "--"`],
    [feePaid.html.includes(NAME) && !feePaid.html.includes('the homeowner'), `${label}: after the fee the rpc-returned name is shown (and only because the rpc returned it)`],
  ];
}
async function homeownerChecks(src, label) {
  const msgs = [
    { id: 'm1', sender_id: 'u-ctr', sender_role: 'contractor', body: 'hello', created_at: '2026-10-05T00:00:00Z', profiles: null },
    { id: 'm2', sender_id: 'u-ho', sender_role: 'homeowner', body: 'hi', created_at: '2026-10-05T00:01:00Z', profiles: { full_name: 'Pat Owner' } },
    { id: 'm3', sender_id: 'u-other', sender_role: 'contractor', body: 'x', created_at: '2026-10-05T00:02:00Z', profiles: null },
  ];
  const good = await run('dashboard.html', src, { rpc: async () => ({ data: [{ counterpart_user_id: 'u-ctr', counterpart_role: 'contractor', display_label: 'Acme Roofing' }], error: null }), messages: msgs });
  const failing = await run('dashboard.html', src, { rpc: async () => ({ data: null, error: { message: 'x' } }), messages: msgs });
  return [
    [good.header === 'Acme Roofing', `${label}: "Talking with" shows the contractor's business name`],
    [good.html.includes('Acme Roofing'), `${label}: the contractor's messages are labelled with the business name`],
    [good.html.includes('Another contractor'), `${label}: another contractor's message is not attributed to the selected contractor`],
    [good.html.includes('Pat Owner (You)'), `${label}: own messages keep "name (You)"`],
    [!dashPlaceholder(good.html) && good.header !== '--', `${label}: no "--" placeholder`],
    [good.rpcCalls.length > 0 && good.rpcCalls.every((c) => c.name === 'get_message_counterpart' && c.args.p_claim_id === 'claim-1'), `${label}: rpc called as get_message_counterpart({p_claim_id})`],
    [failing.header === 'your contractor' && !dashPlaceholder(failing.html), `${label}: rpc missing/failing shows the generic "your contractor", never "--"`],
  ];
}

const dashSrc = messagingScript(dash, 'dashboard.html');
const ctrSrc = messagingScript(ctr, 'contractor-dashboard.html');
for (const [c, m] of [...await contractorChecks(ctrSrc, 'contractor-dashboard.html'), ...await homeownerChecks(dashSrc, 'dashboard.html')]) ok(c, m);

// NEGATIVE CONTROL: same checks against the pre-gh-2491 label expression. They must fail.
const LEGACY = '((msg.profiles && msg.profiles.full_name) || "--") + (isOwn ? " (You)" : "")';
const mutate = (s) => { if (!s.includes('escapeHtml(senderLabel(msg, isOwn))')) throw new Error('mutation anchor missing'); return s.replace('escapeHtml(senderLabel(msg, isOwn))', 'escapeHtml(' + LEGACY + ')'); };
const legacyC = await contractorChecks(mutate(ctrSrc), 'legacy contractor label');
const legacyH = await homeownerChecks(mutate(dashSrc), 'legacy homeowner label');
ok(legacyC.filter(([c]) => !c).length >= 3, `negative control: the pre-gh-2491 contractor label fails ${legacyC.filter(([c]) => !c).length} of ${legacyC.length} checks`);
ok(legacyH.filter(([c]) => !c).length >= 3, `negative control: the pre-gh-2491 homeowner label fails ${legacyH.filter(([c]) => !c).length} of ${legacyH.length} checks`);

// ---------- 3. migration text ----------
const code = mig.replace(/--.*$/gm, '');
ok(/SECURITY DEFINER/.test(code) && /SET search_path = public, pg_temp/.test(code), 'migration: SECURITY DEFINER with a pinned search_path');
ok(/REVOKE ALL ON FUNCTION public\.get_message_counterpart\(uuid\) FROM PUBLIC/.test(code) && /REVOKE ALL ON FUNCTION public\.get_message_counterpart\(uuid\) FROM anon/.test(code), 'migration: EXECUTE revoked from PUBLIC and anon');
ok(/GRANT EXECUTE ON FUNCTION public\.get_message_counterpart\(uuid\) TO authenticated/.test(code) && !/TO anon/.test(code), 'migration: EXECUTE granted to authenticated only');
ok(!/(CREATE|ALTER|DROP)\s+POLICY/i.test(code), 'migration: no RLS policy is created, altered or dropped (profiles/contractors RLS untouched)');
ok(code.indexOf('FROM public.profiles') > code.indexOf('v_fee_charged THEN') && count(code, /FROM public\.profiles/g) === 1, 'migration: the homeowner\'s name is selected only inside the fee-collected branch');
ok(/claims c/.test(code) && /platform_fee_charged/.test(code) && /v_selected IS NOT DISTINCT FROM v_my_ctr/.test(code), 'migration: name branch requires the selected contractor AND claims.platform_fee_charged');
ok(!/\bemail\b|\bphone\b|property_address/i.test(code), 'migration: the function never touches email, phone or address');
// Hole closed in the delta commit (Marty, A: on PR #2545): a claim owner who points selected_contractor_id at a
// contractor with NO quote on the claim must get zero rows, not that contractor's account id.
const homeownerBranch = code.slice(code.indexOf('IF v_owner = v_uid THEN'), code.indexOf('-- Caller is a contractor') > 0 ? code.indexOf('SELECT k.id INTO v_my_ctr') : undefined);
ok(/FROM public\.contractors k[\s\S]*WHERE k\.id = v_selected[\s\S]*AND EXISTS \(\s*SELECT 1 FROM public\.quotes q\s*WHERE q\.claim_id = p_claim_id AND q\.contractor_id = v_selected\s*\)/.test(homeownerBranch), 'migration: the homeowner branch answers only for a selected contractor who has a quote on this claim (non-party gets no row)');
ok(/DROP FUNCTION IF EXISTS public\.get_message_counterpart\(uuid\)/.test(rb), 'rollback: drops the function');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
