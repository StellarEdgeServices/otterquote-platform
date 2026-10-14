/**
 * gh-2431 -- data repair for profiles whose address_state is the seeded 'IN'.
 * Static guard on the draft/rollback/proof: the rule may clear 'IN' only on a homeowner
 * profile with no street/city/zip that was never updated after signup, must audit every
 * cleared id, must not touch claims or any other column, and the rollback must restore
 * exactly the audited ids. The proof must end in a forced RAISE.
 * Run: node tests/gh2431-profiles-address-state-backfill.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const code = (s) => s.replace(/--.*$/gm, '');
const norm = (s) => s.replace(/\s+/g, ' ');

const fwd = norm(code(rd('supabase/migrations_drafts/gh2431_profiles_address_state_backfill.sql')));
const rb = norm(code(rd('supabase/migrations_rollbacks/gh2431_profiles_address_state_backfill_rollback.sql')));
const proof = rd('supabase/tests/gh2431_address_state_backfill_proof.sql');

ok(/UPDATE public\.profiles SET address_state = NULL WHERE/.test(fwd), 'forward: sets address_state to NULL on profiles');
for (const [re, msg] of [
  [/role = 'homeowner'/, "role = 'homeowner'"],
  [/address_state = 'IN'/, "only rows currently 'IN'"],
  [/address_street IS NULL/, 'no street'],
  [/address_city IS NULL/, 'no city'],
  [/address_zip IS NULL/, 'no zip'],
  [/updated_at <= created_at \+ interval '1 minute'/, 'never updated after signup'],
]) ok(re.test(fwd), 'forward rule requires: ' + msg);
ok((fwd.match(/\bUPDATE\b/g) || []).length === 1, 'forward: exactly one UPDATE');
ok(!/\b(claims|contractors)\b/.test(fwd.replace(/gh2431_profiles_state_backfill_audit/g, '')), 'forward: touches neither claims nor contractors');
ok(/SET address_state = NULL WHERE/.test(fwd) && !/SET address_state = NULL, /.test(fwd), 'forward: changes only address_state');
ok(/RETURNING id/.test(fwd) && /INSERT INTO public\.gh2431_profiles_state_backfill_audit \(profile_id, prior_state\) SELECT id, 'IN' FROM hit/.test(fwd), 'forward: every cleared id is written to the audit table');
ok(/ENABLE ROW LEVEL SECURITY/.test(fwd), 'forward: audit table has RLS enabled (no policy, service role only)');
ok(/REVOKE ALL ON public\.gh2431_profiles_state_backfill_audit FROM PUBLIC, anon, authenticated;/.test(fwd), 'forward: REVOKE ALL on the audit table from PUBLIC, anon, authenticated');
ok(/GRANT ALL ON public\.gh2431_profiles_state_backfill_audit TO service_role;/.test(fwd), 'forward: explicit GRANT ALL to service_role (New-Table Service-Role Grant check)');
ok(!/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i.test(fwd), 'forward: no DELETE/DROP/TRUNCATE');
ok(/UPDATE public\.profiles p SET address_state = a\.prior_state FROM public\.gh2431_profiles_state_backfill_audit a WHERE a\.profile_id = p\.id AND p\.address_state IS NULL/.test(rb), 'rollback: restores only audited ids, only where still NULL');
ok(/DROP TABLE public\.gh2431_profiles_state_backfill_audit/.test(rb), 'rollback: drops the audit table');
ok(!/'IN'/.test(rb), 'rollback: hard-codes no state (value comes from the audit row)');
ok(/RAISE EXCEPTION 'GH2431_BACKFILL_PROOF_FORCED_ROLLBACK%', v_report;\s*END\s*\$proof\$;\s*$/.test(proof), 'proof: ends in a forced RAISE EXCEPTION');
ok(/\$fwd\$[\s\S]*UPDATE public\.profiles[\s\S]*\$fwd\$/.test(proof), 'proof: embeds the forward body');
// proof bodies must equal the files (so the proof cannot drift)
const strip = (s) => norm(s.replace(/^--.*$/gm, '').replace(/BEGIN;|COMMIT;/g, ''));
const embFwd = proof.match(/\$fwd\$([\s\S]*?)\$fwd\$/)[1];
const embRb = proof.match(/\$rb\$([\s\S]*?)\$rb\$/)[1];
ok(strip(embFwd).trim() === strip(rd('supabase/migrations_drafts/gh2431_profiles_address_state_backfill.sql')).trim(), 'proof: embedded forward body equals the forward file');
ok(strip(embRb).trim() === strip(rd('supabase/migrations_rollbacks/gh2431_profiles_address_state_backfill_rollback.sql')).trim(), 'proof: embedded rollback body equals the rollback file');
ok(/B=%s/.test(proof) && /address_city = 'Proofville'/.test(proof), 'proof: has the kept-row negative control (IN with a city)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
