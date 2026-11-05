// gh-3398 (P14, D-407): dashboard must not tell a stored `idk` payment answer "paid for by Insurance (RCV)",
// and the edit-form save must not rewrite `idk` to `rcv`. No new wording: the line is hidden.
// Static + vm, no network. Run from repo root: node tests/gh3398-idk-payment-line.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const SRC = process.env.GH3398_SRC_REF
  ? execSync(`git show ${process.env.GH3398_SRC_REF}:dashboard.html`, { encoding: 'utf8', maxBuffer: 1 << 26 })
  : readFileSync('dashboard.html', 'utf8');
let n = 0; const fails = [];
const ok = (m) => console.log('ok ' + (++n) + ' - ' + m);
function check(name, fn) { try { fn(); ok(name); } catch (e) { fails.push(name); console.log('NOT OK - ' + name + ' :: ' + String(e.message).split(String.fromCharCode(10))[0]); } }

function between(a, b) {
  const i = SRC.indexOf(a); assert.ok(i >= 0, 'marker missing: ' + a);
  const j = SRC.indexOf(b, i); assert.ok(j > i, 'marker missing: ' + b);
  return SRC.slice(i, j);
}
// Real source of the banner label lookup and of the save mapping, executed as-is.
const labelCode = between('const JOB_TYPE_LABELS = {', 'const propertyAddr');
const mapCode = between("if (selectedType === 'insurance_rcv') {", '// Conditional fields per job type');

function label(claim) {
  const ctx = { currentClaim: claim, out: undefined };
  vm.runInNewContext(labelCode + '\nout = fundingLabel;', ctx);
  return ctx.out;
}
function save(claim, selectedType, preselect) {
  const updates = {};
  const ctx = { currentClaim: claim, selectedType, updates, window: { selectedJobTypeIsPreselect: preselect } };
  vm.runInNewContext(mapCode, ctx);
  return updates;
}
const idkClaim = { job_type: 'insurance_rcv', funding_type: 'insurance', policy_type: 'idk' };
const rcvClaim = { job_type: 'insurance_rcv', funding_type: 'insurance', policy_type: 'rcv' };

// POINT 1: label
check('POINT 1: stored idk shows no "Insurance (RCV)" payment line (hidden)', () => {
  assert.ok(!/Insurance \(RCV\)/.test(String(label(idkClaim))), 'got: ' + label(idkClaim));
  assert.ok(!label(idkClaim), 'label must be falsy (line hidden)');
});
// POINT 2: saving the untouched edit form (RCV pre-selected) leaves idk alone
check('POINT 2: saving the pre-selected form for idk does not write policy_type', () => {
  const u = save(idkClaim, 'insurance_rcv', true);
  assert.notEqual(u.policy_type, 'rcv', 'save rewrote idk to rcv');
  assert.ok(!('policy_type' in u));
});
check('POINT 2: preselect sets flag after selectJobType; a click clears it', () => {
  assert.match(SRC, /window\.selectJobType\(jobType\);\s*window\.selectedJobTypeIsPreselect = true;/);
  assert.match(between('window.selectJobType = function(type) {', 'window.showJobTypeHelp'), /selectedJobTypeIsPreselect = false/);
});

let u;
// NEGATIVE CONTROLS: rcv unchanged
assert.equal(label(rcvClaim), 'Insurance (RCV)');
ok('control: stored rcv still shows the Insurance (RCV) line');
u = save(rcvClaim, 'insurance_rcv', true);
assert.equal(u.policy_type, 'rcv'); assert.equal(u.funding_type, 'insurance');
ok('control: saving a stored rcv keeps policy_type rcv');
u = save(rcvClaim, 'insurance_rcv', false);
assert.equal(u.policy_type, 'rcv');
ok('control: explicit RCV click on a non-idk claim writes rcv');
u = save(idkClaim, 'insurance_rcv', false);
assert.equal(u.policy_type, 'rcv');
ok('control: an explicit RCV click by an idk homeowner is still honored');
u = save(idkClaim, 'insurance_acv', false);
assert.equal(u.policy_type, 'acv');
ok('control: explicit ACV pick still writes acv');
assert.equal(label({ job_type: 'insurance_acv', funding_type: 'insurance', policy_type: 'acv' }), 'Insurance (ACV)');
assert.equal(label({ job_type: 'retail', funding_type: 'cash', policy_type: null }), 'Cash / Out-of-Pocket');
ok('control: ACV and cash labels unchanged');
if (fails.length) { console.log('FAIL ' + fails.length + ' of ' + (n + fails.length)); process.exit(1); }
console.log('PASS ' + n);
