# Pre-flight: gh2626_claims_award_columns_guard (Tier 3B)

NOT APPLIED. Refs #2626 (SECURITY, MONEY PATH). Follow-up that Ben's condition D on PR #2623 (comment 6066956273) requires before #2623 is applied. Protective only (R-134): it only removes capability from the browser roles. R-097 notice applies.

## What it does
Adds `public.claims_guard_award_columns()` (SECURITY INVOKER, `search_path = public, pg_temp`) and the trigger `claims_guard_award_columns` (`BEFORE UPDATE ON public.claims`). For client callers (`current_user` is `anon` or `authenticated`, JWT role not `service_role`, caller not an admin email), an UPDATE is refused with SQLSTATE 42501 when it:
1. moves `status` away from `contract_signed`;
2. moves `status` to `awarded` from anything other than `active` or `bidding`;
3. changes `selected_contractor_id` or `selected_bid_amount`, or moves `status` to `awarded`, unless the resulting `selected_contractor_id` has a live quote on the claim (`quotes.status` in `submitted`, `selected`; `bid_status` `active` or NULL) whose `total_price` equals `selected_bid_amount`. Clearing an existing `selected_contractor_id` is refused.
A value re-sent unchanged is not a change. `service_role`, admins and owner-level sessions (`accept_bid()`, SECURITY DEFINER, postgres-owned) are untouched. No policy, grant, existing trigger, `accept_bid()` or data changes.

## Every client write to the award columns at main (5de52ea), and what the rule does to it
Enumeration: `grep -rn -A6 -E "from\(['\"]claims['\"]\)" --include=*.html --include=*.tsx --include=*.ts .` excluding tests and `supabase/functions`, filtered to `status:` and `selected_`: the only client writes that carry an award column are the ones below; every other hit is a read (`.select`) or a status write of `waitlisted` / `submitted`.

| Path | Caller | Columns | After the rule |
|---|---|---|---|
| `react-app/app/(homeowner)/bids/actions.ts` L110-116 `awardClaimToContractor` | claim owner | `selected_contractor_id` = the bid's contractor, `selected_bid_amount` = the bid's `total_price`, `status` = `awarded`, while the bid is `submitted` | Allowed when the claim is `active`/`bidding` (proof R1); today it is refused by the payment guard for every homeowner until #2623 is applied (gh-2620, proof pass 1) |
| `bids.html`, `contractor-about.html`: `rpc('accept_bid')` | claim owner | inside the RPC | Untouched: definer owned by postgres (proof R3) |
| `dashboard.html` L1919, `dashboard/actions.ts` L244 | claim owner | `status` = `waitlisted` | Allowed (proof R4), unless the claim is `contract_signed` |
| `repair-intake.html` L1328, `use-repair-intake-data.ts` L178 | claim owner | `status` = `submitted` | Allowed, unless the claim is `contract_signed` |
| `supabase/functions/*` (switch-contractor, rescind-bid, webhooks) | service-role client | any | Untouched (proof S1) |

## Production read behind this (Supabase MCP, SELECT only, 2026-10-13)
`pg_trigger` on `public.claims`: 11 user triggers, none checks a quote. `pg_policy`: "Users can update own claims" `UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())`, no column restriction. The blast radius from the issue (0 real claims in `bidding` or `awarded`, 2026-10-08) was not re-measured here.

## Order with PR #2623
Independent in function. Until #2623 is applied the React award is refused by the payment guard anyway; once it is applied, this guard is what stops an award to a contractor with no bid (proof pass 4 shows D2 and D3 ACCEPTED with #2623 alone, pass 5 shows them REFUSED with both). Either order is safe; the pair is complete only with both.

## Not in this migration
- `accept_bid()` sets `awarded` without checking the claim's current status (review of #2615). It is a definer function; a status check there is its own change (PR body question 2).
- The bidding contractor's own price after the award, and the other claim columns the owner can write.

## Rollback
`supabase/migrations_rollbacks/gh2626_claims_award_columns_guard_rollback.sql` drops the trigger and the function. If applied through the ledger, also delete its `schema_migrations` row.

## Proof
`supabase/tests/gh2626_claims_award_columns_guard_proof.sql`, run by `supabase/tests/gh2626_claims_award_columns_guard_proof_run.sh` on a throwaway Postgres in six passes (TODAY, GUARD-ONLY, ROLLBACK, WITH-2623, WITH-2623-AND-GUARD, ROLLBACK). Negative controls: D1 to D8 are ACCEPTED before and REJECTED 42501 after; R1, R3 to R6 (the app's own writes) are ACCEPTED after. Raw output is in the PR body.
