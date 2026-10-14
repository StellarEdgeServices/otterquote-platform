/**
 * gh-1916 / D-328 (PR #2722, LEGAL-READ 6158665986 condition 4): the optional SMS box on
 * contractor-pre-approval.html (#agreeTcpaSms) must carry the SAME consent sentence as
 * contractor-join.html (#smsConsent) and write the SAME evidence columns, so there is one
 * consent sentence for one program and a ticked box really is an opt-in.
 *
 * Static source test. Run: node tests/gh1916-pre-approval-sms-consent.mjs
 * Exit code 0 = pass, 1 = fail. Negative controls at the bottom feed the checker bad pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const norm = (html) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** Visible text of the label sentence for a given checkbox id, or null. */
export function labelText(html, id) {
  const re = id === 'smsConsent'
    ? /<span>(I agree to receive SMS from Otter Quotes[\s\S]*?)<\/span>/
    : new RegExp(`<label for="${id}">([\\s\\S]*?)</label>`);
  const m = html.match(re);
  return m ? norm(m[1]) : null;
}

/** Violations for a pre-approval page checked against the join page (empty = ok). */
export function check(joinHtml, preHtml) {
  const v = [];
  const join = labelText(joinHtml, 'smsConsent');
  const pre = labelText(preHtml, 'agreeTcpaSms');
  if (!join) v.push('join page: #smsConsent label not found');
  if (!pre) v.push('pre-approval: #agreeTcpaSms label not found');
  if (join && pre && join !== pre) v.push(`label differs: join=${JSON.stringify(join)} pre=${JSON.stringify(pre)}`);
  if (pre && /transactional/i.test(pre)) v.push('pre-approval label still says "transactional"');
  if (pre && !/HELP for help/.test(pre)) v.push('pre-approval label has no HELP line');
  // evidence columns written from the pre-approval submit
  for (const col of ['sms_opt_in:', 'sms_opt_in_at:', 'sms_opt_in_source:', 'sms_consent_text_version:', 'sms_consent_phone:']) {
    if (!preHtml.includes(col)) v.push(`pre-approval does not write ${col}`);
  }
  const ver = (joinHtml.match(/sms_consent_text_version:\s*smsConsent \? '([^']+)'/) || [])[1];
  if (!ver) v.push('join page consent version not found');
  else if (!preHtml.includes(`sms_consent_text_version: '${ver}'`)) v.push(`pre-approval does not write version ${ver}`);
  if (/sms_opt_in:\s*false/.test(preHtml)) v.push('pre-approval writes a bare false sms_opt_in');
  return v;
}

const join = read('contractor-join.html');
const pre = read('contractor-pre-approval.html');

const real = check(join, pre);
assert.deepEqual(real, [], 'real pages: ' + real.join(' | '));
console.log('PASS: pre-approval #agreeTcpaSms matches contractor-join #smsConsent and writes sms_opt_in evidence');

// Negative controls
const mustFail = (name, j, p, needle) => {
  const out = check(j, p);
  assert.ok(out.some((s) => s.includes(needle)), `${name}: expected a violation containing ${JSON.stringify(needle)}, got ${JSON.stringify(out)}`);
  console.log(`PASS (negative control): ${name}`);
};
mustFail('old "transactional" label is flagged', join,
  pre.replace(/<label for="agreeTcpaSms">[\s\S]*?<\/label>/, '<label for="agreeTcpaSms">I agree to receive transactional SMS from Otter Quotes. Reply STOP to unsubscribe.</label>'),
  'label differs');
mustFail('box that writes only sms_consent_ts is flagged', join, pre.replace(/sms_opt_in:\s+true,/, ''), 'does not write sms_opt_in:');
mustFail('a different consent version is flagged', join, pre.replace("sms_consent_text_version: 'contractor-v2-2026-09-15'", "sms_consent_text_version: 'contractor-v1'"), 'does not write version');
mustFail('a bare false is flagged', join, pre.replace(/sms_opt_in:\s+true,/, 'sms_opt_in: false,'), 'bare false');
