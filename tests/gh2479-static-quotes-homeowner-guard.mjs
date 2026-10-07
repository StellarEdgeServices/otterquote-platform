/**
 * gh-2479 / gh-2519 -- quotes.claim_id, quotes.total_price and quotes.status must stay guarded for
 * client callers, and referral_agents.agent_type must stay frozen for them.
 *
 * Production (independent refuter, #2479 comment 5998207363): a claim owner could INSERT a second claim
 * carrying a chosen referral, UPDATE the selected quote's claim_id onto it (policy "Homeowners can update
 * quotes for their claims" has no column restriction) and get a $200 accrual on the contractor's ordinary
 * completion. #2519: the same policy let the owner write quotes.total_price. Migration
 * 20261005170000_gh2479_quotes_homeowner_guard adds a BEFORE UPDATE guard on quotes and one on
 * referral_agents.agent_type.
 *
 * Static guard (same style as gh2479-static-referral-guard.mjs). The live proof is
 * supabase/tests/gh2479_quotes_guard_proof.sql (rolled back, run by a human against production).
 * Run: node tests/gh2479-static-quotes-homeowner-guard.mjs [migration.sql]   (argument = negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const MIG_NAME = '20261005173827_gh2479_quotes_homeowner_guard.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const norm = (s) => stripSql(s).replace(/\s+/g, ' ');

const migPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(MIG_DIR, MIG_NAME);
ok(fs.existsSync(migPath), `migration file exists (${path.relative(ROOT, migPath)})`);
const raw = fs.existsSync(migPath) ? fs.readFileSync(migPath, 'utf8') : '';
const sql = norm(raw);

// ---- 1. the quotes guard ----
const q = (sql.match(/CREATE OR REPLACE FUNCTION public\.quotes_guard_homeowner_columns\(\).*?\$guard\$;/i) || [''])[0];
ok(q !== '', 'guard function quotes_guard_homeowner_columns() is defined');
ok(!/SECURITY DEFINER/i.test(q), 'quotes guard is SECURITY INVOKER (current_user must be the caller)');
ok(/current_user IN \('anon', 'authenticated'\)/i.test(q), 'quotes guard applies to the client roles anon/authenticated');
ok(/auth\.role\(\)[^;]*<> 'service_role'/i.test(q) && /is_admin_email\(\)/i.test(q), 'quotes guard exempts service_role and admins');
ok(/NEW\.claim_id IS DISTINCT FROM OLD\.claim_id/i.test(q), 'claim_id is compared to the stored value (the quote-move route)');
ok(/NEW\.contractor_id IS DISTINCT FROM OLD\.contractor_id/i.test(q), 'contractor_id is frozen (the total_price rule is keyed on it)');
ok(/NEW\.total_price IS DISTINCT FROM OLD\.total_price/i.test(q), 'total_price is compared to the stored value (gh-2519)');
ok(/k\.id = OLD\.contractor_id AND k\.user_id = auth\.uid\(\)/i.test(q), 'total_price may change only for the quote\'s own contractor, looked up on OLD.contractor_id');
ok(/NEW\.status IS DISTINCT FROM OLD\.status/i.test(q), 'status is compared to the stored value');
ok(/NEW\.status IN \('selected', 'declined'\)/i.test(q), 'the only client status values are selected and declined (the homeowner award)');
ok(/c\.id = OLD\.claim_id AND c\.user_id = auth\.uid\(\)/i.test(q), 'status may change only for the claim owner, looked up on OLD.claim_id');
ok(!/NEW\.(claim_id|total_price|status) IS NOT NULL/i.test(q), 'guard does not reject on the mere presence of a column (an unchanged re-send is allowed)');
ok((q.match(/USING ERRCODE = '42501'/gi) || []).length === 3, 'each of the three refusals raises 42501');
// fail closed: every refusal condition is COALESCEd so a NULL can never mean "allowed"
ok(/IF COALESCE\( \(NEW\.claim_id IS DISTINCT FROM OLD\.claim_id\) OR \(NEW\.contractor_id IS DISTINCT FROM OLD\.contractor_id\), true\)/i.test(q)
  && /AND NOT COALESCE\(EXISTS \(/i.test(q) && /AND NOT COALESCE\( NEW\.status IN/i.test(q), 'refusal conditions fail closed on NULL');
ok(/CREATE TRIGGER quotes_guard_homeowner_columns BEFORE UPDATE ON public\.quotes FOR EACH ROW EXECUTE FUNCTION public\.quotes_guard_homeowner_columns\(\)/i.test(sql),
  'trigger quotes_guard_homeowner_columns is BEFORE UPDATE ON public.quotes FOR EACH ROW');
// BEFORE triggers fire in name order: the guard must see the caller's values before the two that rewrite NEW
ok('quotes_guard_homeowner_columns' < 'quotes_normalize_fee_amount' && 'quotes_guard_homeowner_columns' < 'set_updated_at_quotes',
  'trigger name sorts before quotes_normalize_fee_amount and set_updated_at_quotes');

// ---- 2. the agent_type guard ----
const a = (sql.match(/CREATE OR REPLACE FUNCTION public\.referral_agents_guard_agent_type\(\).*?\$guard\$;/i) || [''])[0];
ok(a !== '', 'guard function referral_agents_guard_agent_type() is defined');
ok(!/SECURITY DEFINER/i.test(a), 'agent_type guard is SECURITY INVOKER');
ok(/current_user IN \('anon', 'authenticated'\)/i.test(a) && /auth\.role\(\)[^;]*<> 'service_role'/i.test(a) && /is_admin_email\(\)/i.test(a),
  'agent_type guard applies to client roles and exempts service_role and admins (the admin pages set agent_type)');
ok(/COALESCE\(NEW\.agent_type IS DISTINCT FROM OLD\.agent_type, true\)/i.test(a) && /USING ERRCODE = '42501'/i.test(a), 'a changed agent_type is rejected 42501');
ok(/CREATE TRIGGER referral_agents_guard_agent_type BEFORE UPDATE ON public\.referral_agents FOR EACH ROW EXECUTE FUNCTION public\.referral_agents_guard_agent_type\(\)/i.test(sql),
  'trigger referral_agents_guard_agent_type is BEFORE UPDATE ON public.referral_agents FOR EACH ROW');

// ---- 3. protective only ----
ok(!/\b(GRANT|REVOKE|CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER TABLE)\b/i.test(sql), 'migration adds no GRANT, REVOKE, policy or table change');
ok(!/apply_referral_commission|self.?referral/i.test(sql), 'migration does not touch apply_referral_commission and builds no self-referral rule');
ok(/^BEGIN;/m.test(raw) && /^COMMIT;/m.test(raw), 'migration is wrapped in BEGIN/COMMIT');

// ---- 4. rollback and pre-flight exist ----
const rbPath = path.join(ROOT, 'supabase/migrations_rollbacks', MIG_NAME.replace(/\.sql$/, '_rollback.sql'));
ok(fs.existsSync(rbPath), 'rollback file exists in supabase/migrations_rollbacks/');
const rb = fs.existsSync(rbPath) ? norm(fs.readFileSync(rbPath, 'utf8')) : '';
ok(/DROP TRIGGER IF EXISTS quotes_guard_homeowner_columns ON public\.quotes/i.test(rb) && /DROP FUNCTION IF EXISTS public\.quotes_guard_homeowner_columns\(\)/i.test(rb), 'rollback drops the quotes guard');
ok(/DROP TRIGGER IF EXISTS referral_agents_guard_agent_type ON public\.referral_agents/i.test(rb) && /DROP FUNCTION IF EXISTS public\.referral_agents_guard_agent_type\(\)/i.test(rb), 'rollback drops the agent_type guard');
ok(!/claims_guard_referral_columns|apply_referral_commission|referral_agents_guard_payout_columns/i.test(rb), 'rollback touches nothing this migration did not add');
ok(fs.existsSync(path.join(MIG_DIR, MIG_NAME.replace(/\.sql$/, '_pre-flight.md'))), 'pre-flight note exists next to the migration');
ok(fs.existsSync(path.join(ROOT, 'supabase/tests/gh2479_quotes_guard_proof.sql')), 'rolled-back proof file exists in supabase/tests/');

// ---- 5. no later migration removes either guard ----
const later = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f > MIG_NAME).sort();
const re = /(DROP TRIGGER|DROP FUNCTION|DISABLE TRIGGER)[^;]*(quotes_guard_homeowner_columns|referral_agents_guard_agent_type)/i;
const removed = later.filter((f) => re.test(norm(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))));
ok(removed.length === 0, 'no later migration drops or disables either guard' + (removed.length ? ': ' + removed.join(', ') : ''));

// ---- 6. the client still sends only what the guard allows ----
// The homeowner award (React) writes quotes.status as 'selected' and 'declined' and nothing else on quotes.
const actionsPath = path.join(ROOT, 'react-app/app/(homeowner)/bids/actions.ts');
if (fs.existsSync(actionsPath)) {
  const src = fs.readFileSync(actionsPath, 'utf8');
  const updates = [...src.matchAll(/\.from\('quotes'\)\s*\.update\(\{([^}]*)\}\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  ok(updates.length === 2 && updates.every((u) => /^status: '(selected|declined)',?$/.test(u)),
    `homeowner bids/actions.ts writes only status selected/declined to quotes (found: ${JSON.stringify(updates)})`);
} else {
  ok(false, 'react-app/app/(homeowner)/bids/actions.ts not found: re-derive the homeowner quote writes before changing the guard');
}
// No browser code sends claim_id or contractor_id in a quotes UPDATE payload.
const clientFiles = ['contract-signing.html', 'contractor-bid-form.html', 'bids.html',
  'react-app/app/(homeowner)/contract-signing/use-contract-signing-data.ts'];
for (const f of clientFiles) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { ok(false, `${f} not found: re-derive the client quote writes`); continue; }
  const src = fs.readFileSync(p, 'utf8');
  const bad = [...src.matchAll(/\.from\('quotes'\)\s*\.update\(\{([^}]*)\}\)/g)].filter((m) => /\b(claim_id|contractor_id|status|total_price)\s*:/.test(m[1]));
  ok(bad.length === 0, `${f}: no inline quotes UPDATE payload carries claim_id, contractor_id, status or total_price`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
