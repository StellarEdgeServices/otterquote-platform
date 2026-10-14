/**
 * gh-2559 -- contractor pages state the real document access window (Ben, 6029315131: the selected
 * contractor can open the homeowner's documents once selected, before either party signs).
 * Run: node tests/gh2559-contractor-access-window-copy.mjs   (GH2559_ROOT = another tree for a negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.GH2559_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let failed = 0;
function ok(c, m) { console.log((c ? 'PASS: ' : 'FAIL: ') + m); if (!c) failed++; }
const how = rd('contractor-how-it-works.html'), faq = rd('contractor-faq.html');
ok(how.includes("As soon as the homeowner selects you, you can open the homeowner's uploaded documents, including the loss sheet"), 'how-it-works says documents open at selection');
ok(!/Once both parties have signed, you receive the completed contract, the loss sheet/.test(how), 'how-it-works no longer puts the loss sheet after both signatures');
ok(faq.includes("As soon as the homeowner selects you, you can open the homeowner's uploaded documents, including the insurance estimate"), 'FAQ says documents open at selection');
ok(!/Once both parties have signed, you receive the full project package/.test(faq), 'FAQ no longer puts the estimate after both signatures');
process.exit(failed ? 1 : 0);
