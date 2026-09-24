/**
 * privacy.html HOLD bundle -- a diff-only guard: NO policy text changes except the reviewed DRAFT lines below.
 *
 * Ben's instruction (#2078 5811351154): "add a diff-only test so no other policy text changes." Legal copy is Tier C (Dustin's), so this bundle is a
 * HOLD draft PR whose wording is DRAFT; once Dustin rules, ONLY the text in APPROVED below needs to change, in this file and in privacy.html.
 *
 * How it works: it diffs privacy.html against origin/main (git diff -U0) and requires that the removed lines and the added lines are EXACTLY the
 * ones listed in APPROVED, and each exactly once. If privacy.html equals main (the bundle has shipped, or nothing is changed yet), it requires the
 * approved added lines to ALREADY be present, so this cannot pass vacuously before the change exists.
 *
 * Run: node tests/privacy-bundle-diff-only.mjs        (needs the base ref: origin/main, with history: actions/checkout fetch-depth: 0)
 * Base ref override for local runs: BASE_REF=some-ref node tests/privacy-bundle-diff-only.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE_REF = process.env.BASE_REF || 'origin/main';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

// ---------------------------------------------------------------------------------------------------------------------------------------------
// APPROVED (DRAFT, Tier C: Dustin's). Each entry is one line of privacy.html, with its leading indentation stripped.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const APPROVED = {
  removed: [
    // Effective Date: bumped at ship time (section 14)
    '<p><strong>Effective Date: September 14, 2026</strong></p>',
    // 4.2 Meta line
    '<li><strong>Meta (Facebook) Pixel:</strong> Advertising measurement</li>',
    // 5.4 Clarity paragraph
    '<p>We use Microsoft Clarity to understand how visitors interact with our platform, including page navigation, scrolling behavior, and click patterns. Clarity may set cookies on your device and may record a replay of your on-page interactions to help us identify usability issues and improve the platform. For more information, see Microsoft\'s Privacy Statement at <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noopener">https://privacy.microsoft.com/privacystatement</a>.</p>',
  ],
  added: [
    // Effective Date placeholder
    '<p><strong>Effective Date: [SET AT SHIP TIME]</strong></p>',
    // 2.3 new bullet (DRAFT wording: #2123 LEGAL-READ 5810656623)
    '<li><strong>Advertising Lead Forms (Meta):</strong> If you submit a lead form in one of our ads on Facebook or Instagram, Meta Platforms, Inc. collects the information you enter (such as your name, phone number, email address, property address and your answers to the form\'s questions) and provides it to us. We use it to respond to your request, including by email and by phone call, and by text message or automated call only if you checked the consent box on that form. Meta\'s handling of information on its own platforms is governed by Meta\'s privacy policy.</li>',
    // 4.2 Meta line (DRAFT wording: #2123 LEGAL-READ 5810656623)
    '<li><strong>Meta (Facebook and Instagram):</strong> Advertising measurement (Meta Pixel), and hosting the lead forms that appear in our ads (see Section 2.3)</li>',
    // 5.4 Clarity paragraph with the signed-in sentence (DRAFT wording: #1939 5810533784)
    '<p>We use Microsoft Clarity to understand how visitors interact with our platform, including page navigation, scrolling behavior, and click patterns. Clarity may set cookies on your device and may record a replay of your on-page interactions to help us identify usability issues and improve the platform. This includes pages you view while signed in to your account, such as your dashboard and your bids. On those pages we set Clarity to mask the page content and everything you type, so your personal information is not visible in any replay. For more information, see Microsoft\'s Privacy Statement at <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noopener">https://privacy.microsoft.com/privacystatement</a>.</p>',
    // 12 GPC sentence (DRAFT wording: written by Kevin at Ben's direction, #2078 5811351154; matches the #2134 behaviour)
    '<p>We treat a Global Privacy Control (GPC) signal sent by your browser as a request to opt out of the sale or sharing of your personal information for advertising purposes.</p>',
  ],
};

const current = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
const currentLines = current.split('\n').map((l) => l.replace(/^\s+/, '').replace(/\s+$/, ''));

let diff = '';
try {
  diff = execFileSync('git', ['diff', '-U0', '--no-color', BASE_REF, '--', 'privacy.html'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.log('FAIL: could not diff against ' + BASE_REF + ' (does the checkout have it? actions/checkout needs fetch-depth: 0): ' + String(e.message).split('\n')[0]);
  process.exit(1);
}
const removed = [], added = [];
for (const l of diff.split('\n')) {
  if (l.startsWith('---') || l.startsWith('+++')) continue;
  if (l.startsWith('-')) removed.push(l.slice(1).replace(/^\s+/, '').replace(/\s+$/, ''));
  else if (l.startsWith('+')) added.push(l.slice(1).replace(/^\s+/, '').replace(/\s+$/, ''));
}

const sorted = (a) => [...a].sort();
const count = (arr, x) => arr.filter((y) => y === x).length;

if (diff.trim() === '') {
  console.log('NOTE: privacy.html equals ' + BASE_REF + ': checking that the approved lines are ALREADY present (the bundle has shipped), never vacuously.');
  for (const a of APPROVED.added) ok(count(currentLines, a) === 1, 'the approved line is present exactly once: ' + a.slice(0, 70) + '...');
  for (const r of APPROVED.removed) ok(count(currentLines, r) === 0, 'the replaced line is gone: ' + r.slice(0, 70) + '...');
} else {
  ok(JSON.stringify(sorted(removed)) === JSON.stringify(sorted(APPROVED.removed)),
    'the removed lines are EXACTLY the approved set (' + removed.length + ' removed, ' + APPROVED.removed.length + ' approved)' +
    (JSON.stringify(sorted(removed)) === JSON.stringify(sorted(APPROVED.removed)) ? '' : '\n   unexpected removed: ' + JSON.stringify(removed.filter((x) => !APPROVED.removed.includes(x)).map((x) => x.slice(0, 100)))));
  ok(JSON.stringify(sorted(added)) === JSON.stringify(sorted(APPROVED.added)),
    'the added lines are EXACTLY the approved set (' + added.length + ' added, ' + APPROVED.added.length + ' approved)' +
    (JSON.stringify(sorted(added)) === JSON.stringify(sorted(APPROVED.added)) ? '' : '\n   unexpected added: ' + JSON.stringify(added.filter((x) => !APPROVED.added.includes(x)).map((x) => x.slice(0, 100)))));
  for (const a of APPROVED.added) ok(count(currentLines, a) === 1, 'present exactly once in privacy.html: ' + a.slice(0, 70) + '...');
}

// Sanity on the placeholder: while it is present the page is a DRAFT and must not ship
const hasPlaceholder = current.includes('[SET AT SHIP TIME]');
console.log('INFO: effective-date placeholder ' + (hasPlaceholder ? 'PRESENT: this is a HOLD draft, NOT shippable until it is replaced with the ship date' : 'absent'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
