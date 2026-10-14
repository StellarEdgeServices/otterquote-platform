# Pre-flight: gh2491_claims_platform_fee_charged_guard (Tier 3B)

NOT APPLIED. Refs #2491. The write guard on `claims.platform_fee_charged` that Ben set as the condition for applying `supabase/migrations_drafts/gh2491_message_counterpart.sql` (#2491 comments 6023472925, 6029407730). Protective only (R-134): it only removes capability from the browser roles. R-097 notice applies.

## What it does
Adds `public.claims_guard_platform_fee_charged()` (SECURITY INVOKER, `search_path = public, pg_temp`) and the trigger `claims_guard_platform_fee_charged` (`BEFORE INSERT OR UPDATE OF platform_fee_charged ON public.claims`). For client callers (`current_user` is `anon` or `authenticated`, the JWT role is not `service_role`, the caller is not an admin email) it refuses, with SQLSTATE 42501: an INSERT with `platform_fee_charged = true`, and an UPDATE that changes the column in either direction. A value re-sent unchanged is not a change. `service_role`, admins and owner-level sessions are untouched. No policy, grant, existing trigger or data changes.

## Who writes the column today (enumeration at main 5de52ea)
Command: `grep -rn "platform_fee_charged" --include=*.html --include=*.js --include=*.ts --include=*.tsx --include=*.sql --include=*.mjs .` excluding `supabase/tests`. Writers:

| Path | Caller | After the rule |
|---|---|---|
| `supabase/functions/stripe-webhook/index.ts` L940 `.update({ platform_fee_charged: true })` | service-role client | Allowed (proof S1) |
| `supabase/functions/docusign-webhook/index.ts` L1312, L1461, L1534 (`false`) and L1790 (`true`) | service-role client | Allowed (proof S1) |
| `supabase/migrations/20260907223417_gh1759_backfill_claims_platform_fee_charge.sql` (historic backfill) | migration session (owner) | Not a client role; allowed |
| any `.html`, `.js`, `.ts`, `.tsx` page or React component | none writes it; `get-business-lines-dashboard` only reads it | Nothing to break |

Production function scan (Supabase MCP, SELECT only, 2026-10-13): `select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ilike '%platform_fee_charged%'` returns 0 rows, so no SQL function writes it.

## Not in this migration
- `claims.platform_fee_amount` and `claims.platform_fee_stripe_id` are also client-writable today (same policy, same table-level grant). They are not read by `get_message_counterpart`; the PR body asks whether to add them to this guard.
- Applying `gh2491_message_counterpart.sql`. That is a separate step with its own notice; the drafted notice text is on #2491.

## Rollback
`supabase/migrations_rollbacks/gh2491_claims_platform_fee_charged_guard_rollback.sql` drops the trigger and the function. If the forward file was applied through the ledger, also delete its `schema_migrations` row. Do not roll back while `get_message_counterpart` is live without accepting that a claim owner can then release their own name to their selected contractor.

## Proof
`supabase/tests/gh2491_platform_fee_charged_guard_proof.sql` run by `supabase/tests/gh2491_platform_fee_charged_guard_proof_run.sh` on a throwaway Postgres: TODAY, AFTER the forward file, AFTER the rollback (must equal TODAY). Negative controls: U1 and I1 are ACCEPTED today and REJECTED 42501 after. Raw output is in the PR body.
