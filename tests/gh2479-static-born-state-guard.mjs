/**
 * gh-2479 -- born-state guard on claims and quotes.
 *
 * Production (second independent refuter, #2479 comment 6000637783): the guards of 20261003193000 and
 * 20261005170000 compare NEW to OLD on UPDATE only, so a client could INSERT a claim born
 * 'contract_signed' (or UPDATE its own claim to it) and a contractor could INSERT a quote born
 * 'selected' or flagged is_auto_bid, each enough for a $200 referral commission on a job that never
 * existed. Migration 20261005200000_gh2479_born_state_guard extends the two existing guard functions.
 *
 * This check reads the LATEST definition of each guard function across supabase/migrations (the file
 * that sorts last and contains CREATE OR REPLACE FUNCTION public.<name>()), not one fixed file. A later
 * migration that re-creates either function (for example to add the fee columns of #2519) must carry
 * every rule below or this check fails: two copies of one guard drift.
 *
 * The live proof is supabase/tests/gh2479_born_state_guard_proof.sql (rolled back, run by a human
 * against production). CI never touches the database.
 * Run: node tests/gh2479-static-born-state-guard.mjs [migration.sql]
 *      (argument = read both functions from that one file instead: the negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const MIG_NAME = '20261005200000_gh2479_born_state_guard.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const norm = (s) => stripSql(s).replace(/\s+/g, ' ');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
const only = process.argv[2] ? path.resolve(process.argv[2]) : null;

/** Latest definition of public.<fn>() and the file it is in. */
function latest(fn) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + fn + '\\(\\).*?\\$guard\\$;', 'i');
  const files = only ? [only] : migFiles.map((f) => path.join(MIG_DIR, f));
  let hit = { file: null, body: '', sql: '' };
  for (const f of files) {
    const sql = norm(read(f));
    const m = sql.match(re);
    if (m) hit = { file: f, body: m[0], sql };
  }
  return hit;
}
/** Latest CREATE TRIGGER <name> statement across the migrations. */
function latestTrigger(name) {
  const re = new RegExp('CREATE (?:OR REPLACE )?TRIGGER ' + name + ' [^;]*;', 'gi');
  const files = only ? [only] : migFiles.map((f) => path.join(MIG_DIR, f));
  let hit = { file: null, stmt: '' };
  for (const f of files) {
    const all = norm(read(f)).match(re);
    if (all) hit = { file: f, stmt: all[all.length - 1] };
  }
  return hit;
}
const rel = (f) => (f ? path.relative(ROOT, f) : '(none)');

ok(fs.existsSync(path.join(MIG_DIR, MIG_NAME)), `migration file exists (supabase/migrations/${MIG_NAME})`);

// ---- 1. claims: latest claims_guard_referral_columns() ----
const c = latest('claims_guard_referral_columns');
console.log('INFO: latest claims_guard_referral_columns() is in ' + rel(c.file));
ok(c.body !== '', 'guard function claims_guard_referral_columns() is defined');
ok(!/SECURITY DEFINER/i.test(c.body), 'claims guard is SECURITY INVOKER (current_user must be the caller)');
ok(/current_user IN \('anon', 'authenticated'\)/i.test(c.body) && /auth\.role\(\)[^;]*<> 'service_role'/i.test(c.body) && /is_admin_email\(\)/i.test(c.body),
  'claims guard applies to client roles and exempts service_role and admins');
// kept from 20261003193000
ok(/NEW\.created_at := now\(\)/i.test(c.body), 'KEPT: created_at is forced to server time on INSERT');
ok(/NEW\.referral_id IS DISTINCT FROM OLD\.referral_id/i.test(c.body) && /NEW\.completion_date IS DISTINCT FROM OLD\.completion_date/i.test(c.body)
  && /NEW\.created_at IS DISTINCT FROM OLD\.created_at/i.test(c.body), 'KEPT: referral_id, completion_date and created_at are frozen on UPDATE');
