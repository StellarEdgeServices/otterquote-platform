// gh-3742: no false "3D design tool" claims on the FAQ or the contractor bid form.
// Run: node tests/gh3742-no-3d-design-claim.mjs   (exits non-zero on failure)
// Negative control: GH3742_DIR=<dir holding main's faq.html + contractor-bid-form.html> runs it against other copies.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = process.env.GH3742_DIR ? process.env.GH3742_DIR + '/' : new URL('../', import.meta.url).pathname;
const faq = fs.readFileSync(base + 'faq.html', 'utf8');
const form = fs.readFileSync(base + 'contractor-bid-form.html', 'utf8');

assert.ok(!/3D design/i.test(faq), 'faq.html has no "3D design" claim');

// JSON-LD answer and visible answer for the color-selection question must stay identical.
const needle = "you don't need to choose a color before signing";
const ld = [...faq.matchAll(/"text":\s*"([^"\n]*)"/g)].map((m) => m[1]).filter((t) => t.includes(needle));
const vis = [...faq.matchAll(/<p>([^<\n]*)<\/p>/g)].map((m) => m[1].replace(/&mdash;/g, '—')).filter((t) => t.includes(needle));
assert.equal(ld.length, 1, 'one JSON-LD answer');
assert.equal(vis.length, 1, 'one visible answer');
assert.equal(ld[0], vis[0], 'JSON-LD answer equals visible answer');
assert.ok(ld[0].endsWith("Either way, we'll prompt you at the right moment."), 'answer ends at "the right moment."');

assert.ok(!/id="loadHoverSidingDataBtn"/.test(form), 'form has no loadHoverSidingDataBtn element');
assert.ok(!/Load Design Data/.test(form), 'form has no "Load Design Data" text');
assert.ok(!/designs their siding in our property design tool/.test(form), 'form has no false design-tool sentence');
// The retained function must stay null-safe now that the button is gone.
assert.ok(/function loadHoverSidingData\(/.test(form), 'loadHoverSidingData() retained');
assert.ok(/if \(!currentClaim \|\| !btn \|\| !content\) return;/.test(form), 'loadHoverSidingData() null-guards the missing button');
console.log('gh3742: all assertions passed');
