/**
 * gh-3722 (P12) -- public.lead_goal_events must expose lead_utm_source, lead_utm_medium,
 * lead_has_click_id and lead_paid_click so a goal can be classed paid vs organic, without
 * exposing the click id and without disturbing the existing ten columns.
 *
 * Static check of the migration text (CI never touches the database). The live proof is
 * supabase/tests/gh3722_lead_goal_paid_click_proof.sql, a rolled-back run a human does.
 * Run: node tests/gh3722-static-lead-goal-attribution.mjs [migration.sql]   (argument = negative control)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_NAME = '20261115172000_gh3722_lead_goal_events_paid_click.sql';
const ROLLBACK_NAME = '20261115172000_gh3722_lead_goal_events_paid_click_rollback.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').replace(/\s+/g, ' ');

const migPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'supabase/migrations', MIG_NAME);
ok(fs.existsSync(migPath), `migration file exists (${path.relative(ROOT, migPath)})`);
const sql = fs.existsSync(migPath) ? norm(fs.readFileSync(migPath, 'utf8')) : '';

const viewSql = (sql.match(/CREATE OR REPLACE VIEW public\.lead_goal_events.*?ORDER BY l\.id[^;]*;/i) || [''])[0];
ok(viewSql !== '', 'redefines public.lead_goal_events with CREATE OR REPLACE VIEW');
ok(/security_invoker = true/i.test(viewSql), 'view stays security_invoker');

// existing ten columns keep name and order, new four are appended after goal_type
const sel = (viewSql.match(/SELECT DISTINCT ON \(l\.id\)(.*?) FROM public\.leads l/i) || ['', ''])[1];
const aliases = sel.split(/,(?![^(]*\))/).map((c) => (c.match(/\bAS (\w+)\s*$/i) || c.match(/\.(\w+)\s*$/) || [, ''])[1].trim());
const expected = ['lead_id', 'converted_user_id', 'lead_source', 'lead_utm_campaign', 'lead_variant', 'claim_id',
  'first_hover_order_at', 'loss_sheet_parsed_at', 'goal_at', 'goal_type',
  'lead_utm_source', 'lead_utm_medium', 'lead_has_click_id', 'lead_paid_click'];
ok(aliases.join() === expected.join(),
  'select list = existing ten columns in order, then the four new columns appended: ' + aliases.join(','));
ok(aliases.length === 14, 'exactly 14 output columns');

ok(/l\.utm_source AS lead_utm_source/i.test(sel), 'lead_utm_source reads leads.utm_source');
ok(/l\.utm_medium AS lead_utm_medium/i.test(sel), 'lead_utm_medium reads leads.utm_medium');
ok(/\(l\.fbclid IS NOT NULL OR l\.fbc IS NOT NULL\) AS lead_has_click_id/i.test(sel), 'lead_has_click_id = fbclid or fbc present');
ok(/lead_paid_click/.test(sel) && /lower\(coalesce\(l\.utm_medium, ''\)\) IN \('paid', 'cpc', 'paid_social', 'ppc'\)/i.test(sel)
  && /\(l\.fbclid IS NOT NULL OR l\.fbc IS NOT NULL\)\s*OR/i.test(sel), 'lead_paid_click = click id OR utm_medium in paid/cpc/paid_social/ppc');
// click id never exposed raw
ok(!/l\.fbclid\s+AS\s/i.test(sel) && !/l\.fbc\s+AS\s/i.test(sel) && !/l\.fbp/i.test(sel), 'raw click id (fbclid/fbc) and fbp are not selected as columns');
// PII-free: no email / name / phone / address
ok(!/l\.(email|first_name|last_name|name|phone|property_address|ip|user_agent)\b/i.test(sel), 'no PII column selected');

// carried-over S16 predicates must survive
ok(/homeowner_stripe_payment_intent_id IS NOT NULL AND ho\.homeowner_charge_amount > 0/i.test(viewSql), 'D1 payment filter preserved');
ok(/g\.claim_goal_at >= l\.created_at/i.test(viewSql), 'D5 time-order guard preserved');

// access stays service_role only
ok(/REVOKE ALL ON public\.lead_goal_events FROM PUBLIC, anon, authenticated/i.test(sql), 'REVOKE from PUBLIC/anon/authenticated');
ok(/GRANT SELECT ON public\.lead_goal_events TO service_role/i.test(sql), 'GRANT SELECT to service_role');
ok(!/GRANT[^;]*lead_goal_events[^;]*(anon|authenticated)/i.test(sql.replace(/REVOKE[^;]*;/gi, '')), 'no grant to anon/authenticated');
ok(!/ALTER TABLE|ADD COLUMN|DROP TABLE|DROP VIEW/i.test(sql), 'migration changes no table and does not drop the view');

// rollback exists and restores the ten-column view
const rbPath = path.join(ROOT, 'supabase/migrations_rollbacks', ROLLBACK_NAME);
ok(fs.existsSync(rbPath), 'rollback file exists');
const rb = fs.existsSync(rbPath) ? norm(fs.readFileSync(rbPath, 'utf8')) : '';
ok(/DROP VIEW IF EXISTS public\.lead_goal_events/i.test(rb) && !/lead_paid_click/.test(rb.replace(/COMMENT[^;]*;/gi, '')), 'rollback drops the view and recreates it without the new columns');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
