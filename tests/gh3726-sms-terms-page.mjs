/**
 * gh-3726 item 6 -- /sms-terms must exist and carry the approved wording verbatim.
 * Approved wording: wording pack piece 2 (#2875 comment 6388102468), approved by Dustin on #3065
 * ("Approve all 3.", comment 6474710713) with "Otter Quotes" (D-175) in place of "OtterQuote".
 * Run: node tests/gh3726-sms-terms-page.mjs     GH3726_ROOT points at another tree (negative control).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.GH3726_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }
const file = path.join(ROOT, 'sms-terms.html');
const exists = fs.existsSync(file);
ok(exists, 'sms-terms.html exists (Netlify serves it at /sms-terms)');
const html = exists ? fs.readFileSync(file, 'utf8') : '';
const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(p|h1|section)>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const APPROVED = [
  'Otter Quotes Text Messages',
  'Program. Otter Quotes Contractor Alerts, sent by Stellar Edge Services LLC, doing business as Otter Quotes.',
  'Who gets texts and why. Contractors who add a mobile number to their account, tick the consent box, and confirm the number with a one-time code. We text about your contractor account, new job opportunities, bids, contracts, and payments. Texts are optional; if you decline, we use email.',
  'How often. Message frequency varies with your job activity.',
  'Cost. Msg & data rates may apply.',
  'Stop. Reply STOP (or END, CANCEL, QUIT, UNSUBSCRIBE, REVOKE, or OPT OUT) to any text, or tell us by email or phone. We send one confirmation text and stop texting that number. To start again, reply START, then re-verify the number in your account Settings.',
  'Help. Reply HELP, call (844) 875-3412, or email support@otterquote.com.',
  'Carriers. Carriers are not liable for delayed or undelivered messages.',
  'Privacy. We handle your mobile number and consent information under our Privacy Policy.',
  'Texts to homeowners. Homeowners who choose to receive texts from Otter Quotes get project status, bid, and verification-code messages. The same STOP and HELP words work. Homeowners can use email instead.',
];
for (const s of APPROVED) ok(text.includes(s), 'approved sentence present verbatim: ' + s.slice(0, 48));
ok(!/OtterQuote(?!\.)/.test(text.replace(/otterquote\.com/gi, '')), 'brand is "Otter Quotes" (D-175), never "OtterQuote"');
ok(!/marketing texts/i.test(text), 'the removed "no marketing texts" sentence is absent (conflicts with the registered job-alert content)');
ok(/<a href="privacy\.html">Privacy Policy<\/a>/.test(html), 'Privacy Policy link points at privacy.html');
ok(/<link rel="canonical" href="https:\/\/otterquote\.com\/sms-terms">/.test(html), 'canonical is https://otterquote.com/sms-terms (the URL the disclosure links)');
ok(/<meta name="robots" content="noindex, follow">/.test(html), 'noindex (keeps check-sitemap.py satisfied without a sitemap entry)');
ok(!/ on[a-z]+\s*=/i.test(html) && !/href="javascript:/i.test(html), 'no inline handlers, no javascript: links');
ok(!/<form|<input|<button/i.test(html), 'static page: no form, input or button');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
