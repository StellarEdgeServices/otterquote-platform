/**
 * gh-2559 fee leg / D-386 -- static checks on the DRAFT migration that gates the selected contractor's read of the
 * homeowner's claim files on fee collection.
 *
 *   supabase/migrations_drafts/gh2559_claim_docs_fee_gate.sql           (forward)
 *   supabase/migrations_drafts/gh2559_claim_docs_fee_gate_rollback.sql  (rollback)
 *   supabase/tests/gh2559_claim_docs_fee_gate_proof.sql                 (self-rolling-back proof)
 *
 * Checks: the forward policy keeps the selected-contractor leg and adds "platform_fee_charged IS TRUE" (the signal that
 * only service_role / admin can write, gh-2491) and has no bidding leg; the rollback is exactly the policy text live
 * today (no fee condition); the proof embeds the two bodies byte-for-byte, fails closed on a non-is_test fixture,
 * INSERTs nothing, and ends in a forced RAISE; and no new file carries a 20+ hex literal.
 *
 * It does not run SQL. The behavioural run (BEFORE / AFTER / rollback matrix) is the proof file, run on a throwaway
 * Postgres or, with the owner's go-ahead, on production as a forced rollback.
 * Run: node tests/gh2559-claim-docs-fee-gate.mjs
 * GH2559_FEEGATE_ROOT points at another tree for a negative control (a checkout of main: every check fails).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2559_FEEGATE_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }
function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } }

const F = 'supabase/migrations_drafts/gh2559_claim_docs_fee_gate.sql';
const R = 'supabase/migrations_drafts/gh2559_claim_docs_fee_gate_rollback.sql';
const P = 'supabase/tests/gh2559_claim_docs_fee_gate_proof.sql';
const PF = 'supabase/migrations_drafts/gh2559_claim_docs_fee_gate_pre-flight.md';
const fwd = read(F), rb = read(R), proof = read(P), pre = read(PF);

function body(sql) {
  return sql.split('\n')
    .filter((l) => !l.trim().startsWith('--') && !['BEGIN;', 'COMMIT;'].includes(l.trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}
function policy(sql) {
  const m = sql.match(/CREATE POLICY "Contractors can view biddable claim docs"[\s\S]*?\n\);/);
  return m ? m[0] : '';
}

ok(fwd.length > 0 && rb.length > 0 && proof.length > 0 && pre.length > 0, 'forward, rollback, pre-flight and proof files exist');

const fp = policy(fwd), rp = policy(rb);
ok(/c\.selected_contractor_id = ct\.id/.test(fp), 'forward keeps the selected-contractor leg');
ok(/AND c\.platform_fee_charged IS TRUE/.test(fp), 'forward requires claims.platform_fee_charged IS TRUE (NULL and false both refuse)');
ok(!/ready_for_bids|is_test/.test(fp), 'forward adds no bidding leg and no world fence (bidders stay at zero raw objects)');
ok(/ON storage\.objects FOR SELECT\s+TO authenticated/.test(fp) && /bucket_id = 'claim-documents'/.test(fp), 'forward keeps the policy command, role and bucket test');
ok(/DROP POLICY IF EXISTS "Contractors can view biddable claim docs" ON storage\.objects;/.test(fwd), 'forward replaces exactly one policy');
ok((fwd.match(/CREATE POLICY/g) || []).length === 1 && (fwd.match(/DROP POLICY/g) || []).length === 1, 'forward drops and creates exactly one policy');
ok(!/\b(ALTER|INSERT|UPDATE|DELETE|GRANT|REVOKE|TRUNCATE)\b/.test(body(fwd).replace(/'[^']*'/g, "''")), 'forward touches no table, row or grant (statements only: DROP/CREATE POLICY and a check)');
ok(/STATUS \(gh-1438, as of [^)]*\): NOT APPLIED/.test(fwd) && /STATUS \(gh-1438, as of [^)]*\): NOT APPLIED/.test(rb), 'forward and rollback carry the NOT APPLIED status header');
ok(/D-386/.test(fwd) && /R-097|Tier: 3B/.test(fwd), 'forward names D-386 and the Tier 3B path');

ok(/c\.selected_contractor_id = ct\.id/.test(rp) && !/platform_fee_charged/.test(rp), 'rollback restores the selected-contractor policy with no fee condition (the text live today)');
ok(/ready_for_bids/.test(rp) === false, 'rollback does not bring the bidding leg back');

ok(proof.includes('$fwd$\n' + body(fwd) + '\n$fwd$'), 'proof embeds the forward body byte-for-byte');
ok(proof.includes('$rb$\n' + body(rb) + '\n$rb$'), 'proof embeds the rollback body byte-for-byte');
ok(/RAISE EXCEPTION E'gh2559 fee-gate proof \(rolled back\)[^']*'[^;]*ERRCODE = 'P0U01'/.test(proof), 'proof ends in a forced RAISE (rolls back everything)');
ok(/FIXTURE NOT is_test/.test(proof) && /P0U02/.test(proof), 'proof fails closed when a fixture is not is_test');
ok(/is_test IS TRUE/.test(proof) && !/SET\s+is_test/i.test(proof), 'proof selects fixtures is_test only and never flips is_test');
ok(!/\bINSERT\s+INTO\b/i.test(proof.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')), 'proof inserts nothing (only role-switched SELECTs and rolled-back UPDATEs of one is_test claim)');
for (const c of ['C1 ', 'C2 ', 'C3 ', 'C4 ', 'C5 ', 'C6 ', 'C7 ', 'C8 ', 'C9 ', 'V1 ', 'A1 ']) {
  ok(proof.includes("'" + c), 'proof has case ' + c.trim());
}
ok(/\blive\b.*\bgated\b/.test(proof) && /after rollback/.test(proof), 'proof prints LIVE / GATED / after-rollback verdicts');

const hex = /\b[0-9a-fA-F]{20,}\b/;
ok(![fwd, rb, proof, pre].some((t) => hex.test(t)), 'no 20+ hex literal in any new file');
ok(/D-386/.test(pre) && /Phone and email/i.test(pre) && /BEFORE/.test(pre) && /AFTER/.test(pre), 'pre-flight states D-386, the phone/email finding and the BEFORE/AFTER cases');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
