/**
 * gh-1916 / D-383 (PR #2791, REVIEW 6171829370 blocking 1): the contractor signup insert in js/auth.js
 * must carry NO `sms_consent_phone` key at all unless the contractor ticked the SMS box, so a signup
 * cannot fail (PostgREST rejects an unknown column even when null) if the page is published before the
 * migration adds the column. Evaluates the real `.insert({...})` object literal from the source.
 * Run: node tests/gh1916-auth-insert-consent-phone-key.mjs   (exit 0 = pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source text of the contractors insert object literal. */
export function insertLiteral(src) {
  const from = src.indexOf(".from('contractors')");
  assert.ok(from > 0, "no .from('contractors') in source");
  const start = src.indexOf('.insert({', from);
  assert.ok(start > 0, 'no .insert({ after .from(contractors)');
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}

/** Evaluate the literal with the given signup `data`; any other free identifier resolves to undefined. */
export function payload(src, data) {
  const lit = insertLiteral(src);
  const scope = new Proxy({ data, user: { id: 'u1' }, attestation: {} }, {
    has: (t, k) => typeof k === 'string' && !(k in globalThis),
    get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]),
  });
  return vm.runInNewContext(`with (scope) { (${lit}) }`, { scope, Date });
}

const base = { contact_name: 'A B', phone: '3175550100' };
const unticked = [{ ...base }, { ...base, sms_opt_in: undefined }, { ...base, sms_opt_in: false }, { ...base, sms_opt_in: 'true' }];

export function violations(src) {
  const v = [];
  for (const d of unticked) {
    const p = payload(src, d);
    if ('sms_consent_phone' in p) v.push(`key sms_consent_phone present when unticked (sms_opt_in=${JSON.stringify(d.sms_opt_in)})`);
  }
  const t = payload(src, { ...base, sms_opt_in: true });
  if (t.sms_consent_phone !== '3175550100') v.push(`ticked: sms_consent_phone=${JSON.stringify(t.sms_consent_phone)}, expected the account phone`);
  if (t.sms_opt_in !== true) v.push('ticked: sms_opt_in not true');
  const t2 = payload(src, { contact_name: 'A', sms_opt_in: true });
  if (t2.sms_consent_phone !== null) v.push('ticked with no phone: sms_consent_phone should be null');
  return v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.env.AUTH_JS || path.join(ROOT, 'js/auth.js');
  const v = violations(fs.readFileSync(file, 'utf8'));
  if (v.length) { console.error('FAIL: ' + v.join(' | ')); process.exit(1); }
  console.log('PASS: js/auth.js insert has no sms_consent_phone key unless sms_opt_in is ticked');
}
