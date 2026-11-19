/**
 * gh-3769 -- admin-contractors.html control for the staff SMS opt-out/opt-in action (admin-sms-optout, #3761/PR #3767).
 * Static assertions plus a behavioural run of callAdminSmsOptout() against a stubbed Supabase client. No network.
 * Run: node tests/gh3769-admin-sms-optout-control.mjs
 * GH3769_ROOT points at another tree (negative control: a checkout of the base branch).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH3769_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'admin-contractors.html'), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } };

// --- static: exists only for admins
ok(/admin-sms-optout/.test(page), 'page calls admin-sms-optout');
ok(!/id="smsOptModal"/.test(page), 'modal is not in the static HTML (built by JS only after the admin check)');
const initIdx = page.indexOf('async function init()');
const guardIdx = page.indexOf("showUnauthorized();", page.indexOf('if (!adminOk)', initIdx));
const enableIdx = page.indexOf('smsOptAdmin = true', initIdx);
ok(enableIdx > guardIdx && guardIdx > 0, 'smsOptAdmin is switched on only after the is_admin_email guard in init()');
ok(/\$\{smsOptAdmin \? `[\s\S]*?Record SMS opt-out[\s\S]*?Record SMS opt-in[\s\S]*?` : ''\}/.test(page), 'card buttons render only when smsOptAdmin');
ok(/Record SMS opt-out/.test(page) && /Record SMS opt-in/.test(page) && /for="smsOptChannel">Channel</.test(page) && /for="smsOptNote">Note</.test(page), 'labels: Record SMS opt-out / Record SMS opt-in / Channel / Note');

// --- behavioural
const m = page.match(/async function callAdminSmsOptout\(client, p\) \{[\s\S]*?\n        \}\n/);
ok(!!m, 'callAdminSmsOptout() defined');
if (m) {
  const make = (admin) => vm.runInNewContext(`let smsOptAdmin = ${admin}; ${m[0]}; callAdminSmsOptout`, {});
  const mkClient = (reply) => { const calls = []; return { calls, functions: { invoke: async (n, o) => { calls.push([n, o]); return reply; } } }; };
  const CID = '11111111-2222-4333-8444-555555555555';

  for (const [action, channel] of [['opt_out', 'email'], ['opt_out', 'support_call'], ['opt_in', 'email'], ['opt_in', 'support_call']]) {
    const c = mkClient({ data: { ok: true, action }, error: null });
    const r = await make(true)(c, { action, contractorId: CID, channel, note: '  caller asked to stop  ' });
    ok(r.ok && c.calls.length === 1 && c.calls[0][0] === 'admin-sms-optout'
      && JSON.stringify(c.calls[0][1].body) === JSON.stringify({ action, contractor_id: CID, channel, reason: 'caller asked to stop' }),
      `${action}/${channel}: sends exactly {action, contractor_id, channel, reason} to admin-sms-optout`);
  }

  // refusal surfaced verbatim, one call, no retry
  const refusal = { error: 'stop_by_text_needs_contractor_start', action: 'opt_in', suppressions_released: 0, blocked_by_contractor_stop: 1, numbers_needing_reverification: 0 };
  const rc = mkClient({ data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { status: 409, json: async () => refusal } } });
  const rr = await make(true)(rc, { action: 'opt_in', contractorId: CID, channel: 'email', note: 'caller asked' });
  ok(!rr.ok && rr.text === 'HTTP 409 ' + JSON.stringify(refusal), 'a 409 refusal is shown verbatim (status + body)');
  ok(rc.calls.length === 1, 'a refusal is not retried or worked around (exactly one call)');

  // missing channel / note never reach the function
  const nc = mkClient({ data: {}, error: null });
  const a = await make(true)(nc, { action: 'opt_out', contractorId: CID, channel: '', note: 'x' });
  const b = await make(true)(nc, { action: 'opt_out', contractorId: CID, channel: 'email', note: '   ' });
  ok(!a.ok && !b.ok && nc.calls.length === 0, 'no channel or blank note: nothing is sent');

  // not an admin: nothing is sent
  const ac = mkClient({ data: {}, error: null });
  const na = await make(false)(ac, { action: 'opt_out', contractorId: CID, channel: 'email', note: 'x' });
  ok(!na.ok && ac.calls.length === 0, 'not an admin: nothing is sent');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
