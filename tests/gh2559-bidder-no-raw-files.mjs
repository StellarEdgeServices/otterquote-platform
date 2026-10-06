/**
 * gh-2559 / D-368 -- a bidding contractor is offered no raw homeowner upload: the Loss Sheet and
 * View Measurements buttons (and the signed-URL openers behind them) are gated to the contractor the
 * homeowner SELECTED, on the static bid form and the static opportunities page.
 *
 * The real helpers are extracted from the pages and run in vm (the gh1570 / gh1796 idiom), not copied.
 * The opportunities page maps claims inline, so its two filename mappings are checked as source.
 *
 * Run: node tests/gh2559-bidder-no-raw-files.mjs
 * GH2559_ROOT points at another tree for a negative control (e.g. a checkout of main: expect failures).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2559_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const form = fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8');
const opps = fs.readFileSync(path.join(ROOT, 'contractor-opportunities.html'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

function extract(src, header) {
  const start = src.indexOf(header);
  if (start === -1) return '';
  const end = src.indexOf('\n    }\n', start);
  return src.slice(start, end + 7);
}

const sentinelSrc = extract(form, 'function isHoverMeasurementsSentinel(');
const renderSrc = extract(form, 'function renderBidFormDocLinks(');
const estSrc = extract(form, 'function canOpenRawEstimate(');
const measSrc = extract(form, 'function canOpenRawMeasurements(');
ok(!!sentinelSrc && !!renderSrc && !!estSrc, 'bid form defines the sentinel check, renderBidFormDocLinks() and canOpenRawEstimate()');
ok(!!measSrc, 'bid form defines canOpenRawMeasurements()');

function render(claim, contractor) {
  const el = { innerHTML: '' };
  const ctx = vm.createContext({
    currentClaim: claim, currentContractor: contractor,
    CONFIG: { DEMO_MODE: false },
    document: { getElementById: () => el },
  });
  vm.runInContext([sentinelSrc, estSrc, measSrc, renderSrc, 'renderBidFormDocLinks();'].join('\n'), ctx);
  return el.innerHTML;
}

const claim = {
  id: 'CLAIM-A',
  estimate_filename: 'uid/CLAIM-A/1-estimate.pdf',
  measurements_filename: 'uid/CLAIM-A/2-measurements.pdf',
  selected_contractor_id: 'K-SEL',
};
const bidder = { id: 'K-BID' };
const selected = { id: 'K-SEL' };

const asBidder = render(claim, bidder);
ok(!/View Loss Sheet/.test(asBidder), 'bidder: no Loss Sheet button');
ok(!/View Measurements</.test(asBidder), 'bidder: no View Measurements button (the slot can hold a copy of the estimate)');
ok(/View Measurement PDF/.test(asBidder), 'bidder: still offered the platform Measurement PDF button');
const noSelection = render({ ...claim, selected_contractor_id: null }, bidder);
ok(!/View Loss Sheet/.test(noSelection) && !/View Measurements</.test(noSelection), 'bidder, nobody selected: neither raw-file button');
const beforeContractorLoads = render(claim, null);
ok(!/View Loss Sheet/.test(beforeContractorLoads) && !/View Measurements</.test(beforeContractorLoads), 'contractor not loaded yet: neither raw-file button');
const asSelected = render(claim, selected);
ok(/View Loss Sheet/.test(asSelected) && /View Measurements</.test(asSelected), 'selected contractor: both raw-file buttons');

const openers = ['openBidFormEstimatePdf', 'openBidFormMeasurementsPdf'];
for (const fn of openers) {
  const i = form.indexOf('async function ' + fn + '(');
  const body = i === -1 ? '' : form.slice(i, form.indexOf('\n    }\n', i));
  ok(/canOpenRaw(Estimate|Measurements)\(\)\) return;/.test(body), fn + '() returns before any signed-URL request unless the gate passes');
}

ok(/estimateFilename: \(claim\.estimate_filename && currentContractor && currentContractor\.id\s*&& claim\.selected_contractor_id === currentContractor\.id\)/.test(opps),
  'opportunities page: estimate path only for the selected contractor');
ok(/measurementsFilename: \(claim\.measurements_filename && !isHoverMeasurementsSentinel\(claim\.measurements_filename\)\s*&& currentContractor && currentContractor\.id\s*&& claim\.selected_contractor_id === currentContractor\.id\)/.test(opps),
  'opportunities page: measurements path only for the selected contractor');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
