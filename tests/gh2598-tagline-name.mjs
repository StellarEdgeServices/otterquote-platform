/**
 * gh-2598 slice 7 -- tagline Title Case (D-377) and name clean-up (D-378, value-proposition § 4 rule 6).
 *
 * Spec: Marketing/site-reskin-2026-10/README.md, "Tagline (D-377)" and "Name clean-up"; issue #2598 planned sub-issues 4 and 5.
 *   T1  no served page, script or edge-function source carries the tagline in any casing other than "Contractors Compete. Homeowners Win."
 *   T2  landing.html no longer carries the old tagline "Your Project. Your Terms."; its h1 is the D-377 tagline
 *   T3  the five hc*.html meta descriptions read "Contractors Compete. Homeowners Win." exactly
 *   T4  the ho6 next-step email body (send-lead-next-step-reminder/email-content.ts) carries the Title Case line
 *   T5  contractor-profile.html ships no hard-coded personal defaults (owner name, business, phone, email, website)
 * Every check has a NEGATIVE CONTROL: the pre-fix string put back in memory must turn it red.
 * TAGLINE_ROOT=<dir> points the test at another checkout (e.g. main, which must fail).
 * Run: node tests/gh2598-tagline-name.mjs   Exit 0 = all green including every control going red.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.TAGLINE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'Contractors Compete. Homeowners Win.';
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'tests', 'react-app', 'supabase/migrations', 'supabase/migrations_drafts'].includes(rel) || e.name === 'node_modules' || e.name === '.git') continue;
      walk(rel, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x)) && !/\.test\.ts$/.test(e.name)) out.push(rel);
  }
  return out;
}
const FILES = [...walk('.', ['.html']).filter((f) => !f.startsWith('supabase')), ...walk('js', ['.js']), ...walk('supabase/functions', ['.ts'])];

/* T1 */
const badCase = (txt) => (txt.match(/contractors\s+compete\.?\s+homeowners\s+win\.?/gi) || []).filter((m) => m.replace(/\s+/g, ' ') !== TAG);
const t1 = (src) => Object.entries(src).filter(([, t]) => badCase(t).length).map(([f]) => f);
const all = Object.fromEntries(FILES.map((f) => [f, read(f)]));
const off = t1(all);
ok(FILES.length > 100 && off.length === 0, `T1 ${FILES.length} served/source files scanned; tagline only in Title Case${off.length ? ' -- offenders: ' + off.join(', ') : ''}`);
ok(t1({ 'x.html': '<meta name="description" content="Contractors compete. Homeowners win.">' }).length === 1, 'T1 NEGATIVE CONTROL: sentence-case tagline is caught');

/* T2 */
const t2 = (h) => !h.includes('Your Project. Your Terms.') && /<h1>\s*Contractors Compete\. Homeowners Win\.\s*<\/h1>/.test(h);
const landing = read('landing.html');
ok(t2(landing), 'T2 landing.html h1 is the D-377 tagline; old "Your Project. Your Terms." gone');
ok(!t2(landing.replace(/<h1>\s*Contractors Compete\. Homeowners Win\.\s*<\/h1>/, '<h1>Your Project. Your Terms.</h1>')), 'T2 NEGATIVE CONTROL: old h1 put back goes red');

/* T3 */
const HC = ['hc.html', 'hc-warranties.html', 'hc-save-money.html', 'hc-materials.html', 'hc-decisions.html'];
const t3 = (h) => /<meta name="description" content="Contractors Compete\. Homeowners Win\.">/.test(h);
ok(HC.every((f) => t3(read(f))), 'T3 five hc*.html meta descriptions are the Title Case tagline');
ok(!t3(read('hc.html').replace('Contractors Compete. Homeowners Win.', 'Contractors compete. Homeowners win.')), 'T3 NEGATIVE CONTROL: sentence case goes red');

/* T4 */
const EMAIL = 'supabase/functions/send-lead-next-step-reminder/email-content.ts';
const t4 = (s) => s.includes('\nContractors Compete. Homeowners Win.\n') && !/Contractors compete\. Homeowners win\./.test(s);
ok(t4(read(EMAIL)), 'T4 ho6 email body carries the Title Case tagline line');
ok(!t4(read(EMAIL).replace('Contractors Compete. Homeowners Win.', 'Contractors compete. Homeowners win.')), 'T4 NEGATIVE CONTROL: sentence case goes red');

/* T5 */
const PERSONAL = /Dustin|Stohler|530-3054|stohlerroof/i;
const t5 = (h) => !PERSONAL.test(h) && /id="viewOwnerName">—</.test(h) && /id="editOwnerName" class="form-input" value="">/.test(h);
const cp = read('contractor-profile.html');
ok(t5(cp), 'T5 contractor-profile.html: no hard-coded personal defaults; owner name view "—", edit value empty (matches the JS fallbacks)');
ok(!t5(cp.replace('id="viewOwnerName">—<', 'id="viewOwnerName">Dustin Stohler<')), 'T5 NEGATIVE CONTROL: the old owner-name default goes red');
ok(!t5(cp.replace('id="editEmail" class="form-input" value=""', 'id="editEmail" class="form-input" value="Dustin@StohlerRoof.com"')), 'T5 NEGATIVE CONTROL: the old email default goes red');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
