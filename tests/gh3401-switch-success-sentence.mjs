/**
 * gh-3401 / gh-3119 -- the contractor-switch success screen in dashboard.html must not carry
 * the sentence "You do not need to contact them directly." (Dustin, #3119 comment 6664033353:
 * "Remove it (Recommended)"). The rest of the screen stays as approved.
 * Static test, no network.   Run: node tests/gh3401-switch-success-sentence.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const src = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const a = src.indexOf('id="switch-success-step"');
const panelEnd = src.indexOf('Close\n', a);
ok(a > -1, 'dashboard.html: switch success step found');
const step = src.slice(a, panelEnd > a ? panelEnd : a + 2000);
ok(!/need to contact them directly/i.test(step), 'switch success screen: "You do not need to contact them directly." absent');
ok(!/need to contact them directly/i.test(src), 'dashboard.html: sentence absent anywhere');
ok(step.includes("We've got you."), 'switch success screen: heading kept');
ok(step.includes('An Otter Quotes team member will reach out shortly to get you matched with a new contractor from our network.'), 'switch success screen: first paragraph kept');
ok(step.includes("We've received your request. An Otter Quotes team member will contact you shortly to confirm the switch and get you matched with a new contractor."), 'switch success screen: second paragraph kept up to the removed sentence');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
