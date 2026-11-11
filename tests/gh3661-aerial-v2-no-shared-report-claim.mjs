// gh-3661 Aerial v2 (Ben 6806759341 item 4): blog/aerial-roof-measurement-reports.html must not claim shared
// measurements / same roof / equal footing (D-370, D-388), and must carry the passed v2 AFTER texts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'blog/aerial-roof-measurement-reports.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL: ' + m); } };
const text = html.replace(/<script[\s\S]*?<\/script>/g, '');
for (const re of [/shared set of measurements/i, /equal footing/i, /describe the same roof/i, /Shared measurements/i, /a shared report/i, /Compare Bids on the Same Roof/i, /Comparable Numbers/i, /not disagreement about how big/i]) {
  ok(!re.test(text), 'retired phrase absent: ' + re);
}
for (const s of [
  'The result is a consistent measurement of your roof. On Otter Quotes, contractors also bid on the same scope of work, so you can compare their bids side by side.',
  'a report built from imagery gives a consistent measurement of your roof, with no tape measure involved. Contractors use professional measurements like these to bid.',
  '<h3>Comparable Bids, Competing Contractors</h3>',
  'Bids are easiest to compare when contractors compete from the same scope of work. On Otter Quotes, contractors bid on the same scope of work for your project, so you can compare their bids side by side.',
  'because bids on the same scope of work answer the "are they even quoting the same thing?" question.',
  'built from imagery rather than from one person\'s tape measure.</p></div>',
  '<h3>Compare Bids on the Same Scope of Work</h3>',
  '"dateModified": "2026-11-11"',
]) ok(html.includes(s), 'v2 text present: ' + s.slice(0, 60));
ok(html.includes('Two roofers measuring the same roof can land on different totals'), 'line 106 untouched');
ok(!/every contractor uses/i.test(text), 'D-388 retired phrase absent');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
