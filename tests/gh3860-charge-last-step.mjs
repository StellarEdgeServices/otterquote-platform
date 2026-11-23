// gh-3860 (P23 piece C): measurement charge as the LAST dashboard checklist step,
// dark behind CONFIG.MEASUREMENT_CHARGE_ENABLED. Static, no network, no jsdom: evaluates
// renderChecklist / isChecklistComplete from the dashboard.html text with a stub DOM.
// Run: node tests/gh3860-charge-last-step.mjs [path-to-dashboard.html]
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const file = process.argv[2] || 'dashboard.html';
const src = readFileSync(file, 'utf8');
function fnBody(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
function constBlock(name) {
  const m = src.match(new RegExp('const ' + name + ' = [^]*?;' + String.fromCharCode(10)));
  return m ? m[0] : null;
}
const flagDefault = /MEASUREMENT_CHARGE_ENABLED:\s*false/.test(readFileSync('js/config.js', 'utf8'));

function harness(flag, claim) {
  const container = { innerHTML: '', appendChild() {} };
  const parts = [
    constBlock('CHARGE_STEP_COPY_PENDING_GH3865'), constBlock('CHARGE_STEP_ROUTE'),
    fnBody('isAcvClaim'), fnBody('isChecklistComplete'),
    fnBody('isChargeStepEligible'), fnBody('areOtherChecklistItemsDone'), fnBody('buildChargeChecklistItem'),
    fnBody('renderChecklist'),
    'return { render: renderChecklist, complete: isChecklistComplete };',
  ].filter(Boolean).join('\n');
  const api = new Function('CONFIG', 'currentClaim', 'hoverRebateOrder', 'fileDisplayName', 'document', parts)(
    { MEASUREMENT_CHARGE_ENABLED: flag }, claim, null, (x) => x || null,
    { getElementById: () => container, createElement: () => ({ style: {}, appendChild() {} }) });
  api.render();
  const titles = [...container.innerHTML.matchAll(/class="checklist-title">([^<]*)/g)].map((m) => m[1].trim());
  return { html: container.innerHTML, titles, complete: api.complete(claim) };
}
let n = 0; const ok = (m) => console.log('ok ' + (++n) + ' - ' + m);
const BASE = ['Insurance Estimate', 'Measurements', 'Material Selection'];
const PEND = '[PENDING #3865: checklist step label]';
const noEst = { funding_type: 'cash', has_estimate: false, has_measurements: false, has_material_selection: true };

assert.equal(flagDefault, true); ok('js/config.js ships MEASUREMENT_CHARGE_ENABLED: false');

// 1. flag ON, no estimate, all other items done -> charge step LAST, actionable, routes to /help-measurements
let r = harness(true, noEst);
assert.deepEqual(r.titles, [...BASE, PEND]);
assert.ok(r.html.includes('href="/help-measurements"'));
assert.ok(!/checklist-item [^"]*disabled/.test(r.html));
ok('flag ON, no estimate, other items done: charge step is last, actionable, href=/help-measurements');

// 2. flag ON, estimate present -> no charge step (D-201/D-313 stay free)
r = harness(true, { funding_type: 'insurance', policy_type: 'rcv', has_estimate: true, has_material_selection: true });
assert.deepEqual(r.titles, BASE); assert.ok(!r.html.includes('PENDING #3865'));
ok('flag ON, insurance estimate present: no charge step');

// 3. flag ON, other items incomplete -> step present but NOT actionable (no link, disabled)
r = harness(true, { ...noEst, has_material_selection: false });
assert.deepEqual(r.titles, [...BASE, PEND]);
assert.ok(!r.html.includes('/help-measurements'));
assert.ok(/checklist-item\s+disabled|checklist-item [^"]*disabled/.test(r.html));
ok('flag ON, material not selected: charge step shown but not actionable (no route, disabled)');

// 4. Q8/Q4: declining keeps the free path; completion rule is unchanged by the flag
for (const c of [noEst, { ...noEst, has_material_selection: false }, { funding_type: 'insurance', policy_type: 'acv', has_material_selection: true },
  { funding_type: 'insurance', policy_type: 'rcv', has_estimate: true, has_material_selection: true }]) {
  assert.equal(harness(true, c).complete, harness(false, c).complete);
}
assert.equal(harness(true, { ...noEst, has_measurements: false }).complete, false); // cash: measurements still required, as on main
assert.equal(harness(true, { funding_type: 'insurance', policy_type: 'acv', has_estimate: true, has_material_selection: true }).complete, true);
ok('isChecklistComplete identical with flag on/off (charge never becomes the only way; ACV/D-407 unchanged)');

// 5. measurements already on file -> no charge step
r = harness(true, { ...noEst, has_measurements: true });
assert.deepEqual(r.titles, BASE);
ok('flag ON, measurements already on file: no charge step');

// 6. flag OFF -> identical to main: same three items, no placeholder text anywhere
for (const c of [noEst, { ...noEst, has_material_selection: false }, { funding_type: 'insurance', has_estimate: true, has_material_selection: true }]) {
  r = harness(false, c);
  assert.deepEqual(r.titles, BASE); assert.ok(!r.html.includes('PENDING #3865')); assert.ok(!r.html.includes('/help-measurements"'));
}
ok('flag OFF: checklist is the original three items, no placeholder, no charge route');
console.log(`\n${n} passed`);
