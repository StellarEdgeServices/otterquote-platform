/**
 * gh-3460 -- static checks for the release path of a held $5 on an 'unspecified' measurement order.
 *  1. admin-measurements.html: a re-save of an already delivered order calls send-measurement-ready (a numbers-only order has no report_url and the form does not
 *     reload its numbers, so `delivering` is false on a re-save); the delivering patch (status/fulfilled_at) and the shape flip still key on `delivering` alone.
 *  2. the draft migration reuses partner_fee_accrue_on_order() (no copy of its checks), is admin-only, and the rollback/pre-flight/proof/runbook exist.
 * Run: node tests/gh3460-held-fee-release.mjs [path-to-admin-measurements.html]   (the optional path is how the fail-first run points at main's copy)
 * Exit 0 = pass, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m); } else { fail++; console.log('FAIL ' + m); } };
const page = fs.readFileSync(process.argv[2] || path.join(ROOT, 'admin-measurements.html'), 'utf8');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

ok(/var notifyReady = delivering \|\| row\.status === 'completed';/.test(page), 'page: notifyReady = delivering OR an already completed order');
ok(/if \(notifyReady\) \{\s*try \{\s*var sess = await sb\.auth\.getSession\(\);/.test(page), 'page: send-measurement-ready is called under notifyReady');
ok(/if \(delivering\) \{\s*patch\.status = 'completed';/.test(page), 'page NEGATIVE CONTROL: status/fulfilled_at are still written only when delivering (a plain re-save does not restamp the order)');
ok(/shouldFlipMeasurementShapeOnDeliver\(row, delivering\)/.test(page), 'page NEGATIVE CONTROL: the shape flip still keys on delivering');

const fwd = rd('supabase/migrations_drafts/gh3460_held_fee_release.sql');
ok(/EXECUTE FUNCTION public\.partner_fee_accrue_on_order\(\)/.test(fwd), 'migration: the new trigger runs the existing accrual function');
ok(/WHEN \(OLD\.requested_by_role = 'unspecified' AND NEW\.requested_by_role = 'homeowner' AND NEW\.product_code IS DISTINCT FROM 'roof_upgrade_detailed'\)/.test(fwd), 'migration: the trigger arm is unspecified -> homeowner only, and never for the contractor-only upgrade (D-317)');
ok(/IF p_role = 'homeowner' AND v_order\.product_code IS NOT DISTINCT FROM 'roof_upgrade_detailed' THEN\s*RAISE EXCEPTION/.test(fwd), 'migration: the admin function refuses to settle an upgrade order to a homeowner (22023)');
ok(!/records the role only/.test(fwd) && /It cannot withhold an earned fee/.test(fwd), 'migration NEGATIVE CONTROL: the false "records the role only, no fee" wording is gone');
ok(!/INSERT INTO public\.partner_fee_events/.test(fwd), 'migration NEGATIVE CONTROL: no second INSERT into partner_fee_events (no copy of the checks to drift)');
ok(!/CREATE OR REPLACE FUNCTION public\.partner_fee_accrue_on_order/.test(fwd), 'migration: the accrual function is not redefined');
ok(/auth\.role\(\), ''\) = 'service_role' OR COALESCE\(public\.is_admin_email\(\), false\)/.test(fwd) && /COALESCE\(p_require_fee, true\)/.test(fwd) && /FROM PUBLIC, anon;/.test(fwd), 'migration: admin or service role only, NULL-safe guard and NULL-safe p_require_fee; not executable by anon');
for (const f of ['supabase/migrations_drafts/gh3460_held_fee_release_rollback.sql', 'supabase/migrations_drafts/gh3460_held_fee_release_pre-flight.md',
  'supabase/tests/gh3460_held_fee_release_proof.sql', 'supabase/tests/gh3460_held_fee_release_local_run.sh', 'runbooks/held-partner-fee-release.md']) ok(fs.existsSync(path.join(ROOT, f)), 'exists: ' + f);
ok(/NOT APPLIED/.test(fwd.split('\n')[0]), 'migration header says NOT APPLIED');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
