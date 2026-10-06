/**
 * gh-1509 / D-319 (CTO ruling A: option (a), comment 5973838853) -- the referral-bonus pages no longer promise a W-9
 * or a 1099 form. Sentence-level removal only: the "taxable income / you are responsible for all taxes / Otter Quotes
 * does not withhold / consult a tax professional" language STAYS (D-319 retires the W-9 gate and the 1099 promise, not
 * the statement that taxes are the partner's own).
 *
 * Checks, on the served pages recruit.html and refer-a-friend.html and the React /refer copy (copy.ts, page.tsx, utils.ts):
 *   1. ABSENT: no "1099", no "W-9" / "W9", no "$600 ... per calendar year" filing threshold, no "January 31".
 *   2. PRESENT: the kept tax-responsibility sentences are still on refer-a-friend.html and in TAX_NOTICE.
 *   3. The FAQ item "Will I receive a tax form for my referral bonuses?" is gone from both stacks.
 * Negative control: run with ROOT=<a checkout of main before this change> and every ABSENT check fails.
 *   ROOT=/path/to/older/checkout node tests/gh1509-w9-1099-copy-absent.mjs   (expected exit 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(here, '..');
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS: ' + name); } else { fail++; console.log('FAIL: ' + name); }
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
// Strip HTML comments and JS/TS comments (a retained developer comment is not served copy) and the disclosure-version
// identifier '1099-misc-v1-2026-04' (a record key, not text a visitor reads; this change does not rename it).
const stripComments = (s) => s.replace(/1099-misc-v1-2026-04/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FORBIDDEN = [
  [/1099/i, 'a 1099 form'],
  [/\bW-?9\b/i, 'a W-9'],
  [/\$600/, 'the $600 filing threshold'],
  [/January 31/i, 'the January 31 delivery date'],
  [/tax form for my referral bonuses/i, 'the tax-form FAQ question'],
];

const SERVED = [
  'recruit.html',
  'refer-a-friend.html',
  'react-app/app/refer/copy.ts',
  'react-app/app/refer/page.tsx',
  'react-app/app/refer/utils.ts',
];
for (const f of SERVED) {
  const body = stripComments(read(f));
  for (const [re, label] of FORBIDDEN) check(`${f}: carries no mention of ${label}`, !re.test(body));
}

const kept = [
  'Your $200 referral bonus is taxable income.',
  'You are responsible for all applicable federal, state, and local taxes on referral income.',
  'Otter Quotes does not withhold taxes from bonus payments.',
  'We recommend consulting a qualified tax professional if you have questions about your tax obligations.',
];
const html = read('refer-a-friend.html');
const copy = read('react-app/app/refer/copy.ts');
for (const k of kept) {
  check(`refer-a-friend.html still says: ${k}`, html.includes(k));
  check(`react-app refer/copy.ts TAX_NOTICE still says: ${k}`, copy.includes(k));
}
check('refer-a-friend.html: the Tax Reporting Notice block still renders', html.includes('Tax Reporting Notice'));
check('react-app refer/copy.ts: TAX_NOTICE label kept', copy.includes("label: 'Tax Reporting Notice'"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
