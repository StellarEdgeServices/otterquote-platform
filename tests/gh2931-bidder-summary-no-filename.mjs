/**
 * gh-2931 -- public.bidder_claim_summary hands out claims.estimate_filename and claims.measurements_filename (the stored paths; the estimate path holds the
 * homeowner's original upload name) only to the selected contractor AND only once claims.platform_fee_charged IS TRUE (D-386). Static checks, no database:
 *   1. the draft forward file is CREATE OR REPLACE VIEW (the column set is unchanged) and its statement is the applied view
 *      (20261008231303) with exactly two clauses changed: the estimate_filename and measurements_filename CASEs each gain `AND c.platform_fee_charged IS TRUE`;
 *   2. the rollback statement is the applied statement byte for byte; both files assert the definition md5s and carry the STATUS header;
 *   3. every other draft in the tree that re-creates the view carries both gated CASEs (tripwire for PR #2880 and PR #2925, which
 *      would otherwise put the pre-fee path back). Vacuous on main; GH2931_ROOT can point at the PR trees.
 * Run: node tests/gh2931-bidder-summary-no-filename.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2931_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ex = (p) => fs.existsSync(path.join(ROOT, p));
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const OLD = '  CASE WHEN c.selected_contractor_id = ct.id THEN c.estimate_filename END      AS estimate_filename,\n';
const NEW = '  CASE WHEN c.selected_contractor_id = ct.id AND c.platform_fee_charged IS TRUE THEN c.estimate_filename END AS estimate_filename,\n';
const OLDM = '  CASE WHEN c.selected_contractor_id = ct.id THEN c.measurements_filename END  AS measurements_filename';
const NEWM = '  CASE WHEN c.selected_contractor_id = ct.id AND c.platform_fee_charged IS TRUE THEN c.measurements_filename END AS measurements_filename';
const GATED = /WHEN c\.selected_contractor_id = ct\.id AND c\.platform_fee_charged IS TRUE THEN c\.estimate_filename[\s\S]*WHEN c\.selected_contractor_id = ct\.id AND c\.platform_fee_charged IS TRUE THEN c\.measurements_filename|WHEN c\.selected_contractor_id = ct\.id AND c\.platform_fee_charged IS TRUE THEN c\.estimate_filename END\s+AS estimate_filename,\s*\n\s*CASE WHEN c\.selected_contractor_id = ct\.id AND c\.platform_fee_charged IS TRUE THEN c\.measurements_filename/;

const F = 'supabase/migrations_drafts/gh2931_bidder_summary_no_filename.sql';
const R = 'supabase/migrations_drafts/gh2931_bidder_summary_no_filename_rollback.sql';
ok(ex(F) && ex(R) && ex('supabase/tests/gh2931_bidder_summary_no_filename_proof.sql'), 'forward, rollback and proof files exist');
if (ex(F) && ex(R)) {
  const fwd = rd(F), rb = rd(R), applied = rd('supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql');
  const createOf = (s) => { const i = s.search(/CREATE (?:OR REPLACE )?VIEW public\.bidder_claim_summary/); const t = '\n   OR EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = c.id AND q.contractor_id = ct.id);'; const j = s.indexOf(t, i); return i < 0 || j < 0 ? '' : s.slice(i, j + t.length); };
  const fc = createOf(fwd), ac = createOf(applied), rc = createOf(rb);
  ok(!!fc && !!ac && !!rc, 'CREATE statement found in the forward, rollback and applied files');
  ok(/^CREATE OR REPLACE VIEW/.test(fc) && !/DROP VIEW/.test(fwd.replace(/--[^\n]*/g, '')), 'forward: CREATE OR REPLACE VIEW, no DROP VIEW (same column set)');
  ok(ac.split(OLD).length === 2 && fc === ac.replace(OLD, NEW).replace(OLDM, NEWM) && ac.includes(OLDM), 'forward: the applied statement with exactly the estimate_filename and measurements_filename CASEs changed');
  ok(GATED.test(fc) && /AS has_estimate,/.test(fc), 'forward: gated CASE present, has_estimate unchanged');
  ok(rc === ac, 'rollback: the statement is the applied one, byte for byte');
  ok(/c8ad94c45c52b5468ddf7c4979a2607c/.test(fwd) && /7b0f2430b1cb7482ac34af28e17553db/.test(fwd) && /c8ad94c45c52b5468ddf7c4979a2607c/.test(rb), 'forward and rollback assert the definition md5s');
  ok(!/\bGRANT\b/.test(fwd.replace(/'[^']*'/g, '').replace(/--[^\n]*/g, '')), 'forward: no GRANT');
  const hdr = (s) => s.split('\n').slice(0, 12).join('\n');
  ok(/STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(hdr(fwd)) && /STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(hdr(rb)), 'both files carry the gh-1438 STATUS header');
}
const dir = path.join(ROOT, 'supabase/migrations_drafts');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && !x.startsWith('gh2931_'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/CREATE (?:OR REPLACE )?VIEW public\.bidder_claim_summary/.test(s)) continue;
  ok(GATED.test(s), `${f}: re-creates the view with the fee-gated estimate_filename CASE`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
