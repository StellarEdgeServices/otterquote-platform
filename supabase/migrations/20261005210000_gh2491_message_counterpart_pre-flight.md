# Pre-flight: 20261005210000_gh2491_message_counterpart (Tier 3: new SECURITY DEFINER function)

NOT APPLIED. Refs #2491. Rulings: 5969703283 (CTO RUN 57), 5972779494 (CTO RUN 58, AMENDED: contractor half superseded).

## What it does
- Creates `public.get_message_counterpart(p_claim_id uuid)` returning `(counterpart_user_id uuid, counterpart_role text, display_label text)`. STABLE, SECURITY DEFINER, `search_path = public, pg_temp`.
- Homeowner caller (owns the claim): one row, the selected contractor's `company_name` (fallback `your contractor`). Zero rows if no contractor is selected yet.
- Contractor caller with a quote on the claim: one row, the literal `the homeowner`. Only when the caller is `claims.selected_contractor_id` AND `claims.platform_fee_charged IS TRUE` does the label become the homeowner's `profiles.full_name`. That is the only statement in the function that reads the homeowner's name, and it sits inside that branch (hiding it in the client is not what enforces this).
- Anyone else (signed-in stranger, contractor with no quote, no session, unknown claim): zero rows. `anon`: permission denied.
- REVOKE ALL FROM PUBLIC and anon; GRANT EXECUTE to authenticated only.
- No policy is created, altered or dropped; `profiles` and `contractors` RLS are untouched. No table, column or data change.

## Fee state
`claims.platform_fee_charged` (boolean DEFAULT false). Written true only on confirmed payment success: `docusign-webhook/index.ts` (with `status = contract_signed`) and `stripe-webhook/index.ts` (on settlement). Production, read-only, 2026-10-05: 1 claim true, 2 selected-but-false, 26 unselected.

## Danger-pattern check
New function in `public` with a deliberate GRANT to `authenticated`: `scripts/permissions-ratchet.py` flags SECURITY DEFINER + a non-service_role grant and needs the `permissions-ratchet: reviewed` label from a reviewer (same as PR #2428). The function returns a display label only; no email, phone or address.

## Proof on production, inside BEGIN ... ROLLBACK (2026-10-05, via `In Flight/bin/_cto53_sql.py`; nothing persisted)
Claim A `4d764e19` (is_test, platform_fee_charged = false, 1 message), claim B `82f5dff4` (is_test, fee true; its owner and contractor are the same auth user, so B proves the homeowner branch only).
- homeowner of A: 1 row, role `contractor`, label = the contractor's company_name.
- selected contractor of A, fee false: label `the homeowner`; leaks owner name = false.
- NEGATIVE CONTROL, a temp variant of the function with the fee check removed, same caller, same claim: label = the owner's full name; leaks owner name = true.
- same claim A inside the transaction with `SET LOCAL session_replication_role = replica` (triggers off) and `UPDATE claims SET platform_fee_charged = true`: label equals the owner's trimmed `full_name`; a contractor with no quote still gets 0 rows. After ROLLBACK, `platform_fee_charged` on A reads false again.
- contractor of B asking about A: 0 rows; signed-in stranger on A and on B: 0 rows; a contractor with no quote on A: 0 rows; authenticated with no subject: 0 rows.
- anon: `permission denied for function get_message_counterpart`. `has_function_privilege`: anon false, authenticated true.
- profiles RLS unchanged: the selected contractor reading the owner's profiles row gets 0 rows.
- After the proof: `SELECT proname FROM pg_proc WHERE proname IN ('get_message_counterpart','zz_broken_counterpart')` returned `[]`.

## Delta proof: the homeowner branch answers only for a contractor with a quote on the claim (2026-10-06, production, one BEGIN ... ROLLBACK, role-switched)
Function body installed in the transaction has md5 `a31889ad12bc14ccefd4c65bdce0c3ca` = the md5 of the text between the `$fn$` markers in the forward file. Claim A `4d764e19` (is_test). The owner's `full_name` was set to a sentinel inside the transaction (rolled back).
- homeowner of A (selected contractor has a quote): 1 row, role `contractor`, the contractor's company_name, `counterpart_user_id` = the selected contractor's user.
- selected contractor of A, fee false: 1 row, `the homeowner` (the sentinel name is not returned).
- selected contractor of A, fee true (set in the transaction): 1 row, label = the sentinel full_name. A contractor with no quote on A, fee true: 0 rows.
- contractor with no quote on A: 0 rows. Signed-in stranger: 0 rows. Authenticated with no subject: 0 rows. anon: `permission denied`; `has_function_privilege` anon false, authenticated true.
- HOLE: the owner of A sets `selected_contractor_id` to a contractor with no quote on A (inside the transaction): this function returns 0 rows.
- NEGATIVE CONTROL, same call against the pre-fix body (no `EXISTS` on quotes): 1 row, role `contractor`, that contractor's company_name and user_id (leak = true).
- After ROLLBACK: neither function exists in `pg_proc`; claim A reads fee false, selected `986ce2b6` (unchanged); no profile carries the sentinel name.

## Applier runbook
1. R-097 notice, then apply the forward file.
2. `SELECT has_function_privilege('anon','public.get_message_counterpart(uuid)','EXECUTE');` expect false; for `authenticated` expect true.
3. With an `is_test` pair on one claim: the homeowner's panel header and message labels show the contractor's business name; the contractor's panel labels the homeowner `the homeowner` (fee false). A third signed-in user calling `rpc/get_message_counterpart` for that claim gets `[]`. Paste the negative control.
4. After a fee is collected on an `is_test` claim, the selected contractor's labels show the homeowner's name.

## Deploy order
The dashboards are safe to deploy before the migration: until the rpc exists they fall back to `the homeowner` (contractor) and `your contractor` (homeowner), never `--` and never a name.

## Rollback
`supabase/migrations_rollbacks/20261005210000_gh2491_message_counterpart_rollback.sql` drops the function. Safe at any time (same fallbacks).

## Gates
The ruling requires LEGAL-READ and `R-177 SIGNED:` on the PR (a contractor-facing identity label). Not obtained by the author.

## Not in scope, noted
`contractor_messages` RLS lets any contractor with a quote on a claim read every message on it, including other contractors' threads with the homeowner. The label code shows those as `Another contractor`; the read itself is a separate RLS question.
