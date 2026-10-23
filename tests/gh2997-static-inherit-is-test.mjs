/**
 * gh-2997 -- quotes and activity_log must inherit is_test from the claim at write time.
 * Static guard over supabase/migrations_drafts/gh2997_inherit_is_test.sql (and, once applied, its filed copy) plus the two bid-form
 * clients. The live proof is supabase/tests/gh2997_inherit_is_test_proof.sql (forced rollback, run against production by a human/CTO).
 * Run: node tests/gh2997-static-inherit-is-test.mjs [migration.sql]
 * Negative controls run in-process: each mutant removes one load-bearing line and the checks MUST fail on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIG = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'supabase/migrations_drafts/gh2997_inherit_is_test.sql');
const RB = path.join(ROOT, 'supabase/migrations_drafts/gh2997_inherit_is_test_rollback.sql');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').replace(/\s+/g, ' ');

function checks(sqlRaw) {
  const sql = strip(sqlRaw), out = [];
  const ok = (c, m) => out.push([!!c, m]);
  const qf = (sql.match(/CREATE OR REPLACE FUNCTION public\.quotes_inherit_is_test\(\).*?\$fn\$;/i) || [''])[0];
  const af = (sql.match(/CREATE OR REPLACE FUNCTION public\.activity_log_inherit_is_test\(\).*?\$fn\$;/i) || [''])[0];
  ok(qf, 'quotes_inherit_is_test() is defined');
  ok(/claims c WHERE c\.id = NEW\.claim_id AND c\.is_test IS TRUE/i.test(qf) && /NEW\.is_test := true/i.test(qf), 'quotes function reads claims.is_test via NEW.claim_id and sets NEW.is_test := true');
  ok(!/NEW\.is_test := false/i.test(qf + af), 'neither function ever lowers a true is_test');
  ok(/SECURITY DEFINER/i.test(qf) && /SET search_path TO 'public', 'pg_temp'/i.test(qf), 'quotes function is SECURITY DEFINER with a pinned search_path (a contractor cannot read claims under RLS)');
  ok(/EXCEPTION WHEN OTHERS THEN RAISE WARNING/i.test(qf), 'quotes function never blocks a bid on its own error');
  ok(/CREATE OR REPLACE TRIGGER quotes_inherit_is_test BEFORE INSERT ON public\.quotes FOR EACH ROW EXECUTE FUNCTION public\.quotes_inherit_is_test\(\)/i.test(sql), 'quotes trigger is BEFORE INSERT ... FOR EACH ROW');
  ok(af, 'activity_log_inherit_is_test() is defined');
  ok(/metadata ->> 'claim_id'/i.test(af) && /metadata ->> 'quote_id'/i.test(af), 'activity_log function keys on metadata claim_id and quote_id (the table has no claim_id column)');
  ok(/~ c_uuid/i.test(af) && /\^\[0-9a-fA-F\]\{8\}/.test(sqlRaw), 'uuid shape is checked before every ::uuid cast (a bad claim_id must not raise)');
  ok(/jsonb_typeof\(NEW\.metadata\) = 'object'/i.test(af), 'non-object metadata is ignored');
  ok(/CREATE OR REPLACE TRIGGER activity_log_inherit_is_test BEFORE INSERT ON public\.activity_log FOR EACH ROW/i.test(sql), 'activity_log trigger is BEFORE INSERT ... FOR EACH ROW');
  ok((sql.match(/REVOKE ALL ON FUNCTION public\.\w+_inherit_is_test\(\) FROM PUBLIC, anon, authenticated/gi) || []).length === 2, 'both new public functions revoke EXECUTE from PUBLIC, anon, authenticated');
  ok(!/DROP TRIGGER/i.test(sql), 'no DROP TRIGGER (ACCESS EXCLUSIVE; hung on activity_log during the proof)');
  ok(/UPDATE public\.quotes q SET is_test = true FROM public\.claims c WHERE c\.id = q\.claim_id AND c\.is_test IS TRUE AND q\.is_test IS NOT TRUE/i.test(sql), 'quotes data correction raises false->true only where the claim is is_test');
  ok(/UPDATE public\.activity_log al SET is_test = true WHERE al\.is_test IS NOT TRUE/i.test(sql), 'activity_log data correction raises false->true only');
  ok(!/is_test = false/i.test(sql), 'no statement writes is_test = false');
  ok(!/DELETE FROM|TRUNCATE|DROP TABLE|DROP COLUMN/i.test(sql), 'nothing is deleted or dropped');
  ok(/^\s*BEGIN;/m.test(sqlRaw.replace(/--.*$/gm, '')) && /COMMIT;\s*$/.test(sqlRaw.trim()), 'forward is wrapped in BEGIN ... COMMIT');
  return out;
}
let pass = 0, fail = 0;
const report = (rows, label) => rows.forEach(([c, m]) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}: ${label}${m}`); });
const exists = fs.existsSync(MIG);
if (!exists) { fail++; console.log('FAIL: migration file missing: ' + MIG); }
const raw = exists ? fs.readFileSync(MIG, 'utf8') : '';
report(checks(raw), '');

// rollback
const rb = fs.existsSync(RB) ? strip(fs.readFileSync(RB, 'utf8')) : '';
const rbRows = [
  [/DROP TRIGGER IF EXISTS quotes_inherit_is_test ON public\.quotes/i.test(rb) && /DROP TRIGGER IF EXISTS activity_log_inherit_is_test ON public\.activity_log/i.test(rb), 'rollback drops both triggers'],
  [/DROP FUNCTION IF EXISTS public\.quotes_inherit_is_test\(\)/i.test(rb) && /DROP FUNCTION IF EXISTS public\.activity_log_inherit_is_test\(\)/i.test(rb), 'rollback drops both functions'],
  [!/is_test = false/i.test(rb), 'rollback does not re-flag corrected rows as real'],
];
report(rbRows, 'rollback: ');

// clients: the bid_updated activity_log insert carries claim_id
const html = fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8');
const tsx = fs.readFileSync(path.join(ROOT, 'react-app/app/contractor/bid/[claimId]/bid-form.tsx'), 'utf8');
report([
  [/event_type: 'bid_updated',[\s\S]{0,400}?metadata: \{ claim_id: currentClaim\.id \}/.test(html), 'contractor-bid-form.html bid_updated activity_log insert carries metadata.claim_id'],
  [/event_type: 'bid_updated',[\s\S]{0,400}?metadata: \{ claim_id: String\(claim\.id\) \}/.test(tsx), 'react bid-form.tsx bid_updated activity_log insert carries metadata.claim_id'],
], 'client: ');

// negative controls: each mutant MUST trip at least one check
const mutants = {
  'trigger removed (no quotes trigger)': (s) => s.replace(/CREATE OR REPLACE TRIGGER quotes_inherit_is_test[\s\S]*?;/i, ''),
  'trigger is AFTER, not BEFORE': (s) => s.replace('BEFORE INSERT ON public.quotes', 'AFTER INSERT ON public.quotes'),
  'function can lower a true value': (s) => s.replace('NEW.is_test := true;', 'NEW.is_test := false;'),
  'not SECURITY DEFINER': (s) => s.replace(/SECURITY DEFINER\n/, ''),
  'anon EXECUTE not revoked': (s) => s.replace('FROM PUBLIC, anon, authenticated;', 'FROM PUBLIC;'),
  'uuid shape guard removed': (s) => s.replace(/IF v_claim ~ c_uuid\s+AND/, 'IF').replace(/ELSIF v_quote ~ c_uuid\s+AND/, 'ELSIF'),
  'DROP TRIGGER reintroduced': (s) => s.replace('BEGIN;', 'BEGIN;\nDROP TRIGGER IF EXISTS x ON public.activity_log;'),
  'backfill missing': (s) => s.replace(/UPDATE public\.quotes q[\s\S]*?q\.is_test IS NOT TRUE;/, ''),
};
console.log('--- negative controls (every mutant must FAIL at least one check) ---');
for (const [name, mut] of Object.entries(mutants)) {
  const bad = checks(mut(raw)).filter(([c]) => !c).length;
  const caught = bad > 0;
  caught ? pass++ : fail++;
  console.log(`${caught ? 'PASS' : 'FAIL'}: mutant "${name}" trips ${bad} check(s)`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
