/**
 * gh-3136 (P14) -- project-info-rcv.html / project-info-acv.html trim.
 * The form keeps ONLY: Insurance Claim #, urgency (+ ASAP deadline/reason), notes.
 * Carrier, date of loss, damage type, deductible, adjuster x3, ACV/RCV amounts are
 * deferred to the dashboard. The save handler must send only keys still on the form
 * (parse-loss-sheet fills deductible/carrier/rcv/acv and a form save must not null them).
 * Static test, no network.   Run: node tests/gh3136-project-info-trim.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const REMOVED = ['carrier_id', 'date_of_loss', 'damage_type', 'deductible_amount', 'adjuster_name', 'adjuster_email', 'adjuster_phone'];
const REMOVED_ACV = ['acv_amount', 'rcv_amount'];
const REMOVED_LABELS = ['Insurance Carrier', 'Date of Loss', 'Damage Type', 'Deductible Amount', 'Adjuster Name', 'Adjuster Email', 'Adjuster Phone'];
const REMOVED_LABELS_ACV = ['ACV Payout Amount', 'RCV Amount'];
const KEPT = ['claim_number', 'urgency', 'urgency_deadline', 'urgency_reason', 'homeowner_notes'];
const KEPT_LABELS = ['Insurance Claim #', 'When do you need this completed?', 'Deadline Date', 'Reason', 'Notes for Contractors (optional)'];

for (const v of ['rcv', 'acv']) {
  const f = `project-info-${v}.html`;
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const removed = REMOVED.concat(v === 'acv' ? REMOVED_ACV : []);
  const labels = REMOVED_LABELS.concat(v === 'acv' ? REMOVED_LABELS_ACV : []);
  const body = src.slice(src.indexOf('<main'), src.indexOf('</main>')).replace(/<!--[\s\S]*?-->/g, '');
  const script = src.slice(src.lastIndexOf('<script>'), src.lastIndexOf('</script>'));

  for (const id of removed) ok(!new RegExp(`id="${id}"`).test(body), `${f}: no input id="${id}"`);
  for (const l of labels) ok(!body.includes(l), `${f}: label "${l}" absent`);
  for (const id of KEPT) ok(new RegExp(`id="${id}"`).test(body), `${f}: kept id="${id}"`);
  for (const l of KEPT_LABELS) ok(body.includes(l), `${f}: kept label "${l}"`);
  ok(/id="urgency-details" style="display:none;"/.test(body), `${f}: deadline/reason still conditional (hidden until ASAP)`);
  ok(body.includes('Nothing here is required to submit'), `${f}: sub-text kept`);
  ok(body.includes('id="pi-submit"') && script.includes("window.location.href = '/dashboard.html'"), `${f}: Save & Continue -> /dashboard.html unchanged`);

  // payload source: from "const updates" through the .update(updates) call
  const a = script.indexOf('const updates = {'), b = script.indexOf(".update(updates)");
  ok(a > 0 && b > a, `${f}: update payload source located`);
  const payload = script.slice(a, b);
  for (const k of removed) ok(!payload.includes(k), `${f}: payload does not reference ${k}`);
  ok(!/upsert_adjuster_from_claim|adjuster_id/.test(script), `${f}: no adjuster upsert on this page`);
  ok(!/loadCarriers|carrier_profiles/.test(script), `${f}: dead carrier lookup removed`);
  // every key sent must be a form-owned or fixed key
  const allowed = new Set(['job_type', 'funding_type', 'policy_type', 'urgency', 'urgency_deadline', 'urgency_reason', 'updated_at', 'claim_number', 'homeowner_notes']);
  const sent = [...payload.matchAll(/^\s*(?:updates\.)?([a-z_]+)\s*(?::|=)\s/gm)].map((m) => m[1]).filter((k) => k !== 'updates' && k !== 'const');
  ok(sent.length > 0 && sent.every((k) => allowed.has(k)), `${f}: payload keys all allowed (${[...new Set(sent)].join(',')})`);
  // blank optional text must not be sent as null (would erase a saved value)
  ok(!/claim_number:\s*val\('claim_number'\) \|\| null/.test(payload) && !/homeowner_notes:\s*val\('homeowner_notes'\) \|\| null/.test(payload), `${f}: blank claim #/notes are omitted, not nulled`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