// born state
ok(/IF COALESCE\(NEW\.status NOT IN \('documents_needed', 'draft'\), true\)/i.test(c.body),
  'INSERT: status must be documents_needed or draft, and a NULL status refuses (fails closed)');
for (const col of ['selected_contractor_id', 'selected_bid_amount', 'completion_date', 'contract_signed_at']) {
  ok(new RegExp('OR NEW\\.' + col + ' IS NOT NULL').test(c.body), `INSERT: ${col} must be NULL`);
}
ok(!/NEW\.referral_id IS NOT NULL/i.test(c.body), 'INSERT: referral_id is NOT refused (the funnel stamps it on the new claim, #567)');
// status transitions
ok(/IF COALESCE\(NEW\.status IS DISTINCT FROM OLD\.status, true\) AND NOT COALESCE\(NEW\.status IN \('active', 'waitlisted', 'submitted', 'awarded'\), false\)/i.test(c.body),
  'UPDATE: status can change only to active, waitlisted, submitted or awarded (fails closed on NULL)');
ok(!/'contract_signed'/.test(c.body) && !/'bidding'/.test(c.body), 'the claims guard names neither contract_signed nor bidding as a client-reachable status');
ok((c.body.match(/USING ERRCODE = '42501'/gi) || []).length === 3, 'each of the three claims refusals raises 42501');
const ct = latestTrigger('claims_guard_referral_columns');
ok(/BEFORE INSERT OR UPDATE ON public\.claims FOR EACH ROW EXECUTE FUNCTION public\.claims_guard_referral_columns\(\)/i.test(ct.stmt),
  'trigger claims_guard_referral_columns is BEFORE INSERT OR UPDATE ON public.claims FOR EACH ROW (' + rel(ct.file) + ')');

// ---- 2. quotes: latest quotes_guard_homeowner_columns() ----
const q = latest('quotes_guard_homeowner_columns');
console.log('INFO: latest quotes_guard_homeowner_columns() is in ' + rel(q.file));
ok(q.body !== '', 'guard function quotes_guard_homeowner_columns() is defined');
ok(!/SECURITY DEFINER/i.test(q.body), 'quotes guard is SECURITY INVOKER');
ok(/current_user IN \('anon', 'authenticated'\)/i.test(q.body) && /auth\.role\(\)[^;]*<> 'service_role'/i.test(q.body) && /is_admin_email\(\)/i.test(q.body),
  'quotes guard applies to client roles and exempts service_role and admins');
ok(/IF TG_OP = 'INSERT' THEN/i.test(q.body), 'quotes guard has an INSERT arm');
ok(/IF NOT COALESCE\(EXISTS \( SELECT 1 FROM public\.contractors k WHERE k\.id = NEW\.contractor_id AND k\.user_id = auth\.uid\(\)\), false\)/i.test(q.body),
  'INSERT: the bid must name a contractor row of the caller (fails closed)');
ok(/COALESCE\(NEW\.status <> 'submitted', true\)/i.test(q.body), 'INSERT: status must be submitted, and a NULL status refuses');
ok(/COALESCE\(NEW\.bid_status <> 'active', true\)/i.test(q.body), 'INSERT: bid_status must be active');
ok(/OR NEW\.is_auto_bid IS TRUE/i.test(q.body), 'INSERT: is_auto_bid = true is refused (it skips the D-199 bid gate)');
for (const col of ['renewed_from_quote_id', 'homeowner_signed_at', 'contractor_signed_at', 'payment_status']) {
  ok(new RegExp('OR NEW\\.' + col + ' IS NOT NULL').test(q.body), `INSERT: ${col} must be NULL`);
}
// the INSERT arm must return before the UPDATE rules, which read OLD
const insArm = q.body.search(/IF TG_OP = 'INSERT' THEN/i), firstOld = q.body.search(/OLD\./);
const retInIns = q.body.slice(insArm, firstOld < 0 ? undefined : firstOld);
ok(insArm >= 0 && firstOld > insArm && /RETURN NEW; END IF;/i.test(retInIns), 'the INSERT arm returns before any rule that reads OLD');
// kept from 20261005170000
ok(/NEW\.claim_id IS DISTINCT FROM OLD\.claim_id/i.test(q.body) && /NEW\.contractor_id IS DISTINCT FROM OLD\.contractor_id/i.test(q.body),
  'KEPT: claim_id and contractor_id are frozen on UPDATE');
