/**
 * Regression test for gh-3577 / D-312: no vendor is named on the public site.
 * repair-intake.html printed the material-test lab vendor's name (ITEL) in the
 * Tier 4 accordion, the sample mailing block, the request button and a JS string.
 *
 * Asserts (1) repair-intake.html and the scripts it loads contain no vendor
 * name, and (2) the offer and price wording is unchanged.
 *
 * Run: node tests/gh3577-repair-intake-no-vendor-name.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'repair-intake.html'), 'utf8');

const files = { 'repair-intake.html': html };
for (const m of html.matchAll(/<script[^>]+src="(?!https?:)([^"?#]+)/g)) {
  const rel = m[1].replace(/^\//, '');
  const p = path.join(root, rel);
  if (fs.existsSync(p)) files[rel] = fs.readFileSync(p, 'utf8');
}

let fail = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fail = 1; };

for (const [name, src] of Object.entries(files)) {
  const hits = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\bITEL\b/i.test(l));
  check(hits.length === 0, `${name}: no vendor name (ITEL)` + hits.map(([n, l]) => `\n     L${n}: ${l.trim().slice(0, 120)}`).join(''));
}
check(/<p style="font-size: 0.9rem; margin-top: 0.5rem;">\s*Attn: Sample Receiving<br>\s*7 Westport Court<br>/.test(html),
  'mail-in recipient line is exactly "Attn: Sample Receiving", followed by the unchanged street address');
check(html.includes('<strong>\u{1F4B0} Starting at $75</strong> \u2014 refunded if you use an Otter Quotes contractor'),
  'offer wording "Starting at $75 \u2014 refunded if you use an Otter Quotes contractor" unchanged');
check(html.includes('<span class="tier-price">$75-100</span>'), 'tier price $75-100 unchanged');
process.exit(fail);
