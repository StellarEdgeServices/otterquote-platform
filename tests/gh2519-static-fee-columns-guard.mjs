/**
 * gh-2519 -- the quotes fee columns stay guarded for the claim owner.
 *
 * #2519: the policy "Homeowners can update quotes for their claims" has no column restriction, so a claim
 * owner could write quotes.fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis. The
 * total_price half is closed by 20261005170000_gh2479_quotes_homeowner_guard. Migration
 * 20261006170000_gh2519_quotes_fee_columns_guard adds the fee-column rule INSIDE the existing function
 * public.quotes_guard_homeowner_columns() (no second trigger: tests/gh2479-static-born-state-guard.mjs
 * enforces that, and this check does not repeat it).
 *
 * This check reads the LATEST definition of the function across supabase/migrations. A later migration that
 * re-creates it must carry the fee rule or this check fails.
 * The live proof is supabase/tests/gh2519_quotes_fee_columns_guard_proof.sql (rolled back, run by a human
 * against production). CI never touches the database.
 * Run: node tests/gh2519-static-fee-columns-guard.mjs [migration.sql]
 *      (argument = read the function from that one file instead: the negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const RB_DIR = path.join(ROOT, 'supabase/migrations_rollbacks');
const MIG_NAME = '20261006170000_gh2519_quotes_fee_columns_guard.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const norm = (s) => stripSql(s).replace(/\s+/g, ' ');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const FN = /CREATE OR REPLACE FUNCTION public\.quotes_guard_homeowner_columns\(\).*?\$guard\$;/i;

const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const only = process.argv[2] ? path.resolve(process.argv[2]) : null;
const files = only ? [only] : migFiles.map((f) => path.join(MIG_DIR, f));
let latestFile = null, body = '';
for (const f of files) { const m = norm(read(f)).match(FN); if (m) { latestFile = f; body = m[0]; } }
console.log('INFO: latest quotes_guard_homeowner_columns() is in ' + (latestFile ? path.relative(ROOT, latestFile) : '(none)'));

ok(fs.existsSync(path.join(MIG_DIR, MIG_NAME)), `migration file exists (supabase/migrations/${MIG_NAME})`);
ok(body !== '', 'guard function quotes_guard_homeowner_columns() is defined');
ok(!/SECURITY DEFINER/i.test(body), 'quotes guard is SECURITY INVOKER (current_user must be the caller)');
ok(/current_user IN \('anon', 'authenticated'\)/i.test(body) && /auth\.role\(\)[^;]*<> 'service_role'/i.test(body) && /is_admin_email\(\)/i.test(body),
  'quotes guard applies to client roles and exempts service_role and admins');

// the fee rule: one IF block that names all four columns, is exempt for the quote's own contractor, raises 42501
const i = body.search(/NEW\.fee_amount IS DISTINCT FROM OLD\.fee_amount/i);
const block = i < 0 ? '' : body.slice(Math.max(0, i - 40), body.indexOf('END IF;', i) + 7);
for (const col of ['fee_amount', 'fee_percentage', 'platform_fee_pct', 'platform_fee_basis']) {
  ok(new RegExp('NEW\\.' + col + ' IS DISTINCT FROM OLD\\.' + col, 'i').test(block), `fee rule compares ${col} to the stored value`);
}
ok(/IF COALESCE\(/i.test(block) && /, true\) AND NOT COALESCE\(EXISTS \( SELECT 1 FROM public\.contractors k WHERE k\.id = OLD\.contractor_id AND k\.user_id = auth\.uid\(\)\), false\) THEN/i.test(block),
  'fee rule refuses everyone but the quote\'s own contractor, and fails closed on NULL');
ok(/RAISE EXCEPTION '[^']*gh-2519\)' USING ERRCODE = '42501'/i.test(block), 'fee rule raises 42501 and names gh-2519');
ok(!/NEW\.(fee_amount|fee_percentage|platform_fee_pct|platform_fee_basis) IS NOT NULL/i.test(block), 'fee rule does not reject on the mere presence of a column (an unchanged re-send is allowed)');
ok(!/status/i.test(block), 'fee rule has no status clause (no post-selection lock: no decision backs one)');
// the rule must sit in the UPDATE arm: after the INSERT arm returns, before END of the client branch
const insArm = body.search(/IF TG_OP = 'INSERT' THEN/i);
ok(insArm >= 0 && i > body.search(/RETURN NEW; END IF;/i), 'fee rule is after the INSERT arm returns (it reads OLD)');
// kept rules, so a rewrite of the function cannot drop them (the full list is in gh2479-static-born-state-guard.mjs)
ok(/NEW\.total_price IS DISTINCT FROM OLD\.total_price/i.test(body) && /NEW\.claim_id IS DISTINCT FROM OLD\.claim_id/i.test(body)
  && /NEW\.status IN \('selected', 'declined'\)/i.test(body) && /IF TG_OP = 'INSERT' THEN/i.test(body), 'KEPT: total_price, claim_id, status and the INSERT arm are still in the function');

// ---- this migration: protective only, no new trigger or function ----
const raw = read(path.join(MIG_DIR, MIG_NAME)), own = norm(raw);
ok(!/\b(GRANT|REVOKE|CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER TABLE|DROP TRIGGER|DROP FUNCTION|DISABLE TRIGGER|CREATE TRIGGER|CREATE OR REPLACE TRIGGER)\b/i.test(own),
  'migration has no GRANT, REVOKE, policy, table change, DROP or trigger');
ok((own.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(\)/gi) || []).length === 1, 'migration replaces exactly one function (the existing quotes guard)');
ok(/^BEGIN;/m.test(raw) && /^COMMIT;/m.test(raw), 'migration is wrapped in BEGIN/COMMIT');
ok(!/apply_referral_commission|self.?referral|payment_status|is_test/i.test(own.replace(/COMMENT ON FUNCTION.*?;/i, '').replace(/INSERT.*?RETURN NEW; END IF;/i, '')),
  'migration touches neither the commission function nor payment_status / is_test (separate changes)');

// ---- rollback restores the previous body ----
const rb = norm(read(path.join(RB_DIR, MIG_NAME.replace(/\.sql$/, '_rollback.sql'))));
ok(rb !== '', 'rollback file exists in supabase/migrations_rollbacks/');
const rbBody = (rb.match(FN) || [''])[0];
ok(rbBody !== '' && !/NEW\.fee_amount IS DISTINCT FROM OLD\.fee_amount/i.test(rbBody) && /IF TG_OP = 'INSERT' THEN/i.test(rbBody) && /NEW\.total_price IS DISTINCT FROM OLD\.total_price/i.test(rbBody),
  'rollback restores the body without the fee rule and keeps the INSERT arm and the earlier rules');
ok(!/\bDROP\b/i.test(rb), 'rollback drops nothing (the trigger and the earlier guards stay)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
