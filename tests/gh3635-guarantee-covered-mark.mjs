/*
 * gh-3635 (P23) -- page-side covered mark for the 100-hour guarantee purchase-step block.
 *
 * Runs the REAL js/guarantee-gate.js and the REAL help-measurements.html init pieces (the code between the
 * gh-3635-covered-mark:begin/end markers plus the DOMContentLoaded wiring) in a vm with a fake window/document.
 * GUARANTEE_LIVE is flipped to true only in an IN-MEMORY copy of the gate source; the shipped file is never modified.
 *
 * Cases: (i) covered home + live reveals the purchase-step block; (ii) uncovered/unknown/error keeps it hidden;
 *        (iii) GUARANTEE_LIVE = false (the shipped file as is) hides everything, even for a covered home.
 * Also: the page reads only the buyer's own hover_orders row (never platform_settings) and ships no state list.
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

// A fake supabase query chain. rows = what the buyer's own hover_orders rows look like; throwErr = simulate a failure.
function makeClient({ row, error, throwErr, log }) {
  return {
    from(table) {
      log.push('from:' + table);
      const chain = {
        select() { return chain; }, eq() { return chain; }, not() { return chain; }, order() { return chain; }, limit() { return chain; },
        async maybeSingle() { if (throwErr) throw new Error('boom'); return { data: row ?? null, error: error ?? null }; },
      };
      return chain;
    },
  };
}

// Runs one page load: page logic (if the page has it), then the gate exactly as the page would load it.
async function load({ gateLive, covered }) {
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
  const ctx = vm.createContext({ window: win, document: doc, location: { hash: '' }, console });
  // The page's own marked block + its init wiring, as the page runs them.
  vm.runInContext(PAGE_BLOCK, ctx);
  if (SETS_MARK && typeof ctx.oqReadGuaranteeCovered === 'function') {
    const client = covered === 'error' ? makeClient({ throwErr: true, log })
      : covered === 'rowerror' ? makeClient({ error: { message: 'rls' }, log })
      : covered === 'norow' ? makeClient({ row: null, log })
      : makeClient({ row: { guarantee_covered: covered }, log });
    win.OQ_GUARANTEE_COVERED = await ctx.oqReadGuaranteeCovered(client, { id: 'claim-1' }, { id: 'user-1' });
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

// (i) covered home + GUARANTEE_LIVE true reveals the purchase-step block
{
  const r = await load({ gateLive: true, covered: true });
  ok(r.mark === true, '(i) covered home: window.OQ_GUARANTEE_COVERED === true');
  ok(r.purchaseBlockHidden === false, '(i) covered home + GUARANTEE_LIVE true: the purchase-step block is revealed');
  ok(r.plainBlockHidden === false, '(i) covered home + GUARANTEE_LIVE true: plain guarantee blocks are revealed too');
}
// (ii) uncovered / unknown / error keeps the purchase-step block hidden (plain blocks still follow GUARANTEE_LIVE)
for (const [label, covered] of [['uncovered (false)', false], ['unknown (no marked row)', 'norow'], ['read error (RLS/network)', 'rowerror'], ['read throws', 'error']]) {
  const r = await load({ gateLive: true, covered });
  ok(r.mark !== true, '(ii) ' + label + ': mark is not true (' + String(r.mark) + ')');
  ok(r.purchaseBlockHidden === true, '(ii) ' + label + ' + GUARANTEE_LIVE true: the purchase-step block stays hidden');
  ok(r.plainBlockHidden === false, '(ii) ' + label + ': plain blocks still follow GUARANTEE_LIVE (revealed)');
}
// (iii) GUARANTEE_LIVE false (the shipped file) hides everything, covered or not  [NEGATIVE CONTROL for "live"]
for (const covered of [true, false]) {
  const r = await load({ gateLive: false, covered });
  ok(r.purchaseBlockHidden === true && r.plainBlockHidden === true, '(iii) GUARANTEE_LIVE false, covered=' + covered + ': every guarantee block stays hidden');
}
// The shipped gate is still OFF and untouched by this change.
ok(/var GUARANTEE_LIVE = false;/.test(GATE_SRC), 'shipped js/guarantee-gate.js still has GUARANTEE_LIVE = false');
// Privacy / anon-safe path: only the buyer's own hover_orders row; never the service-role list; no list in the page.
{
  const r = await load({ gateLive: true, covered: true });
  ok(r.log.length > 0 && r.log.every((x) => x === 'from:hover_orders'), 'the page reads only hover_orders (reads: ' + r.log.join(',') + ')');
  ok(!/guarantee_excluded_states/.test(PAGE_BLOCK) && !/platform_settings/.test(PAGE_BLOCK), 'the page block never touches platform_settings or the excluded-state list');
  ok(!/\bFL\b[\s\S]{0,12}\bLA\b[\s\S]{0,12}\bTX\b/.test(PAGE_BLOCK), 'the page block ships no copy of the state list');
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
