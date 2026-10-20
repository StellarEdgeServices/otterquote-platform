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
const PL = read('supabase/functions/parse-loss-sheet/index.ts');
const EK = read('supabase/functions/parse-loss-sheet/estimate-kind.ts');
const A = read('react-app/app/(homeowner)/dashboard/actions.ts');

ok(F.length > 0 && R.length > 0 && P.length > 0 && PF.length > 0, 'forward, rollback, pre-flight and proof exist');
ok(/^-- STATUS \(gh-1438, as of [0-9-]+\): NOT APPLIED/.test(F) && /DO NOT RUN FROM THIS DIRECTORY/.test(F), 'forward carries the gh-1438 STATUS header');
ok(/CREATE TRIGGER claims_guard_bid_open\s+BEFORE INSERT OR UPDATE OF[\s\S]*?ON public\.claims[\s\S]*?WHEN \(NEW\.ready_for_bids IS TRUE\)/.test(F), 'a separate BEFORE INSERT OR UPDATE trigger on public.claims for ready_for_bids = true');
ok(/gh2559_estimate_is_read\(NEW\.parsed_line_items, NEW\.loss_sheet_parsed_at\)/.test(F) && /NEW\.estimate_filename IS NOT NULL OR NEW\.has_estimate IS TRUE/.test(F), 'condition 1: an estimate on the claim must have been read into the summary');
ok(/COALESCE\(\s*p_parsed_at IS NOT NULL[\s\S]*?false\)/.test(F), 'the "read" predicate is NULL-safe (finding 4)');
ok(/profiles p WHERE p\.id = NEW\.user_id/.test(F) && /ARRAY\[NEW\.homeowner_name, v_owner\]/.test(F), 'condition 2 compares the profile name as well as claims.homeowner_name (finding 2)');
ok(/NEW\.parsed_line_items IS NOT DISTINCT FROM OLD\.parsed_line_items/.test(F), 'condition 2 also fires on summary/identity changes on an open claim (finding 3)');
ok(/SECURITY DEFINER\s+SET search_path = public, pg_temp/.test(F), 'trigger function is SECURITY DEFINER with a pinned search_path');
ok(/REVOKE EXECUTE ON FUNCTION public\.claims_estimate_parse_state_guard\(\) FROM PUBLIC, anon, authenticated/.test(F) && /REVOKE EXECUTE ON FUNCTION public\.claims_guard_bid_open\(\) FROM PUBLIC, anon, authenticated/.test(F)
   && /REVOKE EXECUTE ON FUNCTION public\.gh2559_summary_identity_hit\(jsonb, text, text\[\], text, text\) FROM PUBLIC, anon, authenticated/.test(F)
   && /REVOKE EXECUTE ON FUNCTION public\.gh2559_estimate_is_read\(jsonb, timestamptz\) FROM PUBLIC, anon, authenticated/.test(F), 'EXECUTE revoked on all four functions');
ok(!/CREATE OR REPLACE FUNCTION public\.(claims_guard_award_columns|claims_guard_platform_fee_charged|claims_guard_referral_columns|claims_stamp_contractor_released_at)/.test(F), 'no existing claims function is re-created');
ok(/PLACEHOLDER-PENDING-BEN/.test(F) && (F.match(/PLACEHOLDER-PENDING-BEN/g) || []).length >= 2, 'both refusal messages are marked PLACEHOLDER-PENDING-BEN');
ok((F.match(/^BEGIN;/gm) || []).length === 1 && (F.match(/^COMMIT;/gm) || []).length === 1 && (R.match(/^BEGIN;/gm) || []).length === 1 && (R.match(/^COMMIT;/gm) || []).length === 1, 'one BEGIN/COMMIT in forward and rollback');
ok(!/\r/.test(F + R + P + PF), 'LF only');

