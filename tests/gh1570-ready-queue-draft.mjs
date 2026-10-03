/**
 * gh-1570 (CEO ruling 5965042243) -- the admin "Ready, not submitted" tab
 * covers {documents_needed, draft}. readyQueueRows() is inline in
 * admin-homeowners.html, so this extracts the real function from the page and
 * runs it in vm (the gh1925 idiom) rather than testing a copy.
 *
 * Run: node tests/gh1570-ready-queue-draft.mjs
 * GH1570_ROOT points at another tree for negative controls.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH1570_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'admin-homeowners.html'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const start = html.indexOf('function readyQueueRows(rows)');
ok(start !== -1, 'admin-homeowners.html defines readyQueueRows()');
// the function body ends at the first "\n}\n" after its start
const end = html.indexOf('\n}\n', start);
const src = html.slice(start, end + 3);
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const q = (rows) => ctx.readyQueueRows(rows).map((r) => r.id);

const row = (id, status, complete = true, at = '2026-09-09T10:00:00Z') =>
  ({ id, status, checklist_complete: complete, checklist_complete_at: complete ? at : null });

ok(JSON.stringify(q([row('dn', 'documents_needed')])) === '["dn"]', 'documents_needed + checklist_complete is in the queue');
ok(JSON.stringify(q([row('dr', 'draft')])) === '["dr"]', 'draft + checklist_complete is in the queue');
ok(q([row('dr', 'draft', false)]).length === 0, 'draft with an incomplete checklist is NOT in the queue');
for (const s of ['submitted', 'active', 'waitlisted', 'bidding', 'contract_signed', 'awarded']) {
  ok(q([row('x', s)]).length === 0, s + ' is NOT in the queue (negative control)');
}
ok(
  JSON.stringify(q([row('late', 'draft', true, '2026-09-20T00:00:00Z'), row('early', 'documents_needed', true, '2026-09-01T00:00:00Z')])) === '["early","late"]',
  'queue sorts oldest checklist_complete_at first across both statuses',
);

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
