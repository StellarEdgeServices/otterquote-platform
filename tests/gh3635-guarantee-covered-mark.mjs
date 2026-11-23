/*
 * gh-3635 (P23) -- page-side covered mark for the 100-hour guarantee purchase-step block.
 *
 * Runs the REAL js/guarantee-gate.js and the REAL help-measurements.html init pieces (the code between the
 * gh-3635-covered-mark:begin/end markers plus the DOMContentLoaded wiring) in a vm with a fake window/document.
 * GUARANTEE_LIVE is flipped to true only in an IN-MEMORY copy of the gate source; the shipped file is never modified.
 *
 * Cases: (i) covered home + live reveals the purchase-step block, with NO order row yet (a first-time buyer): IN shows, FL does not;
 *        (ii) excluded/unknown/error/timeout/no-session keeps it hidden; (iii) GUARANTEE_LIVE = false (the shipped file as is) hides everything.
 * Also: the page's only read is the rpc get_guarantee_covered (never a table, never platform_settings) and it ships no state list.
 * The SQL function itself is proved against the TypeScript rules by supabase/functions/create-measurement-order/guarantee-covered-sql-parity.test.ts.
 *
 * Run: node tests/gh3635-guarantee-covered-mark.mjs
 * Override the page under test (negative control against main): OQ_TEST_HTML=/path/to/help-measurements.html
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HTML = fs.readFileSync(process.env.OQ_TEST_HTML || path.join(ROOT, 'help-measurements.html'), 'utf8');
const GATE_SRC = fs.readFileSync(path.join(ROOT, 'js', 'guarantee-gate.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const m = HTML.match(/\/\* gh-3635-covered-mark:begin \*\/([\s\S]*?)\/\* gh-3635-covered-mark:end \*\//);
const PAGE_BLOCK = m ? m[1] : '';
const STATIC_GATE_TAG = /<script[^>]+src="\/js\/guarantee-gate\.js"[^>]*defer/.test(HTML);
const FINALLY_LOADS_GATE = /finally\s*\{[^}]*oqLoadGuaranteeGate\(\)/.test(HTML);
const SETS_MARK = /window\.OQ_GUARANTEE_COVERED\s*=\s*await\s+oqReadGuaranteeCovered\(/.test(HTML);

// A fake supabase client. The page may call ONLY rpc('get_guarantee_covered', { p_claim_id }); any table read is recorded and throws.
// The fake "database" answers like the real function for the signed-in buyer's own claim: covered unless the state is on the launch list
// (the SQL itself is proved against the TS rules by the parity test). There is NO hover_orders row in any scenario: a first-time buyer.
const LAUNCH_EXCLUDED = ['FL', 'LA', 'TX', 'OK', 'AR', 'KS', 'NE', 'MI', 'KY'];
function makeClient({ state, mode, log }) {
  return {
    from(table) { log.push('from:' + table); throw new Error('the page must not read tables'); },
    rpc(name, args) {
      log.push('rpc:' + name + ':' + (args && args.p_claim_id));
      if (mode === 'throws') throw new Error('boom');
      if (mode === 'hang') return new Promise(() => {});
      if (mode === 'error') return Promise.resolve({ data: null, error: { message: 'rls / network' } });
      if (mode === 'unknown') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: !LAUNCH_EXCLUDED.includes(state), error: null });
    },
  };
}

// Runs one page load: page logic (if the page has it), then the gate exactly as the page would load it.
async function load({ gateLive, state = 'IN', mode = 'ok', noSession = false }) {
  const block = { hidden: true, cls: 'oq-guarantee', needs: true };      // purchase-step block (data-guarantee-needs-covered)
  const terms = { hidden: true, cls: 'oq-guarantee', needs: false };     // a plain guarantee block
  const els = [block, terms].map((o) => ({
    get hidden() { return o.hidden; }, set hidden(v) { o.hidden = v; },
    hasAttribute: (a) => a === 'data-guarantee-needs-covered' && o.needs,
  }));
  const injected = [];
  const doc = {
    readyState: 'complete',
    body: { appendChild: (el) => injected.push(el) },
    createElement: (tag) => ({ tag }),
    querySelectorAll: (sel) => (sel === '.oq-guarantee' ? els : []),
    getElementById: () => null,
    addEventListener() {},
  };
  const win = { };
  const log = [];
  const ctx = vm.createContext({ window: win, document: doc, location: { hash: '' }, console, setTimeout, clearTimeout });
  // The page's own marked block + its init wiring, as the page runs them.
  vm.runInContext(PAGE_BLOCK, ctx);
  if (SETS_MARK && typeof ctx.oqReadGuaranteeCovered === 'function') {
    const client = makeClient({ state, mode, log });
    win.OQ_GUARANTEE_COVERED = await ctx.oqReadGuaranteeCovered(client, { id: 'claim-1' }, noSession ? null : { id: 'user-1' }, 50);
  }
  if (FINALLY_LOADS_GATE && typeof ctx.oqLoadGuaranteeGate === 'function') ctx.oqLoadGuaranteeGate();
  // Did the page load the gate? Either the injected script or (old pages) the static defer tag.
  const gateLoaded = injected.some((e) => e.src === '/js/guarantee-gate.js') || STATIC_GATE_TAG;
  if (gateLoaded) {
    const src = gateLive ? GATE_SRC.replace('var GUARANTEE_LIVE = false;', 'var GUARANTEE_LIVE = true;') : GATE_SRC;
    if (gateLive && src === GATE_SRC) throw new Error('could not flip GUARANTEE_LIVE in the in-memory gate copy');
    vm.runInContext(src, ctx);
  }
  return { purchaseBlockHidden: els[0].hidden, plainBlockHidden: els[1].hidden, mark: win.OQ_GUARANTEE_COVERED, log, injected };
}

console.log('page has the covered-mark block: ' + !!m + ' | sets the mark: ' + SETS_MARK + ' | gate loaded after the mark: ' + FINALLY_LOADS_GATE);

// (i) covered state + GUARANTEE_LIVE true reveals the purchase-step block, with no order row yet: IN shows, FL does not
{
  const r = await load({ gateLive: true, state: 'IN' });
  ok(r.mark === true, '(i) IN, no order row: window.OQ_GUARANTEE_COVERED === true');
  ok(r.purchaseBlockHidden === false, '(i) IN (covered, no order row) + GUARANTEE_LIVE true: the purchase-step block is revealed');
  ok(r.plainBlockHidden === false, '(i) IN + GUARANTEE_LIVE true: plain guarantee blocks are revealed too');
  ok(r.log.length === 1 && r.log[0] === 'rpc:get_guarantee_covered:claim-1', 'the page asked the database function for its own claim (' + r.log.join(',') + ')');
  const fl = await load({ gateLive: true, state: 'FL' });
  ok(fl.mark === false, '(i) FL (excluded): mark is false');
  ok(fl.purchaseBlockHidden === true, '(i) FL (excluded) + GUARANTEE_LIVE true: the purchase-step block stays hidden');
}
// (ii) unknown / error / timeout / no session keeps the purchase-step block hidden (plain blocks still follow GUARANTEE_LIVE)
for (const [label, opts] of [['unknown (null)', { mode: 'unknown' }], ['rpc error (RLS/network)', { mode: 'error' }], ['rpc throws', { mode: 'throws' }], ['rpc never answers (timeout)', { mode: 'hang' }], ['no signed-in user', { noSession: true }]]) {
  const r = await load({ gateLive: true, ...opts });
  ok(r.mark !== true, '(ii) ' + label + ': mark is not true (' + String(r.mark) + ')');
  ok(r.purchaseBlockHidden === true, '(ii) ' + label + ' + GUARANTEE_LIVE true: the purchase-step block stays hidden');
  ok(r.plainBlockHidden === false, '(ii) ' + label + ': plain blocks still follow GUARANTEE_LIVE (revealed)');
}
// (iii) GUARANTEE_LIVE false (the shipped file) hides everything, covered or not  [NEGATIVE CONTROL for "live"]
for (const state of ['IN', 'FL']) {
  const r = await load({ gateLive: false, state });
  ok(r.purchaseBlockHidden === true && r.plainBlockHidden === true, '(iii) GUARANTEE_LIVE false, state=' + state + ': every guarantee block stays hidden');
}
// The shipped gate is still OFF and untouched by this change.
ok(/var GUARANTEE_LIVE = false;/.test(GATE_SRC), 'shipped js/guarantee-gate.js still has GUARANTEE_LIVE = false');
// The page ships no table read, no service-role list, no copy of the state list; the 5 s timeout is the default.
ok(!/hover_orders|platform_settings|guarantee_excluded_states/.test(PAGE_BLOCK.replace(/\/\/[^\n]*/g, '')), 'the page block (code, comments aside) reads no table and never touches the excluded-state list');
ok(!/\bFL\b[\s\S]{0,12}\bLA\b[\s\S]{0,12}\bTX\b/.test(PAGE_BLOCK), 'the page block ships no copy of the state list');
ok(/typeof timeoutMs === 'number' \? timeoutMs : 5000/.test(PAGE_BLOCK), 'the default timeout is 5000 ms');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