ok(/NEW\.total_price IS DISTINCT FROM OLD\.total_price/i.test(q.body) && /k\.id = OLD\.contractor_id AND k\.user_id = auth\.uid\(\)/i.test(q.body),
  'KEPT: total_price may change only for the quote\'s own contractor');
ok(/NEW\.status IN \('selected', 'declined'\)/i.test(q.body) && /c\.id = OLD\.claim_id AND c\.user_id = auth\.uid\(\)/i.test(q.body),
  'KEPT: status may change only to selected or declined, only for the claim owner');
ok((q.body.match(/USING ERRCODE = '42501'/gi) || []).length >= 5, 'every quotes refusal raises 42501 (two on INSERT, three or more on UPDATE)');
const qt = latestTrigger('quotes_guard_homeowner_columns');
ok(/BEFORE INSERT OR UPDATE ON public\.quotes FOR EACH ROW EXECUTE FUNCTION public\.quotes_guard_homeowner_columns\(\)/i.test(qt.stmt),
  'trigger quotes_guard_homeowner_columns is BEFORE INSERT OR UPDATE ON public.quotes FOR EACH ROW (' + rel(qt.file) + ')');
// on INSERT the D-199 gate must still fire first, and the guard must see the caller's values before the two that rewrite NEW
ok('quotes_enforce_bid_can_submit' < 'quotes_guard_homeowner_columns' && 'quotes_guard_homeowner_columns' < 'quotes_normalize_fee_amount'
  && 'quotes_guard_homeowner_columns' < 'set_updated_at_quotes', 'trigger name sorts after quotes_enforce_bid_can_submit and before quotes_normalize_fee_amount / set_updated_at_quotes');

// ---- 3. this migration is protective only and adds no parallel guard ----
const own = norm(read(path.join(MIG_DIR, MIG_NAME)));
ok(!/\b(GRANT|REVOKE|CREATE POLICY|DROP POLICY|ALTER POLICY|ALTER TABLE|DROP TRIGGER|DROP FUNCTION|DISABLE TRIGGER)\b/i.test(own),
  'migration has no GRANT, REVOKE, policy, table change or DROP');
ok((own.match(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(\)/gi) || []).length === 2 && /claims_guard_referral_columns/.test(own) && /quotes_guard_homeowner_columns/.test(own),
  'migration replaces exactly the two existing guard functions and creates no new one');
ok((own.match(/CREATE (OR REPLACE )?TRIGGER/gi) || []).length === 1 && /CREATE OR REPLACE TRIGGER quotes_guard_homeowner_columns/i.test(own),
  'migration creates no new trigger: it widens quotes_guard_homeowner_columns in place');
ok(own.indexOf('CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()') < own.indexOf('CREATE OR REPLACE TRIGGER quotes_guard_homeowner_columns'),
  'the quotes function is replaced before its trigger is widened to INSERT');
ok(!/apply_referral_commission|self.?referral/i.test(own), 'migration does not touch apply_referral_commission and builds no self-referral rule');
ok(!/fee_amount|fee_percentage|platform_fee/i.test(own), 'migration does not touch the fee columns (gh-2519, PR #2538)');
const ownRaw = read(path.join(MIG_DIR, MIG_NAME));
ok(/^BEGIN;/m.test(ownRaw) && /^COMMIT;/m.test(ownRaw), 'migration is wrapped in BEGIN/COMMIT');

