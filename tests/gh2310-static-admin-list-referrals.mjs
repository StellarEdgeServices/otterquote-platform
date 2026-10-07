/**
 * gh-2310 Gap 3 -- admin_list_referrals() must exclude test rows and test agents, and the nine legacy
 * referrals must be backfilled by exact id with a matching rollback.
 *
 * Before: sql/v98-admin-list-referrals.sql (the body live in production, md5 9da71c08...) has no is_test
 * predicate, so this script FAILS on it (negative control: `node tests/gh2310-static-admin-list-referrals.mjs sql/v98-admin-list-referrals.sql`).
 * After: the draft migration passes. The live proof is supabase/tests/gh2310_gap3_referrals_is_test_proof.sql
 * (rolled back, run by a human against production); CI never touches the database.
 * Run: node tests/gh2310-static-admin-list-referrals.mjs [function-file.sql]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DRAFTS = path.join(ROOT, 'supabase/migrations_drafts');
const RBK = path.join(ROOT, 'supabase/migrations_rollbacks');
const FN = 'gh2310_gap3_admin_list_referrals_is_test';
const BF = 'gh2310_gap3_backfill_referrals_is_test';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '').replace(/\s+/g, ' ');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

// ---- 1. the function predicate ----
const fnPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(DRAFTS, FN + '.sql');
ok(fs.existsSync(fnPath), `function file exists (${path.relative(ROOT, fnPath)})`);
const fn = norm(read(fnPath));
const body = (fn.match(/CREATE OR REPLACE FUNCTION public\.admin_list_referrals\(\).*\$function\$/i) || [''])[0];
ok(body !== '', 'admin_list_referrals() is (re)defined');
ok(/WHERE public\.is_admin_email\(\)/i.test(body), 'admin gate is_admin_email() is still the first WHERE term');
ok(/r\.is_test IS NOT TRUE/i.test(body), 'excludes referrals whose own is_test flag is true');
ok(/ra\.is_test IS NOT TRUE/i.test(body), 'excludes referrals under a test agent (and keeps unattributed rows: IS NOT TRUE, not = false)');
ok(!/ra\.is_test\s*=\s*false/i.test(body), 'does not use = false on the LEFT-JOINed flag (would drop unattributed rows)');
ok(/SECURITY DEFINER/i.test(body) && /search_path TO 'public', 'pg_temp'/i.test(body), 'stays SECURITY DEFINER with the pinned search_path');
ok(/LIMIT 1000/i.test(body) && /ORDER BY r\.created_at DESC/i.test(body), 'ORDER BY and LIMIT unchanged');
ok(/has_function_privilege\('anon'/i.test(fn), 'grants probe: anon must not execute');

// ---- 2. rollback restores the pre-fix body ----
const rbFn = norm(read(path.join(RBK, FN + '_rollback.sql')));
ok(/CREATE OR REPLACE FUNCTION public\.admin_list_referrals/i.test(rbFn) && !/is_test/i.test(rbFn), 'function rollback exists and carries no is_test predicate');
const v98 = norm(read(path.join(ROOT, 'sql/v98-admin-list-referrals.sql')));
ok(!/is_test/i.test(v98), 'before-state: the live-shaped v98 body has no is_test (the failing case)');

// ---- 3. the backfill ----
const bf = read(path.join(DRAFTS, BF + '.sql'));
const bfn = norm(bf);
const idsOf = (s) => [...(s.match(/ARRAY\[([^\]]*)\]/) || ['', ''])[1].matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1]);
const ids = idsOf(bfn);
ok(ids.length === 9 && new Set(ids).size === 9, 'backfill lists exactly 9 distinct ids');
ok(/array_length\(v_ids, 1\) <> 9/.test(bfn) && /array_length\(v_updated, 1\) <> 9/.test(bfn), 'backfill guard raises unless exactly 9 rows update');
ok(/UPDATE public\.referrals r SET is_test = true/i.test(bfn) && /r\.id = ANY \(v_ids\)/.test(bfn), 'backfill updates referrals by id list only');
ok(!/UPDATE public\.referral_agents|UPDATE public\.profiles|DELETE/i.test(bfn), 'backfill touches no other table and deletes nothing');
const rb = norm(read(path.join(RBK, BF + '_rollback.sql')));
const rbIds = [...rb.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map((m) => m[1]);
ok(rbIds.length === 9 && JSON.stringify([...rbIds].sort()) === JSON.stringify([...ids].sort()), 'rollback restores exactly the same 9 ids');
ok(/SET is_test = false/i.test(rb), 'rollback sets is_test back to false');

// ---- 4. no staff address in the new files ----
for (const f of [path.join(DRAFTS, BF + '.sql'), fnPath, path.join(RBK, BF + '_rollback.sql')]) {
  ok(!/[A-Za-z0-9._%+-]+@gmail\.com/i.test(read(f)), `no gmail literal in ${path.basename(f)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
