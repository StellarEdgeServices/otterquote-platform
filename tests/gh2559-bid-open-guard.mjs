/**
 * gh-2559 (Ben #2569 6029315131 A / B.4) -- static checks on the DRAFT bid-open guard.
 *
 *   supabase/migrations_drafts/gh2559_claims_bid_open_guard.sql (+ _rollback.sql, _pre-flight.md)
 *   supabase/tests/gh2559_claims_bid_open_guard_proof.sql
 *   dashboard.html and react-app/app/(homeowner)/dashboard/actions.ts (the submit waits for the estimate to be read)
 *
 * Checks: the forward file is a separate trigger on public.claims for ready_for_bids = true, with the two conditions (unread estimate,
 * identity in a summary), NULL-safe, SECURITY DEFINER with a pinned search_path, EXECUTE revoked, no edit of any existing function;
 * the rollback drops exactly what the forward creates; the proof embeds both bodies byte-for-byte, carries the negative control (BEFORE phase
 * expects ACCEPTED) and ends in a forced RAISE; the refusal message is a marked PLACEHOLDER and both clients keep it null (no new
 * homeowner sentence); both clients wait for loss_sheet_parsed_at before the update; and no new file carries a 20+ hex literal.
 * It does not run SQL: tools/gh2559-bid-open-guard-behaviour.py does (pgserver).
 * Run: node tests/gh2559-bid-open-guard.mjs     GH2559_BIDOPEN_ROOT=<another tree> for a negative control (an empty tree or a checkout of main: the checks fail).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2559_BIDOPEN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }
function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } }

const F = read('supabase/migrations_drafts/gh2559_claims_bid_open_guard.sql');
const R = read('supabase/migrations_drafts/gh2559_claims_bid_open_guard_rollback.sql');
const PF = read('supabase/migrations_drafts/gh2559_claims_bid_open_guard_pre-flight.md');
const P = read('supabase/tests/gh2559_claims_bid_open_guard_proof.sql');
const D = read('dashboard.html');
const A = read('react-app/app/(homeowner)/dashboard/actions.ts');

ok(F.length > 0 && R.length > 0 && P.length > 0 && PF.length > 0, 'forward, rollback, pre-flight and proof exist');
ok(/^-- STATUS \(gh-1438, as of [0-9-]+\): NOT APPLIED/.test(F) && /DO NOT RUN FROM THIS DIRECTORY/.test(F), 'forward carries the gh-1438 STATUS header');
ok(/CREATE TRIGGER claims_guard_bid_open\s+BEFORE INSERT OR UPDATE OF[\s\S]*?ON public\.claims[\s\S]*?WHEN \(NEW\.ready_for_bids IS TRUE\)/.test(F), 'a separate BEFORE INSERT OR UPDATE trigger on public.claims for ready_for_bids = true');
ok(/gh2559_estimate_is_read\(NEW\.parsed_line_items, NEW\.loss_sheet_parsed_at\)/.test(F) && /NEW\.estimate_filename IS NOT NULL OR NEW\.has_estimate IS TRUE/.test(F), 'condition 1: an estimate on the claim must have been read into the summary');
ok(/COALESCE\(\s*p_parsed_at IS NOT NULL[\s\S]*?false\)/.test(F), 'the "read" predicate is NULL-safe (finding 4)');
ok(/profiles p WHERE p\.id = NEW\.user_id/.test(F) && /ARRAY\[NEW\.homeowner_name, v_owner\]/.test(F), 'condition 2 compares the profile name as well as claims.homeowner_name (finding 2)');
ok(/NEW\.parsed_line_items IS NOT DISTINCT FROM OLD\.parsed_line_items/.test(F), 'condition 2 also fires on summary/identity changes on an open claim (finding 3)');
ok(/SECURITY DEFINER\s+SET search_path = public, pg_temp/.test(F), 'trigger function is SECURITY DEFINER with a pinned search_path');
ok(/REVOKE EXECUTE ON FUNCTION public\.claims_guard_bid_open\(\) FROM PUBLIC, anon, authenticated/.test(F)
   && /REVOKE EXECUTE ON FUNCTION public\.gh2559_summary_identity_hit\(jsonb, text, text\[\], text, text\) FROM PUBLIC, anon, authenticated/.test(F)
   && /REVOKE EXECUTE ON FUNCTION public\.gh2559_estimate_is_read\(jsonb, timestamptz\) FROM PUBLIC, anon, authenticated/.test(F), 'EXECUTE revoked on all three functions');
ok(!/CREATE OR REPLACE FUNCTION public\.(claims_guard_award_columns|claims_guard_platform_fee_charged|claims_guard_referral_columns|claims_stamp_contractor_released_at)/.test(F), 'no existing claims function is re-created');
ok(/PLACEHOLDER-PENDING-BEN/.test(F) && (F.match(/PLACEHOLDER-PENDING-BEN/g) || []).length >= 2, 'both refusal messages are marked PLACEHOLDER-PENDING-BEN');
ok((F.match(/^BEGIN;/gm) || []).length === 1 && (F.match(/^COMMIT;/gm) || []).length === 1 && (R.match(/^BEGIN;/gm) || []).length === 1 && (R.match(/^COMMIT;/gm) || []).length === 1, 'one BEGIN/COMMIT in forward and rollback');
ok(!/\r/.test(F + R + P + PF), 'LF only');

// rollback drops exactly what the forward creates
const created = [...F.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort();
const dropped = [...R.matchAll(/DROP FUNCTION IF EXISTS public\.(\w+)\(/g)].map((m) => m[1]).sort();
ok(created.length === 3 && JSON.stringify(created) === JSON.stringify(dropped), 'rollback drops the same three functions the forward creates');
ok(/DROP TRIGGER IF EXISTS claims_guard_bid_open ON public\.claims/.test(R), 'rollback drops the trigger');

// proof embeds the bodies byte for byte
function body(t, start) { const i = t.indexOf(start); const j = t.lastIndexOf('COMMIT;'); if (i < 0 || j < 0) return null; return t.slice(i, j).replace(/COMMENT ON FUNCTION public\.claims_guard_bid_open\(\) IS\n  '[^;]*;\n\n/, '').replace(/^\n+|\n+$/g, '') + '\n'; }
const fb = body(F, '-- Condition 1 predicate.'), rb = body(R, 'DROP TRIGGER IF EXISTS claims_guard_bid_open');
ok(fb !== null && P.includes('$fwd$\n' + fb + '$fwd$'), 'proof embeds the forward body byte-for-byte');
ok(rb !== null && P.includes('$rb$\n' + rb + '$rb$'), 'proof embeds the rollback body byte-for-byte');
ok(/BEFORE = today's schema \(the forbidden cases must print ACCEPTED/.test(P) && /RAISE EXCEPTION E'GH2559 PROOF \(rolled back\)/.test(P), 'proof documents the negative control and ends in a forced RAISE');
ok(/is_test IS TRUE AND p\.is_test IS TRUE/.test(P) && !/INSERT INTO public\.claims/.test(P), 'proof uses an is_test fixture looked up at run time and inserts no claim');
ok(!/\b[0-9a-f]{20,}\b/i.test(F + R + P + PF), 'no 20+ hex literal (no real id) in the new SQL/markdown');

// clients: wait for the read, placeholder stays null, no new homeowner sentence
ok(/async function waitForEstimateRead\(claimId\)/.test(D) && /await waitForEstimateRead\(currentClaim\.id\);/.test(D) && /loss_sheet_parsed_at/.test(D), 'dashboard.html waits for loss_sheet_parsed_at before the submit update');
ok(/const BID_OPEN_REFUSAL_TEXT_PLACEHOLDER = null;/.test(D) && /showError\('Failed to submit your project\. Please try again\.'\);/.test(D), 'dashboard.html: refusal text is a null PLACEHOLDER; the existing failure line is unchanged');
ok(/export async function waitForEstimateRead\(/.test(A) && /await waitForEstimateRead\(claimId\);/.test(A) && /BID_OPEN_REFUSAL_TEXT_PLACEHOLDER: string \| null = null/.test(A), 'React actions.ts waits for the read; refusal text is a null PLACEHOLDER');
ok(D.indexOf('await waitForEstimateRead(currentClaim.id)') < D.indexOf(".update(submitUpdate)") && D.indexOf('await waitForEstimateRead(currentClaim.id)') > 0, 'dashboard.html: the wait comes before the update');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
