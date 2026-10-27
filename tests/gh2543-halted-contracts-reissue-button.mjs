/**
 * gh-2543 slice 2b -- the Re-issue button on admin-halted-contracts.html.
 *
 * The page's real functions are extracted and run in vm (the gh1796 idiom), with a
 * stubbed fetch / supabase session / confirm(), so what is tested is the shipped code.
 * Pinned: dry run first (confirm:false), the destructive call (confirm:true) only after the
 * admin accepts the plan, a refusal or a decline stops everything, no session means no
 * request, the row button carries the claim id and the expected envelope id (escaped), and
 * the page itself makes no table write and never reaches for a vendor delete.
 *
 * Run: node tests/gh2543-halted-contracts-reissue-button.mjs
 * GH2543_ROOT points at another tree for negative controls (e.g. a checkout of main).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2543_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'admin-halted-contracts.html'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

function extract(name) {
  for (const head of ['async function ' + name + '(', 'function ' + name + '(']) {
    const start = html.indexOf(head);
    if (start !== -1) return html.slice(start, html.indexOf('\n}\n', start) + 3);
  }
  return '';
}
const names = ['esc', 'money', 'daysAgo', 'callReissue', 'describeRefusal', 'describePlan', 'describeDone', 'showNote', 'onReissueClick', 'verdictBadge', 'renderRows'];
const src = names.map(extract);
ok(src.every(Boolean), 'page defines ' + names.join(', ') + (src.every(Boolean) ? '' : ' (missing: ' + names.filter((n, i) => !src[i]).join(', ') + ')'));

if (!src.every(Boolean)) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

function world({ session = { access_token: 'jwt-1' }, responses = [], confirmAnswer = true } = {}) {
  const calls = [];
  const note = { textContent: '', className: '', style: {} };
  const tbody = { innerHTML: '' };
  let reloaded = 0;
  const ctx = vm.createContext({
    CONFIG: { SUPABASE_URL: 'https://x.supabase.co' },
    sb: { auth: { getSession: async () => ({ data: { session } }) } },
    state: { filter: 'all', rows: [] },
    document: { getElementById: (id) => (id === 'actionNote' ? note : id === 'rows' ? tbody : null) },
    window: { confirm: (t) => { ctx.__confirmText = t; return confirmAnswer; } },
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const r = responses.shift() || { ok: false, status: 500, body: {} };
      return { ok: r.ok, status: r.status, json: async () => r.body };
    },
    loadHalted: async () => { reloaded++; },
  });
  vm.runInContext(src.join('\n') + '\nthis.__onClick = onReissueClick; this.__render = renderRows;', ctx);
  const btn = { disabled: false, getAttribute: (k) => ({ 'data-claim': 'claim-1', 'data-env': 'env-1' }[k]) };
  return { ctx, calls, note, tbody, btn, reloaded: () => reloaded };
}
const DRY = { ok: true, status: 200, body: { dry_run: true, envelope_id: 'env-1', document_status: 'completed', vendor_action: 'none', quotes_detached: ['q1'] } };
const DONE = { ok: true, status: 200, body: { success: true, audit_written: true, detached_envelope_id: 'env-1', vendor_action: 'none', quotes_detached: ['q1'] } };

// 1. accepted: dry run first, then confirm:true
{
  const w = world({ responses: [DRY, DONE], confirmAnswer: true });
  await w.ctx.__onClick(w.btn);
  ok(w.calls.length === 2, 'accepted flow makes exactly two requests');
  ok(w.calls[0] && w.calls[0].body.confirm === false, 'first request is a dry run (confirm:false)');
  ok(w.calls[1] && w.calls[1].body.confirm === true, 'second request, after the admin accepts, is confirm:true');
  ok(w.calls[0] && w.calls[0].url === 'https://x.supabase.co/functions/v1/admin-reissue-contract', 'calls the admin-reissue-contract function');
  ok(w.calls[0] && w.calls[0].init.headers.Authorization === 'Bearer jwt-1', "uses the admin's own session JWT");
  ok(w.calls[0] && w.calls[0].body.claim_id === 'claim-1' && w.calls[0].body.expected_envelope_id === 'env-1', 'sends claim_id and expected_envelope_id');
  ok(/Nothing has been written/.test(w.ctx.__confirmText || '') && /retained, never deleted/.test(w.ctx.__confirmText || ''), 'the plan shown before confirming says nothing is written and the document is retained');
  ok(w.reloaded() === 1 && /Re-issued/.test(w.note.textContent), 'list reloads and the result is shown');
  ok(w.btn.disabled === false, 'button is re-enabled afterwards');
}
// 2. declined: NO destructive call
{
  const w = world({ responses: [DRY, DONE], confirmAnswer: false });
  await w.ctx.__onClick(w.btn);
  ok(w.calls.length === 1 && w.calls[0].body.confirm === false, 'declining the plan sends no confirm:true request');
  ok(/Nothing was written/.test(w.note.textContent), 'declining says nothing was written');
}
// 3. refused by the function (409): stops, shows code and detail
{
  const w = world({ responses: [{ ok: false, status: 409, body: { refused: true, code: 'envelope_mismatch', detail: 'Claim now points at a different document' } }] });
  await w.ctx.__onClick(w.btn);
  ok(w.calls.length === 1, 'a refusal stops after the dry run');
  ok(/envelope_mismatch/.test(w.note.textContent) && /Nothing was written/.test(w.note.textContent) && /error/.test(w.note.className), 'refusal shows the code and is styled as an error');
}
// 4. a 200 that is not a dry-run plan is never treated as a plan
{
  const w = world({ responses: [{ ok: true, status: 200, body: { success: true } }] });
  await w.ctx.__onClick(w.btn);
  ok(w.calls.length === 1 && w.ctx.__confirmText === undefined, 'an unexpected 200 is not offered for confirmation');
}
// 5. no session -> no request
{
  const w = world({ session: null, responses: [DRY] });
  await w.ctx.__onClick(w.btn);
  ok(w.calls.length === 0 && /Not signed in/.test(w.note.textContent), 'no session sends no request');
}
// 6. confirm step fails (500): not reported as success, list reloaded so the admin sees current state
{
  const w = world({ responses: [DRY, { ok: false, status: 500, body: { error: 'boom' } }] });
  await w.ctx.__onClick(w.btn);
  ok(/boom/.test(w.note.textContent) && w.reloaded() === 1 && !/Re-issued/.test(w.note.textContent), 'a failed confirm is not reported as success and reloads the list');
}
// 6b. dialog wording: the revoke branch must say the e-signature service emails the signers
{
  const rev = { ...DRY, body: { ...DRY.body, vendor_action: 'revoke' } };
  const w1 = world({ responses: [rev] });
  await w1.ctx.__onClick(w1.btn);
  ok(/email both signers/.test(w1.ctx.__confirmText) && !/No message goes to either party/.test(w1.ctx.__confirmText), 'revoke plan tells the admin the signers are emailed');
  const w2 = world({ responses: [DRY] });
  await w2.ctx.__onClick(w2.btn);
  ok(/No message goes to either party/.test(w2.ctx.__confirmText), 'non-revoke plan says no message goes out');
  ok(!/sends no message to either party/.test(html), 'banner no longer claims no message is sent when a document is revoked');
}
// 7. row rendering
{
  const w = world();
  w.ctx.state.filter = 'all';
  w.ctx.state.rows = [
    { id: 'c"><img src=x>', status: 'awarded', signed_price_verdict: 'mismatch', selected_bid_amount: 13560, signed_contract_price: 13561, envelope: 'e"1' },
    { id: 'c2', status: 'awarded', signed_price_verdict: 'unverified', envelope: null },
  ];
  w.ctx.__render();
  const h = w.tbody.innerHTML;
  ok((h.match(/class="reissue-btn"/g) || []).length === 1, 'only the row with a document gets a button');
  ok(/data-claim="c&quot;&gt;&lt;img src=x&gt;"/.test(h) && /data-env="e&quot;1"/.test(h) && !/<img src=x>/.test(h), 'button attributes are escaped');
}
// 8. static guards: this page writes no table and never reaches for a vendor delete
// gh-3009: the one allowed rpc is the read-only admin check is_admin_email() (no args, returns boolean).
ok(!/\.(update|insert|delete|upsert)\(/.test(html) && !/\.rpc\((?!\s*'is_admin_email'\s*\))/.test(html), 'page makes no table write or rpc call (other than the read-only is_admin_email check)');
ok(!/document\/(delete|revoke)/i.test(html), 'page never calls a vendor delete or revoke endpoint itself');
ok(/admin-reissue-contract/.test(html), 'page targets admin-reissue-contract');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
