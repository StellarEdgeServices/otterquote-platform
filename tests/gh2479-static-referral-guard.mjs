/**
 * gh-2479 -- claims.referral_id / claims.completion_date must be frozen for client callers, and
 * apply_referral_commission() must check the attribution window, the referral status and is_test.
 *
 * Production (proven by CTO RUN 57, #2479 comment 5969752407): a claim owner could UPDATE both columns
 * through the public API and accrue $200 per referral with no window, status or is_test check.
 * Migration 20261003193000_gh2479_referral_guard_and_commission_checks adds a BEFORE UPDATE guard on
 * claims and the three checks. Window rule (ruling on #2403, comment 5972625589): measured at
 * attribution, referral.created_at >= claims.created_at - referral_attribution_window(), never
 * now() - 30 days at completion.
 *
 * Static guard (same style as gh2472-static-referrals-insert-lockdown.mjs). The live proof is
 * supabase/tests/gh2479_referral_guard_proof.sql (rolled back, run by a human against production).
 * Run: node tests/gh2479-static-referral-guard.mjs [migration.sql]   (argument = negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const MIG_NAME = '20261003193000_gh2479_referral_guard_and_commission_checks.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const norm = (s) => stripSql(s).replace(/\s+/g, ' ');

const migPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(MIG_DIR, MIG_NAME);
ok(fs.existsSync(migPath), `migration file exists (${path.relative(ROOT, migPath)})`);
const raw = fs.existsSync(migPath) ? fs.readFileSync(migPath, 'utf8') : '';
const sql = norm(raw);

// ---- 1. the guard ----
const guardFn = (sql.match(/CREATE OR REPLACE FUNCTION public\.claims_guard_referral_columns\(\).*?\$guard\$;/i) || [''])[0];
ok(guardFn !== '', 'guard function claims_guard_referral_columns() is defined');
ok(!/SECURITY DEFINER/i.test(guardFn), 'guard is SECURITY INVOKER (current_user must be the caller)');
ok(/current_user IN \('anon', 'authenticated'\)/i.test(guardFn), 'guard applies to the client roles anon/authenticated');
ok(/auth\.role\(\)[^;]*<> 'service_role'/i.test(guardFn) && /is_admin_email\(\)/i.test(guardFn), 'guard exempts service_role and admins');
ok(/NEW\.referral_id IS DISTINCT FROM OLD\.referral_id/i.test(guardFn) && /NEW\.completion_date IS DISTINCT FROM OLD\.completion_date/i.test(guardFn),
  'guard compares referral_id and completion_date to the stored values');
ok(/USING ERRCODE = '42501'/i.test(guardFn), 'guard rejects with 42501');
ok(/CREATE TRIGGER claims_guard_referral_columns BEFORE UPDATE ON public\.claims FOR EACH ROW EXECUTE FUNCTION public\.claims_guard_referral_columns\(\)/i.test(sql),
  'trigger claims_guard_referral_columns is BEFORE UPDATE ON public.claims');

// ---- 2. apply_referral_commission checks ----
const fn = (sql.match(/CREATE OR REPLACE FUNCTION public\.apply_referral_commission\(\).*?\$function\$;/i) || [''])[0];
ok(fn !== '', 'apply_referral_commission() is replaced in the migration');
ok(/SECURITY DEFINER/i.test(fn), 'apply_referral_commission stays SECURITY DEFINER');
ok(/v_referral\.created_at < NEW\.created_at - public\.referral_attribution_window\(\)/i.test(fn),
  'window measured at attribution: referral.created_at vs claims.created_at - referral_attribution_window()');
ok(!/now\(\)\s*-\s*(public\.referral_attribution_window|interval '30 days')/i.test(fn), 'no now() - 30 days window at completion (the #2403 trap)');
ok(/v_referral\.created_at IS NULL/i.test(fn), 'a NULL referral date accrues nothing');
ok(/v_referral\.status NOT IN \('claim_submitted', 'bid_received', 'contract_signed'\)/i.test(fn), 'referral status must be an attributed status');
ok(/NEW\.is_test.*IS DISTINCT FROM.*v_referral\.is_test/i.test(fn) && /IS DISTINCT FROM COALESCE\(v_referrer\.is_test/i.test(fn), 'is_test must agree on claim, referral and referrer');
ok((fn.match(/is_test\s*\)\s*VALUES|auto_approve_at, is_test/gi) || []).length >= 2 && (fn.match(/COALESCE\(NEW\.is_test, false\)\s*\)/g) || []).length >= 2,
  'both payout_approvals inserts carry the claim is_test');
// the checks come before the first write
const iCheck = fn.indexOf('is_test mismatch'), iWrite = fn.search(/UPDATE public\.referrals/i);
ok(iCheck > 0 && iWrite > iCheck, 'checks run before the first write');
// legitimate behaviour kept
ok(/commission_amount = 200/.test(fn) && /recruit_commission_amount = 50/.test(fn) && /home_inspector/.test(fn), 'amounts and the D-333 home_inspector guards are unchanged');

// ---- 3. protective only ----
ok(!/\b(GRANT|CREATE POLICY|DROP POLICY|ALTER TABLE)\b/i.test(sql), 'migration adds no GRANT, policy or table change');
ok(/^BEGIN;/m.test(raw) && /^COMMIT;/m.test(raw), 'migration is wrapped in BEGIN/COMMIT');

// ---- 4. rollback exists and restores the old function ----
const rbPath = path.join(ROOT, 'supabase/migrations_rollbacks', MIG_NAME.replace(/\.sql$/, '_rollback.sql'));
ok(fs.existsSync(rbPath), 'rollback file exists in supabase/migrations_rollbacks/');
const rb = fs.existsSync(rbPath) ? norm(fs.readFileSync(rbPath, 'utf8')) : '';
ok(/DROP TRIGGER IF EXISTS claims_guard_referral_columns ON public\.claims/i.test(rb) && /DROP FUNCTION IF EXISTS public\.claims_guard_referral_columns\(\)/i.test(rb), 'rollback drops the guard');
ok(/CREATE OR REPLACE FUNCTION public\.apply_referral_commission/i.test(rb) && !/gh-2479/.test(rb), 'rollback restores the pre-fix function body');

// ---- 5. no later migration removes the guard ----
const later = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f > MIG_NAME).sort();
const removed = later.filter((f) => /DROP TRIGGER[^;]*claims_guard_referral_columns|DROP FUNCTION[^;]*claims_guard_referral_columns|DISABLE TRIGGER[^;]*claims_guard_referral_columns/i.test(norm(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))));
ok(removed.length === 0, 'no later migration drops or disables the guard' + (removed.length ? ': ' + removed.join(', ') : ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
