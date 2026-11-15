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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_NAME = 'gh3722_lead_goal_events_paid_click.sql';
const ROLLBACK_NAME = 'gh3722_lead_goal_events_paid_click_rollback.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').replace(/\s+/g, ' ');

const migPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'supabase/migrations_drafts', MIG_NAME);
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
ok(/\(l\.fbclid IS NOT NULL OR l\.fbc IS NOT NULL OR l\.gclid IS NOT NULL\) AS lead_has_click_id/i.test(sel), 'lead_has_click_id = fbclid, fbc or gclid present (M1: a gclid-only lead is a click-id lead)');
const paidExpr = (sel.match(/AS lead_has_click_id,(.*)AS lead_paid_click/i) || ['', ''])[1];
ok(/l\.gclid IS NOT NULL/i.test(paidExpr) && /l\.fbclid IS NOT NULL/i.test(paidExpr) && /l\.fbc IS NOT NULL/i.test(paidExpr), 'lead_paid_click includes fbclid, fbc and gclid (gclid-only lead is paid)');
ok(/l\.source = 'meta_leadgen'/i.test(paidExpr), "lead_paid_click counts source 'meta_leadgen' as paid (M2, Ben ruling)");
const mediumList = (paidExpr.match(/lower\(btrim\(coalesce\(l\.utm_medium, ''\)\)\) IN \(([^)]*)\)/i) || ['', ''])[1]
  .split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
ok(['paid', 'cpc', 'paid_social', 'paid-social', 'ppc', 'lead_form'].every((m) => mediumList.includes(m)), 'utm_medium list (trimmed, lower-cased) has paid, cpc, paid_social, paid-social, ppc, lead_form: ' + mediumList.join(','));
ok(mediumList.length === 6, 'no other medium values added');
// behavioural mirror of the predicate, evaluated on the cases the review named
const isPaid = (l) => !!(l.fbclid || l.fbc || l.gclid) || l.source === 'meta_leadgen' || mediumList.includes(String(l.utm_medium ?? '').trim().toLowerCase());
ok(isPaid({ gclid: 'x' }) === true, 'case: gclid-only lead is paid');
ok(isPaid({ source: 'meta_leadgen', utm_source: 'meta', utm_medium: 'lead_form' }) === true, 'case: meta_leadgen lead is paid');
ok(isPaid({ utm_medium: ' Paid-Social ' }) === true, 'case: whitespace/case-insensitive paid-social is paid');
ok(isPaid({ fbclid: 'x', utm_medium: 'paid' }) === true, 'case: fbclid + utm_medium paid is paid');
ok(isPaid({ utm_source: 'chatgpt.com', utm_medium: null, source: 'router' }) === false, 'control: organic chatgpt.com lead (147641e5) is not paid');
ok(isPaid({ utm_medium: 'organic' }) === false && isPaid({}) === false, 'control: organic / empty is not paid');
// click id never exposed raw
ok(!/l\.fbclid\s+AS\s/i.test(sel) && !/l\.gclid\s+AS\s/i.test(sel) && !/l\.fbc\s+AS\s/i.test(sel) && !/l\.fbp/i.test(sel), 'raw click id (fbclid/fbc) and fbp are not selected as columns');
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
const rbPath = path.join(ROOT, 'supabase/migrations_drafts', ROLLBACK_NAME);
ok(fs.existsSync(rbPath), 'rollback file exists');
const rb = fs.existsSync(rbPath) ? norm(fs.readFileSync(rbPath, 'utf8')) : '';
ok(/DROP VIEW IF EXISTS public\.lead_goal_events/i.test(rb) && !/lead_paid_click/.test(rb.replace(/COMMENT[^;]*;/gi, '')), 'rollback drops the view and recreates it without the new columns');

const cm = (fs.existsSync(rbPath) ? fs.readFileSync(rbPath, 'utf8') : '').match(/COMMENT ON VIEW public\.lead_goal_events IS\s*'(.*?)';/s);
const md5 = cm ? crypto.createHash('md5').update(cm[1].replace(/''/g, "'")).digest('hex') : '';
ok(md5 === 'b7874ae428d3d5a95e9ed4495d212997', 'rollback restores the live view comment word for word (md5 ' + md5 + ')');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