// rollback drops exactly what the forward creates
const created = [...F.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]).sort();
const dropped = [...R.matchAll(/DROP FUNCTION IF EXISTS public\.(\w+)\(/g)].map((m) => m[1]).sort();
ok(created.length === 4 && JSON.stringify(created) === JSON.stringify(dropped), 'rollback drops the same four functions the forward creates');
ok(/DROP TRIGGER IF EXISTS claims_guard_bid_open ON public\.claims/.test(R) && /DROP TRIGGER IF EXISTS claims_guard_a0_parse_state ON public\.claims/.test(R) && /DROP COLUMN IF EXISTS loss_sheet_parse_status/.test(R), 'rollback drops both triggers and the additive column');

// proof embeds the bodies byte for byte
function body(t, start) { const i = t.indexOf(start); const j = t.lastIndexOf('COMMIT;'); if (i < 0 || j < 0) return null; return t.slice(i, j).replace(/COMMENT ON FUNCTION public\.claims_guard_bid_open\(\) IS\n  '[^;]*;\n\n/, '').replace(/^\n+|\n+$/g, '') + '\n'; }
const fb = body(F, '-- Schema: parse status column'), rb = body(R, 'DROP TRIGGER IF EXISTS claims_guard_bid_open');
ok(fb !== null && P.includes('$fwd$\n' + fb + '$fwd$'), 'proof embeds the forward body byte-for-byte');
ok(rb !== null && P.includes('$rb$\n' + rb + '$rb$'), 'proof embeds the rollback body byte-for-byte');
ok(/BEFORE = today's schema \(the forbidden cases must print ACCEPTED/.test(P) && /RAISE EXCEPTION E'GH2559 PROOF \(rolled back\)/.test(P), 'proof documents the negative control and ends in a forced RAISE');
ok(/is_test IS TRUE AND p\.is_test IS TRUE/.test(P) && !/INSERT INTO public\.claims/.test(P), 'proof uses an is_test fixture looked up at run time and inserts no claim');
ok(!/\b[0-9a-f]{20,}\b/i.test(F + R + P + PF), 'no 20+ hex literal (no real id) in the new SQL/markdown');

// clients: wait for the read, placeholder stays null, no new homeowner sentence
ok(/async function waitForEstimateRead\(claimId\)/.test(D) && /await waitForEstimateRead\(currentClaim\.id\);/.test(D) && /loss_sheet_parsed_at/.test(D), 'dashboard.html waits for loss_sheet_parsed_at before the submit update');
const Q4 = "We're still processing your insurance estimate, so your project can't open for bids yet. Please try again in a few minutes. If this keeps happening, contact us and we'll help.";
ok(D.includes('const BID_OPEN_REFUSAL_TEXT = "' + Q4 + '";') && /if \(isBidOpenRefusal\(err\)\) showError\(BID_OPEN_REFUSAL_TEXT\);/.test(D) && /showError\('Failed to submit your project\. Please try again\.'\);/.test(D), 'dashboard.html: the unread-estimate refusal shows the Q4 sentence verbatim (#2559 6281179334); the generic line stays for other failures');
ok(/export async function waitForEstimateRead\(/.test(A) && /await waitForEstimateRead\(claimId\);/.test(A) && A.includes('export const BID_OPEN_REFUSAL_TEXT =\n  "' + Q4 + '";'), 'React actions.ts waits for the read; refusal text is the Q4 sentence verbatim');
ok(D.indexOf('await waitForEstimateRead(currentClaim.id)') < D.indexOf(".update(submitUpdate)") && D.indexOf('await waitForEstimateRead(currentClaim.id)') > 0, 'dashboard.html: the wait comes before the update');

// review 6276857463 rulings
ok(/COALESCE\(NEW\.loss_sheet_parse_status, ''\) NOT IN \('unsupported', 'failed'\)/.test(F) && /CHECK \(loss_sheet_parse_status IS NULL OR loss_sheet_parse_status IN \('parsed', 'unsupported', 'failed'\)\)/.test(F), "condition 1 lets a platform-marked 'unsupported' file open; the column is CHECK-constrained");
ok(/current_user IN \('anon', 'authenticated'\)[\s\S]*?ERRCODE = '42501'/.test(F) && /NEW\.estimate_filename IS DISTINCT FROM OLD\.estimate_filename/.test(F) && /NEW\.parsed_line_items := NULL/.test(F) && /NEW\.loss_sheet_parsed_at := NULL/.test(F), 'a client cannot write the status; a changed estimate_filename clears the old parse (X2)');
ok(/CREATE TRIGGER claims_guard_a0_parse_state\s+BEFORE INSERT OR UPDATE OF estimate_filename, loss_sheet_parse_status/.test(F), 'the parse-state trigger sorts before claims_guard_bid_open (name a0)');
ok(/detectEstimateKind\(bytes\)/.test(PL) && /type: kind\.block/.test(PL) && /media_type: kind\.mediaType/.test(PL) && !/media_type: "application\/pdf"/.test(PL), 'parse-loss-sheet sends the real media type (no hard-coded application/pdf)');
ok(/markUnreadable\("unsupported", "loss_sheet_unsupported_type"/.test(PL) && /\{ loss_sheet_parse_status: status \}/.test(PL) && /platform_alerts_log/.test(PL) && /loss_sheet_unsupported_type/.test(PL) && /loss_sheet_parse_status: "parsed"/.test(PL), 'parse-loss-sheet records unsupported + parsed and writes an operator alert');
ok(/image\/jpeg/.test(EK) && /image\/png/.test(EK) && /application\/pdf/.test(EK), 'estimate-kind.ts knows PDF, JPEG and PNG');
ok(!/updErr\.message \}/.test(A.split('if (refused)')[0].split('const refused')[1] || '') && /if \(refused\) return \{ ok: false, error: BID_OPEN_REFUSAL_TEXT \}/.test(A) && /includes\('\[gh2559-bid-open:unread_estimate\]'\)/.test(A), 'React maps the unread-estimate refusal to the Q4 sentence, never the database text; the identity refusal stays generic');
ok(/loss_sheet_parse_status === 'unsupported'/.test(D) && /loss_sheet_parse_status === 'unsupported'/.test(A), 'both clients stop waiting for a file marked unsupported');
ok(/\.eq\("estimate_filename", storage_path\)/.test(PL) && (PL.match(/\.eq\("estimate_filename", storage_path\)/g) || []).length === 2 && /stale: true/.test(PL), 'parse-loss-sheet writes (parse and unsupported mark) only while the claim still points at the file it parsed; a stale result is a 200, not an error');
ok(/NEW\.loss_sheet_parsed_at IS DISTINCT FROM CASE WHEN TG_OP = 'UPDATE' THEN OLD\.loss_sheet_parsed_at END/.test(F) && /NEW\.parsed_line_items IS DISTINCT FROM CASE/.test(F) && /NEW\.contractor_scope_summary IS DISTINCT FROM CASE/.test(F) && /UPDATE OF estimate_filename, loss_sheet_parse_status, loss_sheet_parsed_at, parsed_line_items, contractor_scope_summary/.test(F), 'a client cannot write the parse results (F1/F1b): 42501 branch and UPDATE OF list cover all four columns');
ok(/IN \('parsed', 'unsupported', 'failed'\)/.test(F) && /NOT IN \('unsupported', 'failed'\)/.test(F), "'failed' is a valid status and lets the claim open like 'unsupported'");
ok(/markUnreadable\("failed", "loss_sheet_parse_failed"/.test(PL) && /isFileRejection\(anthropicResponse\.status, errorText\)/.test(PL) && !/anthropicResponse\.status === 400 \|\| anthropicResponse\.status === 413/.test(PL), "parse-loss-sheet marks 'failed' only when isFileRejection (413, or a 400 naming the file)");
ok(/loss_sheet_provider_error/.test(PL) && /\[400, 401, 402, 403, 404\]\.includes\(anthropicResponse\.status\)/.test(PL), 'a non-file 400/401/402/403/404 is a 502 with an operator alert, never a failed mark');
ok(/FILE_BLOCK_PATH\.test\(msg\) \|\| FILE_TEXTS\.some/.test(EK) && !/ACCOUNT_OR_CONFIG/.test(EK) && !/FILE_CAUSE/.test(EK), 'isFileRejection is a whitelist (content-block path or known file text), not a blacklist');
ok(/status === 'unsupported' \|\| data\.loss_sheet_parse_status === 'failed'/.test(D) && /status === 'unsupported' \|\| row\.loss_sheet_parse_status === 'failed'/.test(A), "both clients stop waiting on 'failed' as on 'unsupported'");
ok(/'parsed' \/ 'unsupported' \/ 'failed'/.test(R), "rollback comment names 'failed'");
ok(/Math\.floor\(\(5 \* 1024 \* 1024\) \/ 4\) \* 3/.test(EK), 'image cap is computed on the base64 size (3,932,160 raw)');
{ const pend = read('sql/schema-pending.json'); ok(/"loss_sheet_parse_status":\s*\{\s*"migration": "supabase\/migrations_drafts\/gh2559_claims_bid_open_guard\.sql"/.test(pend), 'loss_sheet_parse_status is declared in sql/schema-pending.json against the draft'); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
