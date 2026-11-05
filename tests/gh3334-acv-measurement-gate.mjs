// gh-3334 (D-407 follow-up): a measurement-only ACV homeowner must pass the dashboard
// Submit-for-Bids gate; RCV (and unknown policy) must still require the estimate.
// Static, no network. Run: node tests/gh3334-acv-measurement-gate.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync('dashboard.html', 'utf8');
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
const gate = new Function(
  [fnBody('isAcvClaim'), fnBody('isChecklistComplete'), 'return isChecklistComplete;'].filter(Boolean).join('\n'),
)();
let n = 0; const ok = (m) => console.log('ok ' + (++n) + ' - ' + m);
const base = { is_test: true, has_material_selection: true };

// The fix: ACV with only a purchased measurement can submit.
assert.equal(gate({ ...base, funding_type: 'insurance', policy_type: 'acv', has_measurements: true, has_estimate: false }), true);
ok('ACV, measurement only: submit allowed');
assert.equal(gate({ ...base, funding_type: 'insurance', policy_type: 'acv', has_estimate: true, has_measurements: false }), true);
ok('ACV, estimate only: submit allowed');
assert.equal(gate({ ...base, funding_type: 'insurance', policy_type: 'acv', has_estimate: false, has_measurements: false }), false);
ok('ACV, neither: blocked');
assert.equal(gate({ ...base, has_material_selection: false, funding_type: 'insurance', policy_type: 'acv', has_measurements: true }), false);
ok('ACV, measurement but no material selection: blocked');

// Negative control: RCV / unknown insurance still require the estimate.
assert.equal(gate({ ...base, funding_type: 'insurance', policy_type: 'rcv', has_measurements: true, has_estimate: false }), false);
ok('RCV, measurement only: still blocked (estimate required)');
assert.equal(gate({ ...base, funding_type: 'insurance', policy_type: 'rcv', has_estimate: true }), true);
ok('RCV with estimate: allowed');
assert.equal(gate({ ...base, funding_type: 'insurance', policy_type: null, has_measurements: true, has_estimate: false }), false);
ok('insurance, unknown policy, measurement only: still blocked');
assert.equal(gate({ ...base, funding_type: null, policy_type: 'acv', has_measurements: true, has_estimate: false }), true);
ok('null funding_type on an ACV policy follows ACV');

// Cash unchanged.
assert.equal(gate({ ...base, funding_type: 'cash', has_measurements: true }), true);
assert.equal(gate({ ...base, funding_type: 'cash', has_estimate: true, has_measurements: false }), false);
ok('cash: measurements required, estimate irrelevant');
console.log(`\n${n} passed`);
