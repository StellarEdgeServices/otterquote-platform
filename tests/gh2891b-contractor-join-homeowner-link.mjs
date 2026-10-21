// gh-2891 (P04/#2745): contractor-join.html homeowner cross-link must not claim "free".
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../contractor-join.html', import.meta.url), 'utf8');
const spec = readFileSync(new URL('./e2e/flows/contractor-journey.spec.ts', import.meta.url), 'utf8');
const fails = [];
if (!html.includes('>Get quotes as a homeowner</a>')) fails.push('html: approved link text missing');
if (/free quotes as a homeowner/i.test(html)) fails.push('html: old "free quotes" claim present');
if (!/get quotes as a homeowner/i.test(spec)) fails.push('spec: assertion not updated');
if (/get free quotes as a homeowner/i.test(spec)) fails.push('spec: old assertion present');
if (fails.length) { console.error('FAIL\n' + fails.join('\n')); process.exit(1); }
console.log('PASS gh2891b contractor-join homeowner link');
