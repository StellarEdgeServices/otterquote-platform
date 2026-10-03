/**
 * gh-2477 -- contract test: every static caller of the send-support-email Edge Function must
 * send a request the function's own validator (validatePayload in
 * supabase/functions/send-support-email/caller-gate.ts) accepts, to the Supabase function URL
 * (there is no Netlify proxy for /functions/v1), with the public key in `apikey`.
 *
 * The caller's JSON payload is lifted out of the page source (string/template-aware brace
 * matching), evaluated against fixture variables, and handed to the REAL validatePayload.
 * The React callers are covered by react-app/app/(homeowner)/__tests__/gh2477-support-email-contract.test.ts.
 *
 * Run: node --experimental-strip-types tests/gh2477-support-email-callers.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validatePayload } = await import(
  path.join(root, 'supabase/functions/send-support-email/caller-gate.ts')
);

let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** Index just past the bracket that closes the one at `open`; skips string/template literals. */
function matchClose(src, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) throw new Error('unbalanced at ' + i);
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error('no closing bracket');
}

/** The call region (url + headers) and the payload literal of the fetch to send-support-email. */
function extractCall(file, markerRe) {
  const src = read(file);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`${file}: no call matching ${markerRe}`);
  const stringify = src.indexOf('JSON.stringify(', m.index);
  const open = src.indexOf('{', stringify);
  const literal = src.slice(open, matchClose(src, open));
  return { head: src.slice(m.index, stringify), literal };
}

function payloadFor(literal, scope) {
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return (${literal});`)(...names.map((n) => scope[n]));
}

const URL_OK = /fetch\(\s*CONFIG\.SUPABASE_URL \+ '\/functions\/v1\/send-support-email'/;

const CALLERS = [
  {
    file: 'bids.html', re: /fetch\(CONFIG\.SUPABASE_URL \+ '\/functions\/v1\/send-support-email'|fetch\(`\$\{window\.location\.origin\}\/functions\/v1\/send-support-email`/,
    scope: { c: { company_name: 'Acme Roofing' }, currentClaim: { id: 'abcdef1234567890', property_address: '1 Main St' }, bidId: 'q-1', notifOk: true },
    inject: { c: { company_name: 'Acme\r\nBcc: evil@example.com' }, currentClaim: { id: 'abcdef1234567890', property_address: '1 Main\nSt' }, bidId: 'q-1', notifOk: true },
    apikey: true,
  },
  {
    file: 'contract-signing.html', re: /fetch\(CONFIG\.SUPABASE_URL \+ '\/functions\/v1\/send-support-email'|fetch\(`\$\{window\.location\.origin\}\/functions\/v1\/send-support-email`/,
    scope: { state: { contractor: { company_name: 'Acme Roofing' }, claim: { property_address: '1 Main St' }, claimId: 'c1' }, bidId: 'q-1', notifOk: true },
    inject: { state: { contractor: { company_name: 'Acme\nBcc: evil@example.com' }, claim: { property_address: '1 Main St' }, claimId: 'c1' }, bidId: 'q-1', notifOk: true },
    apikey: true,
  },
  {
    file: 'js/auth.js', re: /fetch\(CONFIG\.SUPABASE_URL \+ '\/functions\/v1\/send-support-email'|fetch\(`\$\{window\.location\.origin\}\/functions\/v1\/send-support-email`/,
    scope: { data: { company_name: 'Acme', email: 'pat@example.com' }, user: { email: 'pat@example.com' }, signupMessage: 'New contractor signed up.' },
    apikey: true,
  },
  {
    file: 'dashboard.html', re: /fetch\(CONFIG\.SUPABASE_URL \+ '\/functions\/v1\/send-support-email'|fetch\(`\$\{window\.location\.origin\}\/functions\/v1\/send-support-email`/,
    scope: { currentProfile: { full_name: 'Pat Owner' }, currentUser: { email: 'pat@example.com' }, currentClaim: { id: 'abcdef1234567890' }, reasonText: 'Price', notes: 'n/a' },
    apikey: true,
  },
];

for (const { file, re, scope, inject, apikey } of CALLERS) {
  const { head, literal } = extractCall(file, re);
  ok(URL_OK.test(head), `${file}: posts to CONFIG.SUPABASE_URL + '/functions/v1/send-support-email' (not the unproxied site origin)`);
  ok(!/window\.location\.origin/.test(head.split('JSON.stringify')[0]), `${file}: call region does not use window.location.origin`);
  if (apikey) ok(/'apikey':\s*CONFIG\.SUPABASE_ANON/.test(head), `${file}: sends the public key in the apikey header`);
  const payload = payloadFor(literal, scope);
  const r = validatePayload(payload);
  ok(r.ok, `${file}: payload {${Object.keys(payload).join(', ')}} accepted by validatePayload${r.ok ? '' : ' -- ' + r.error}`);
  if (inject) {
    const r2 = validatePayload(payloadFor(literal, inject));
    ok(r2.ok, `${file}: payload still accepted when user data carries a newline (subject is sanitised)${r2.ok ? '' : ' -- ' + r2.error}`);
  }
}

// The validator itself refuses a newline in subject (gh-2477 ruling).
const base = { from_name: 'A', from_email: 'a@b.co', message: 'm' };
ok(validatePayload({ ...base, subject: 'fine' }).ok, 'validatePayload accepts a single-line subject');
ok(!validatePayload({ ...base, subject: 'a\nBcc: x@y.z' }).ok, 'validatePayload refuses LF in subject');
ok(!validatePayload({ ...base, subject: 'a\rb' }).ok, 'validatePayload refuses CR in subject');

// Nothing in the browser sources may post to the unproxied /functions/v1 path on the site origin.
const scan = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (['node_modules', '.next', '.git', 'tests', 'e2e', '.claude', 'handoffs', 'supabase', 'Docs', 'docs'].includes(e.name)) return [];
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return scan(full);
  return /\.(html|js|mjs|ts|tsx)$/.test(e.name) ? [full] : [];
});
const offenders = scan(root).filter((f) => /window\.location\.origin\}?\s*\+?\s*[`'"]?\/?functions\/v1\//.test(fs.readFileSync(f, 'utf8')) ||
  fs.readFileSync(f, 'utf8').includes('${window.location.origin}/functions/v1/'));
ok(offenders.length === 0, `no browser source posts to <site origin>/functions/v1 (offenders: ${offenders.map((f) => path.relative(root, f)).join(', ') || 'none'})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
