/**
 * gh-2931 -- public.bidder_claim_summary stops returning claims.estimate_filename (the stored path holds the homeowner's
 * original upload name). Static checks, no database:
 *   1. no client that reads the view names estimate_filename in a select list (static pages, React constants, the proof's lists);
 *      every list keeps has_estimate where it had it, so the "estimate available" badge still has its flag;
 *   2. the draft migration and its rollback exist, the forward CREATE VIEW has no `AS estimate_filename` column, keeps has_estimate,
 *      keeps every other output column in the live order (compared with the applied view file), and is DROP VIEW + CREATE VIEW
 *      (CREATE OR REPLACE VIEW cannot drop a column); the rollback restores the applied view's CREATE statement text;
 *   3. no PENDING draft that re-creates the view in this tree still returns the column (on main this passes vacuously; PR #2880 and
 *      PR #2925 carry the redefinitions and are checked by GH2931_ROOT against their trees).
 * Run: node tests/gh2931-bidder-summary-no-filename.mjs
 * GH2931_ROOT points at another tree for a negative control (a checkout of main before this PR: expect failures in 1; of PR #2880: failures in 3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2931_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ex = (p) => fs.existsSync(path.join(ROOT, p));
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

// 1. the column lists
const LISTS = [
  ['contractor-opportunities.html', /BIDDER_CLAIM_OPP_COLS = '([^']+)'/g],
  ['contractor-bid-form.html', /BIDDER_CLAIM_BID_COLS = '([^']+)'/g],
  ['contractor-dashboard.html', /BIDDER_CLAIM_(?:DASH|PEND)_COLS = '([^']+)'/g],
  ['react-app/app/contractor/opportunities/utils.ts', /BIDDER_CLAIM_OPP_COLS =\s*'([^']+)'/g],
  ['react-app/app/contractor/bid/[claimId]/utils.ts', /BIDDER_CLAIM_BID_COLS =\s*'([^']+)'/g],
  ['react-app/app/contractor/dashboard/utils.ts', /BIDDER_CLAIM_(?:DASH|PEND)_COLS = '([^']+)'/g],
  ['supabase/tests/gh2559_bidder_claims_view_proof.sql', /c_(?:opp|bid|dash|pend) +constant text := '([^']+)'/g],
];
for (const [file, re] of LISTS) {
  const s = rd(file); const found = []; let m;
  while ((m = re.exec(s))) found.push(m[1]);
  ok(found.length >= 1, `${file}: column list(s) found (${found.length})`);
  ok(found.every((l) => !/\bestimate_filename\b/.test(l)), `${file}: no list names estimate_filename`);
}
ok(/BIDDER_CLAIM_OPP_COLS = '[^']*\bhas_estimate\b/.test(rd('contractor-opportunities.html')) &&
   /BIDDER_CLAIM_OPP_COLS =\s*'[^']*\bhas_estimate\b/.test(rd('react-app/app/contractor/opportunities/utils.ts')),
   'opportunities lists keep has_estimate (the availability badge flag)');
ok(/estimateAvailable: !!claim\.has_estimate,/.test(rd('react-app/app/contractor/opportunities/utils.ts')) && !/estimateAvailable: !!\(claim\.estimate_filename/.test(rd('react-app/app/contractor/opportunities/utils.ts')),
   'React mapper: estimateAvailable reads has_estimate only');
// every bidder_claim_summary .select( in a client must not name the column inline either
for (const f of ['contractor-opportunities.html', 'contractor-bid-form.html', 'contractor-dashboard.html', 'react-app/app/contractor/dashboard/Messaging.tsx',
  'react-app/app/contractor/dashboard/use-dashboard-data.ts', 'react-app/app/contractor/opportunities/use-opportunities-data.ts', 'react-app/app/contractor/bid/[claimId]/page.tsx']) {
  const s = rd(f);
  const bad = [...s.matchAll(/from\((['"])bidder_claim_summary\1\)\s*\.select\((['"`])([^'"`]*)\2/g)].filter((m) => /estimate_filename/.test(m[3]));
  ok(bad.length === 0, `${f}: no inline select on bidder_claim_summary names estimate_filename`);
}

// 2. the draft migration and its rollback
const F = 'supabase/migrations_drafts/gh2931_bidder_summary_no_filename.sql';
const R = 'supabase/migrations_drafts/gh2931_bidder_summary_no_filename_rollback.sql';
ok(ex(F) && ex(R) && ex('supabase/tests/gh2931_bidder_summary_no_filename_proof.sql'), 'forward, rollback and proof files exist');
if (ex(F) && ex(R)) {
  const fwd = rd(F), rb = rd(R), applied = rd('supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql');
  const createOf = (s) => (s.match(/CREATE (?:OR REPLACE )?VIEW public\.bidder_claim_summary[\s\S]*?\bON true;?|CREATE (?:OR REPLACE )?VIEW public\.bidder_claim_summary[\s\S]*?\n   OR EXISTS \(SELECT 1 FROM public\.quotes q WHERE q\.claim_id = c\.id AND q\.contractor_id = ct\.id\);/) || [''])[0];
  const fc = createOf(fwd), ac = createOf(applied), rc = createOf(rb);
  ok(!!fc && !!ac && !!rc, 'CREATE VIEW statement found in the forward, rollback and applied files');
  ok(!/\bAS estimate_filename\b/.test(fc), 'forward: the view has no column AS estimate_filename');
  ok(/AS has_estimate,/.test(fc), 'forward: has_estimate is kept');
  ok(/^CREATE VIEW public\.bidder_claim_summary/.test(fc) && /^DROP VIEW public\.bidder_claim_summary;$/m.test(fwd) && !/CREATE OR REPLACE VIEW public\.bidder_claim_summary/.test(fwd),
    'forward: DROP VIEW + CREATE VIEW (CREATE OR REPLACE cannot drop a column)');
  ok(fc.replace(/^CREATE VIEW/, 'CREATE OR REPLACE VIEW') === ac.replace(/  CASE WHEN c\.selected_contractor_id = ct\.id THEN c\.estimate_filename END      AS estimate_filename,\n/, ''),
    'forward: the CREATE statement is the applied one with exactly the estimate_filename line removed');
  ok(rc.replace(/^CREATE VIEW/, 'CREATE OR REPLACE VIEW') === ac, 'rollback: the CREATE statement is the applied one, byte for byte');
  ok(/security_barrier = true/.test(fc) && /REVOKE ALL ON public\.bidder_claim_summary FROM anon;/.test(fwd) && /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.bidder_claim_summary FROM authenticated;/.test(fwd) && !/\bGRANT\b/.test(fwd.replace(/'[^']*'/g, '')),
    'forward: security_barrier, the same REVOKEs, no GRANT');
  ok(/c8ad94c45c52b5468ddf7c4979a2607c/.test(fwd) && /b0689f5f03d6d554371ff9dae871befb/.test(fwd) && /c8ad94c45c52b5468ddf7c4979a2607c/.test(rb), 'forward and rollback assert the definition md5s');
  ok(/STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(fwd.split('\n').slice(0, 12).join('\n')) && /STATUS \(gh-1438, as of [^)]+\): NOT APPLIED/.test(rb.split('\n').slice(0, 12).join('\n')),
    'both files carry the gh-1438 STATUS header in the first 12 lines');
}

// 3. other drafts in this tree that re-create the view
const dir = path.join(ROOT, 'supabase/migrations_drafts');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && !x.startsWith('gh2931_'))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  if (!/CREATE (?:OR REPLACE )?VIEW public\.bidder_claim_summary/.test(s)) continue;
  const isRollback = /_rollback\.sql$/.test(f);
  ok(!/AS estimate_filename\b/.test(s), `${f}: re-creates the view without the estimate_filename column${isRollback ? ' (rollback: restores the post-gh2931 shape)' : ''}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
