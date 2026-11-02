/**
 * gh-3282 / PR #3295 (D-407 half 2, Ben ruling 2026-10-31 + D-079) -- static project-info-rcv.html.
 * An "I'm not sure" homeowner has policy_type 'idk' stored. On this page the
 * "This job is being paid for via ... (Replacement Cost Value)" line must be hidden and the
 * save must never write policy_type. A stored 'rcv' keeps today's behavior (line shown, write 'rcv').
 * Runs the page's inline script against a stub DOM + stub Supabase client. No network.
 * Run: node tests/gh3295-project-info-rcv-idk.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const src = fs.readFileSync(path.join(ROOT, 'project-info-rcv.html'), 'utf8');
const script = src.slice(src.lastIndexOf('<script>') + 8, src.lastIndexOf('</script>'));

async function run(stored) {
  const els = {};
  const el = (id) => (els[id] ||= { id, value: '', style: {}, textContent: '', disabled: false, listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } });
  els['pi-pay-line'] = { id: 'pi-pay-line', style: { visibility: 'hidden' } };
  const updates = [];
  const sb = {
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { policy_type: stored }, error: null }) }) }),
      update: (u) => { updates.push(u); return { eq: () => ({ select: async () => ({ data: [{ id: 'c1' }], error: null }) }) }; },
    }),
  };
  const ctx = {
    console, URLSearchParams, Date, Array, String,
    window: { location: { search: '?claim_id=c1', href: '' }, supabase: { createClient: () => sb }, OtterQuoteCookieStorage: {} },
    document: { getElementById: el },
    sessionStorage: { getItem: () => null },
    Auth: { requireAuth: async () => ({ id: 'u1' }) },
    Nav: { renderHeader() {}, renderFooter() {} },
    CONFIG: { SUPABASE_URL: 'x', SUPABASE_ANON: 'y' },
    gtag() {},
    sb: null,
  };
  ctx.document.addEventListener = (t, f) => { ctx.__ready = f; };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  if (ctx.__ready) await ctx.__ready();
  await new Promise((r) => setTimeout(r, 20));
  els['urgency'] = Object.assign(el('urgency'), { value: 'flexible' });
  await els['pi-submit'].listeners.click();
  await new Promise((r) => setTimeout(r, 20));
  return { line: els['pi-pay-line'], updates };
}

const idk = await run('idk');
ok(idk.line.style.display === 'none', 'idk: assertion line hidden');
ok(idk.updates.length === 1, 'idk: one claims update issued');
ok(!('policy_type' in idk.updates[0]), 'idk: save payload has NO policy_type key (never overwritten to rcv)');
ok(idk.updates[0].job_type === 'insurance_rcv' && idk.updates[0].funding_type === 'insurance', 'idk: job_type insurance_rcv / funding_type insurance unchanged');

const rcv = await run('rcv');
ok(rcv.line.style.display !== 'none' && rcv.line.style.visibility === 'visible', 'rcv: assertion line shown');
ok(rcv.updates.length === 1 && rcv.updates[0].policy_type === 'rcv', "rcv: save payload writes policy_type 'rcv' (unchanged)");
ok(rcv.updates[0].job_type === 'insurance_rcv' && rcv.updates[0].funding_type === 'insurance', 'rcv: job_type / funding_type unchanged');

const nul = await run(null);
ok(nul.line.style.display !== 'none' && nul.updates[0].policy_type === 'rcv', 'null stored: today behavior (line shown, writes rcv)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
