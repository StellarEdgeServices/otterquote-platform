/**
 * gh-2559 / D-368 -- a bidding contractor is offered no raw homeowner upload: the Loss Sheet and
 * View Measurements buttons (and the signed-URL openers behind them) are gated to the contractor the
 * homeowner SELECTED, on the static bid form and the static opportunities page.
 *
 * The real helpers are extracted from the pages and run in vm (the gh1570 / gh1796 idiom), not copied.
 * The opportunities page maps claims inline, so its two filename mappings are checked as source.
 *
 * It also pins the contractor-facing copy that goes with it: the three public sentences and the two
 * opportunity-card badges say a bidder sees a SUMMARY of the estimate (D-368), never the estimate file.
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

// --- public copy and card badges (CEO ruling 6029315131 condition 2): no page tells a bidder the
// estimate file itself is on offer before selection. Read as source; the three sentences are static HTML.
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const hiw = read('contractor-how-it-works.html');
const faq = read('contractor-faq.html');
const reactCard = read('react-app/app/contractor/opportunities/page.tsx');
ok(!/aerial measurements, and the homeowner's insurance estimate &mdash; when available/.test(hiw)
  && /aerial measurements, and a line-item summary of the homeowner's insurance estimate &mdash; when available/.test(hiw),
  'how-it-works: an opportunity shows a line-item summary of the estimate, not the estimate');
ok(!/including the insurance estimate and measurements, when available/.test(faq)
  && /including aerial measurements and a line-item summary of the insurance estimate, when available &mdash; before deciding to bid/.test(faq),
  'FAQ (reviewing before bidding): a line-item summary of the estimate, not the estimate');
ok(!/the homeowner's insurance estimate with an AI-parsed line-item summary, when available\. You know/.test(faq)
  && /an AI-parsed line-item summary of the homeowner's insurance estimate, when available\. You know/.test(faq),
  'FAQ (what you can see before bidding): the summary of the estimate, not the estimate with a summary');
ok(!/Insurance Estimate &#x2713;/.test(opps) && /o\.contractorScopeSummary \? '<span class="badge badge-available">Estimate Summary &#x2713;<\/span>'/.test(opps),
  'opportunities card: the estimate badge says Estimate Summary and shows only when the card has a summary');
ok(!/>Measurements &#x2713;</.test(opps) && />Measurements on File &#x2713;</.test(opps),
  'opportunities card: the measurements badge says a measurement is on file, not that it can be opened');
ok(!/Insurance Estimate \u2713/.test(reactCard) && /opp\.contractorScopeSummary && <span className="oqo-badge oqo-badge-available">Estimate Summary \u2713<\/span>/.test(reactCard),
  'React opportunities card: Estimate Summary badge keyed on the summary');
ok(!/>Measurements \u2713</.test(reactCard) && />Measurements on File \u2713</.test(reactCard),
  'React opportunities card: Measurements on File badge');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