// ---- 4. only one guard trigger per table, in every migration ----
const guardTriggers = { claims: new Set(), quotes: new Set() };
for (const f of migFiles) {
  for (const m of norm(read(path.join(MIG_DIR, f))).matchAll(/CREATE (?:OR REPLACE )?TRIGGER ([a-z_]*guard[a-z_]*) BEFORE [A-Z ]+ ON public\.(claims|quotes)\b/gi)) {
    guardTriggers[m[2].toLowerCase()].add(m[1]);
  }
}
ok([...guardTriggers.quotes].join(',') === 'quotes_guard_homeowner_columns',
  'quotes carries exactly one guard trigger across all migrations (found: ' + [...guardTriggers.quotes].join(', ') + ')');
ok(guardTriggers.claims.has('claims_guard_referral_columns'), 'claims_guard_referral_columns is among the claims guard triggers (found: ' + [...guardTriggers.claims].join(', ') + ')');

// ---- 5. rollback, pre-flight, proof ----
const rbPath = path.join(ROOT, 'supabase/migrations_rollbacks', MIG_NAME.replace(/\.sql$/, '_rollback.sql'));
ok(fs.existsSync(rbPath), 'rollback file exists in supabase/migrations_rollbacks/');
const rb = norm(read(rbPath));
const body = (sql, fn) => (sql.match(new RegExp('CREATE OR REPLACE FUNCTION public\\.' + fn + '\\(\\).*?\\$guard\\$;', 'i')) || [''])[0];
const prevQuotes = norm(read(path.join(MIG_DIR, '20261005170000_gh2479_quotes_homeowner_guard.sql')));
const prevClaims = norm(read(path.join(MIG_DIR, '20261003193000_gh2479_referral_guard_and_commission_checks.sql')));
ok(body(rb, 'quotes_guard_homeowner_columns') !== '' && body(rb, 'quotes_guard_homeowner_columns') === body(prevQuotes, 'quotes_guard_homeowner_columns'),
  'rollback restores quotes_guard_homeowner_columns() to the body of 20261005170000 exactly');
ok(body(rb, 'claims_guard_referral_columns') !== '' && body(rb, 'claims_guard_referral_columns') === body(prevClaims, 'claims_guard_referral_columns'),
  'rollback restores claims_guard_referral_columns() to the body of 20261003193000 exactly');
ok(/CREATE OR REPLACE TRIGGER quotes_guard_homeowner_columns BEFORE UPDATE ON public\.quotes FOR EACH ROW/i.test(rb)
  && rb.indexOf('CREATE OR REPLACE TRIGGER quotes_guard_homeowner_columns') < rb.indexOf('CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()'),
  'rollback narrows the quotes trigger back to BEFORE UPDATE before it restores the function');
ok(!/\b(DROP TRIGGER|DROP FUNCTION|DISABLE TRIGGER|GRANT|REVOKE)\b/i.test(rb), 'rollback drops nothing: the guards of the two earlier migrations stay');
ok(fs.existsSync(path.join(MIG_DIR, MIG_NAME.replace(/\.sql$/, '_pre-flight.md'))), 'pre-flight note exists next to the migration');
ok(fs.existsSync(path.join(ROOT, 'supabase/tests/gh2479_born_state_guard_proof.sql')), 'rolled-back proof file exists in supabase/tests/');

