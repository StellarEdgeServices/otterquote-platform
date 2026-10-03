/**
 * gh-2479 (companion to PR #2502) -- trade-selector.html's claim writer must
 * NOT send claims.referral_id on the UPDATE of an already-existing claim, and
 * MUST still send it on the INSERT of a new claim.
 *
 * PR #2502 adds a BEFORE UPDATE guard on `claims` that raises 42501 when a
 * signed-in client changes referral_id. An UPDATE payload that carries a
 * differing referral_id would then fail the WHOLE trades save. The INSERT is
 * how a referral is attributed and is unchanged.
 *
 * This runs the REAL claim-writer block (extracted from the shipped file,
 * "// Update or create claim" .. the gh-2060 item 3 comment) in a vm-less
 * Function with a recording fake Supabase client.
 *
 *   (a) existing claim -> UPDATE payload has NO referral_id   (fails on main)
 *   (b) no claim       -> INSERT payload still HAS referral_id (passes on main)
 *   (c) cookie: an existing-claim pass with ONLY a referral id does not clear
 *       it (nothing consumed it); a pass that also carried an agent id still does.
 *
 * Run: node tests/gh2479-static-trade-selector-update-payload.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'trade-selector.html'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const startMarker = '// Update or create claim';
const endMarker = '// gh-2060 item 3 (CEO ruling';
const a = src.indexOf(startMarker), b = src.indexOf(endMarker);
ok(a > 0 && b > a, 'claim-writer block located in trade-selector.html');
if (!(a > 0 && b > a)) process.exit(1);
const block = src.slice(a, b);

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runBlock = new AsyncFunction(
  'sb', 'user', 'selections', 'state', 'profile', 'jobType', 'propertyAddress',
  'resolveReferralAgentId', 'window', 'sessionStorage', 'localStorage', 'Auth', 'gtag',
  'let savedClaimId = null;\n' + block + '\nreturn savedClaimId;',
);

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function drive({ existing, cookie }) {
  const calls = { update: null, insert: null, cleared: 0 };
  const sb = {
    from: () => ({
      select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
      single: () => Promise.resolve({ data: existing ? { id: 'claim-1' } : null, error: null }),
      update(p) { calls.update = p; return { eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'claim-1' }], error: null }) }) }; },
      insert(p) { calls.insert = p; return { select: () => ({ single: () => Promise.resolve({ data: { id: 'new-1' }, error: null }) }) }; },
    }),
  };
  const win = { OtterQuoteReferral: { read: () => cookie, clear: () => { calls.cleared++; } } };
  await runBlock(
    sb, { id: 'u1', email: 'jane@example.com' }, { trades: [{ trade: 'Roofing' }] },
    { fundingType: 'cash', policyType: null }, { address_state: 'IN' }, 'replace', '1 Main St',
    async () => null, win, store(), store(), { isTestEmail: () => false }, undefined,
  );
  return calls;
}

const REF_ONLY = { oq_referral_id: 'ref-new-222' };
const REF_AND_AGENT = { oq_referral_id: 'ref-new-222', oq_referral_agent_id: 'agent-9', oq_referral_code: 'PARTNERX' };

{
  const c = await drive({ existing: true, cookie: REF_AND_AGENT });
  ok(!!c.update && !c.insert, '(a) existing claim: the UPDATE branch ran (no insert)');
  ok(c.update && !('referral_id' in c.update), '(a) existing-claim UPDATE payload has NO referral_id');
  ok(c.update && c.update.referral_agent_id === 'agent-9' && c.update.referral_code === 'PARTNERX',
    '(a) existing-claim UPDATE still carries referral_agent_id / referral_code (nothing else about the save changed)');
  ok(c.update && Array.isArray(c.update.trades) && c.update.trades[0] === 'Roofing', '(a) existing-claim UPDATE still saves the trades');
}
{
  const c = await drive({ existing: false, cookie: REF_AND_AGENT });
  ok(!!c.insert && !c.update, '(b) no claim: the INSERT branch ran (no update)');
  ok(c.insert && c.insert.referral_id === 'ref-new-222', '(b) new-claim INSERT payload still HAS referral_id');
}
{
  const c = await drive({ existing: true, cookie: REF_ONLY });
  ok(c.cleared === 0, '(c) existing claim + referral id ONLY: the never-used cookie is NOT cleared');
}
{
  const c = await drive({ existing: true, cookie: REF_AND_AGENT });
  ok(c.cleared === 1, '(c) existing claim + agent id carried: cookie still cleared as consumed (unchanged)');
}
{
  const c = await drive({ existing: false, cookie: REF_ONLY });
  ok(c.cleared === 1, '(c) new claim + referral id: cookie cleared as consumed (unchanged)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
