/**
 * gh-2107 / D-330 half 2 -- the static checkout's Services.createHoverPaymentIntent reports the browser's Global Privacy
 * Control signal to create-payment-intent. Dustin's ruling "b." (#2078 comment 5801822166), scope item 2.
 *
 * Loads the REAL js/services.js in a vm context with a fake `sb` and a fake `navigator`, so the assertions are about the
 * shipped code, not a copy. The React twin (react-app/app/lib/gpc.ts) has its own vitest.
 *
 * Run: node tests/gh2107-gpc-client.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, '..', 'js', 'services.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

function load(navigatorValue) {
  const invoked = [];
  const ctx = {
    sb: { functions: { invoke: (name, opts) => { invoked.push({ name, body: opts.body }); return Promise.resolve({ data: { client_secret: 'cs_x' }, error: null }); } } },
    console,
  };
  if (navigatorValue !== undefined) ctx.navigator = navigatorValue;
  vm.createContext(ctx);
  vm.runInContext(src + '\n;globalThis.__Services = Services;', ctx);
  return { Services: ctx.__Services, invoked };
}
const PARAMS = { claim_id: 'c1', amount: 1500, description: 'Complete Property Report' };
const BASE_BODY = { amount: 1500, currency: 'usd', description: 'Complete Property Report', metadata: { claim_id: 'c1', type: 'hover_measurement' } };

async function main() {
  // GPC on: gpc:true rides along, everything else unchanged
  {
    const { Services, invoked } = load({ globalPrivacyControl: true });
    await Services.createHoverPaymentIntent(PARAMS);
    ok(invoked.length === 1 && invoked[0].name === 'create-payment-intent', 'the checkout still calls create-payment-intent exactly once');
    ok(invoked[0].body.gpc === true, 'navigator.globalPrivacyControl === true -> the body carries gpc: true');
    const { gpc, ...rest } = invoked[0].body;
    ok(JSON.stringify(rest) === JSON.stringify(BASE_BODY), 'every other field is exactly what it was (amount, currency, description, metadata)');
  }
  // GPC off / absent / not exactly true: the request is byte-for-byte unchanged
  for (const [label, nav] of [['false', { globalPrivacyControl: false }], ['undefined property', {}], ['string "true"', { globalPrivacyControl: 'true' }], ['1', { globalPrivacyControl: 1 }], ['no navigator at all', undefined]]) {
    const { Services, invoked } = load(nav);
    await Services.createHoverPaymentIntent(PARAMS);
    ok(!('gpc' in invoked[0].body) && JSON.stringify(invoked[0].body) === JSON.stringify(BASE_BODY), 'GPC ' + label + ' -> no gpc field and the body is byte-for-byte unchanged');
  }
  // a hostile navigator must not break checkout
  {
    const nav = {}; Object.defineProperty(nav, 'globalPrivacyControl', { get() { throw new Error('locked down'); } });
    const { Services, invoked } = load(nav);
    let threw = false;
    try { await Services.createHoverPaymentIntent(PARAMS); } catch (e) { threw = true; }
    ok(!threw && invoked.length === 1 && !('gpc' in invoked[0].body), 'a navigator whose globalPrivacyControl getter throws does not break checkout and adds nothing');
  }
  // it is scoped to the measurement purchase wrapper: the other PaymentIntent wrappers are untouched by this change
  ok((src.match(/oqGpcField\(\)/g) || []).length === 2, 'oqGpcField is defined once and used once (the measurement purchase wrapper only)');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
