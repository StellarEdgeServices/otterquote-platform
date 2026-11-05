// gh-3484 (P14, D-407): in edit mode a homeowner stored as insurance_rcv + idk must see NO payment option highlighted,
// and saving without picking a route must keep idk. Real dashboard.html markup, CSS and handler code run in Chromium.
// Run from repo root: node tests/gh3484-idk-edit-highlight.mjs
// GH3484_SRC_REF=<ref> tests that ref's dashboard.html (to show the failure on old code); GH3484_RENDER_DIR=<dir> writes PNGs.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SRC = process.env.GH3484_SRC_REF
  ? execSync(`git show ${process.env.GH3484_SRC_REF}:dashboard.html`, { encoding: 'utf8', maxBuffer: 1 << 26 })
  : readFileSync('dashboard.html', 'utf8');
const between = (a, b, from = 0) => {
  const i = SRC.indexOf(a, from); assert.ok(i >= 0, 'marker missing: ' + a);
  const j = SRC.indexOf(b, i); assert.ok(j > i, 'marker missing: ' + b);
  return SRC.slice(i, j);
};
const css = between('<style>', '</style>').slice(7);
const section = between('<div id="job-type-section"', '<div id="claim-form-actions"');
const preselect = between('// Pre-select job type button', '// Pre-populate urgency');
const selectFn = between('window.selectJobType = function(type) {', 'window.showJobTypeHelp');
const saveMap = between('const selectedType = window.selectedJobType', '// Conditional fields per job type');

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${resolve('css/design-system.css')}"><style>${css}</style></head>
<body style="padding:24px;max-width:640px">${section}</div>
<script>
${selectFn}
window.openEdit = function(currentClaim) {
  window.currentClaim = currentClaim;
  document.getElementById('job-type-section').style.display = 'block';
  ${preselect}
};
window.runSave = function(currentClaim) {
  const updates = {};
  ${saveMap}
  }
  return updates;
};
</script></body></html>`;

let n = 0; const fails = [];
const ok = (m) => console.log('ok ' + (++n) + ' - ' + m);
async function check(name, fn) { try { await fn(); ok(name); } catch (e) { fails.push(name); console.log('NOT OK - ' + name + ' :: ' + String(e.message).split('\n')[0]); } }

const idkClaim = { job_type: 'insurance_rcv', funding_type: 'insurance', policy_type: 'idk' };
const rcvClaim = { job_type: 'insurance_rcv', funding_type: 'insurance', policy_type: 'rcv' };
const idkLegacy = { funding_type: 'insurance', policy_type: 'idk' }; // no job_type: fallback path also lands on insurance_rcv

const browser = await chromium.launch();
const renderDir = process.env.GH3484_RENDER_DIR;
if (renderDir) mkdirSync(renderDir, { recursive: true });
async function open(claim, shot) {
  const p = await browser.newPage({ viewport: { width: 720, height: 520 } });
  writeFileSync('/tmp/gh3484-harness.html', page);
  await p.goto('file:///tmp/gh3484-harness.html');
  await p.evaluate((c) => window.openEdit(c), claim);
  if (renderDir && shot) await p.screenshot({ path: renderDir + '/' + shot });
  return p;
}
const selected = (p) => p.evaluate(() => [...document.querySelectorAll('.job-type-btn.selected')].map(b => b.dataset.type));

await check('gh-3484: edit mode for stored insurance_rcv + idk highlights no route option', async () => {
  const p = await open(idkClaim, 'idk-edit-mode.png');
  assert.deepEqual(await selected(p), [], 'highlighted: ' + JSON.stringify(await selected(p)));
});
await check('gh-3484: idk with no job_type (legacy fallback) highlights nothing', async () => {
  const p = await open(idkLegacy);
  assert.deepEqual(await selected(p), []);
});
await check('gh-3484: saving the untouched idk form keeps idk (no job_type, policy_type or funding_type written)', async () => {
  const p = await open(idkClaim);
  const u = await p.evaluate((c) => window.runSave(c), idkClaim);
  assert.deepEqual(u, {}, 'save wrote ' + JSON.stringify(u));
});
await check('gh-3484: an explicit RCV click by the idk homeowner highlights RCV and writes rcv', async () => {
  const p = await open(idkClaim);
  await p.click('.job-type-btn[data-type="insurance_rcv"]');
  assert.deepEqual(await selected(p), ['insurance_rcv']);
  const u = await p.evaluate((c) => window.runSave(c), idkClaim);
  assert.equal(u.policy_type, 'rcv'); assert.equal(u.funding_type, 'insurance');
});
await check('gh-3484: an explicit ACV click by the idk homeowner highlights ACV and writes acv', async () => {
  const p = await open(idkClaim);
  await p.click('.job-type-btn[data-type="insurance_acv"]');
  assert.deepEqual(await selected(p), ['insurance_acv']);
  assert.equal((await p.evaluate((c) => window.runSave(c), idkClaim)).policy_type, 'acv');
});
// NEGATIVE CONTROLS: a real RCV answer still shows RCV chosen
await check('control: stored rcv still highlights RCV in edit mode', async () => {
  const p = await open(rcvClaim, 'rcv-edit-mode.png');
  assert.deepEqual(await selected(p), ['insurance_rcv']);
});
await check('control: stored rcv saves rcv', async () => {
  const p = await open(rcvClaim);
  const u = await p.evaluate((c) => window.runSave(c), rcvClaim);
  assert.equal(u.policy_type, 'rcv'); assert.equal(u.job_type, 'insurance_rcv');
});
await check('control: stored idk on the repair path still highlights Repair Only (an explicit job scope)', async () => {
  const p = await open({ job_type: 'repair', funding_type: 'insurance', policy_type: 'idk' });
  assert.deepEqual(await selected(p), ['repair']);
});
await check('control: stored acv still highlights ACV', async () => {
  const p = await open({ job_type: 'insurance_acv', funding_type: 'insurance', policy_type: 'acv' });
  assert.deepEqual(await selected(p), ['insurance_acv']);
});
await browser.close();
if (fails.length) { console.log('FAIL ' + fails.length + ' of ' + (n + fails.length)); process.exit(1); }
console.log('PASS ' + n);