// ---- 6. the client still sends only what the guard allows ----
/** Text of the object literal that follows the first `.from('<table>') ... .insert(` at or after `from`. */
function insertPayloads(src, table) {
  const out = [];
  const re = new RegExp("\\.from\\(\\s*['\"]" + table + "['\"]\\s*\\)\\s*\\.insert\\(", 'g');
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length, depth = 1;
    const start = i;
    for (; i < src.length && depth > 0; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; }
    out.push(src.slice(start, i - 1));
  }
  return out;
}
const lateClaimKeys = /\b(status|selected_contractor_id|selected_bid_amount|completion_date|contract_signed_at)\s*:/;
for (const f of ['trade-selector.html', 'react-app/app/trade-selector/page.tsx']) {
  const src = read(path.join(ROOT, f));
  const ins = insertPayloads(src, 'claims');
  ok(src !== '' && ins.length === 1, `${f}: exactly one claims INSERT (found ${ins.length})`);
  ok(ins.every((p) => !lateClaimKeys.test(stripJs(p))), `${f}: the claims INSERT payload carries no status, selected contractor, bid amount, signing or completion key`);
  // the shared payload object spread into the INSERT (claimData / claimPayload) must not carry them either
  const shared = (src.match(/const (?:claimData|claimPayload)(?:: [^=]+)? = \{([\s\S]*?)\n\s*\};/) || ['', ''])[1];
  ok(shared !== '' && !lateClaimKeys.test(stripJs(shared)), `${f}: the shared claim payload carries none of those keys`);
}
function stripJs(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); }
const lateQuoteKeys = /\b(status|bid_status|renewed_from_quote_id|homeowner_signed_at|contractor_signed_at|payment_status)\s*:/;
{
  const src = read(path.join(ROOT, 'contractor-bid-form.html'));
  const qd = (src.match(/const quoteData = \{([\s\S]*?)\n\s*\};/) || ['', ''])[1];
  ok(qd !== '', 'contractor-bid-form.html: quoteData (the quotes INSERT payload) found');
  ok(!lateQuoteKeys.test(stripJs(qd)) && /is_auto_bid: false/.test(qd), 'contractor-bid-form.html: quoteData sends is_auto_bid: false and no status, bid_status, renewal, signing or payment key');
  ok(insertPayloads(src, 'quotes').every((p) => p.trim() === 'quoteData'), 'contractor-bid-form.html: the only quotes INSERT sends quoteData');
}
{
  const src = read(path.join(ROOT, 'react-app/app/contractor/bid/[claimId]/utils.ts'));
  const bi = (src.match(/export function buildQuoteInsert\([^)]*\)[^{]*\{\s*return \{([\s\S]*?)\n\s*\};/) || ['', ''])[1];
  ok(bi !== '', 'react bid utils.ts: buildQuoteInsert() found');
  ok(!lateQuoteKeys.test(stripJs(bi)) && /is_auto_bid: false/.test(bi), 'react bid utils.ts: buildQuoteInsert() sends is_auto_bid: false and no status, bid_status, renewal, signing or payment key');
}
// claims.status values written by browser code: only the four the guard allows
const allowedStatus = new Set(['active', 'waitlisted', 'submitted', 'awarded']);
const statusWriters = ['dashboard.html', 'repair-intake.html', 'bids.html', 'trade-selector.html', 'project-confirmation.html', 'contract-signing.html',
  'react-app/app/(homeowner)/dashboard/actions.ts', 'react-app/app/(homeowner)/bids/actions.ts',
  'react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts', 'react-app/app/trade-selector/page.tsx'];
for (const f of statusWriters) {
  const src = stripJs(read(path.join(ROOT, f)));
  if (src === '') { ok(false, `${f} not found: re-derive the client writes of claims.status before changing the guard`); continue; }
  const found = new Set();
  // inline payloads: .from('claims') ... .update({ ... status: 'x' ... })
  for (const m of src.matchAll(/\.from\(\s*['"]claims['"]\s*\)\s*\.update\(\s*\{([^}]*)\}/g)) {
    const s = m[1].match(/\bstatus:\s*['"]([a-z_]+)['"]/); if (s) found.add(s[1]);
  }
  // named payloads used by the submit-for-bids writes
  for (const m of src.matchAll(/(?:submitUpdate|update)(?::\s*Record<string, unknown>)?\s*=\s*\{\s*status:\s*['"]([a-z_]+)['"]/g)) found.add(m[1]);
  const bad = [...found].filter((s) => !allowedStatus.has(s));
  ok(bad.length === 0, `${f}: claims.status is written only as active / waitlisted / submitted / awarded (found: ${[...found].join(', ') || 'none'})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
