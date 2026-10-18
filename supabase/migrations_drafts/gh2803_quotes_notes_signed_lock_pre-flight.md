# Pre-flight: gh2803_quotes_notes_signed_lock (Tier 3B, DRAFT)

NOT APPLIED. Refs #2803. Follows PR #2844 (the `update_selected_bid_notes` RPC; review 6254508202 finding 1). Ruling: tier:3b (issue #2803). R-097 window ends 2026-10-19T18:37:39Z. Apply only after `tier:3b-approved`, and after gh2564 (the price lock it sits beside).

## What it does
Adds `public.quotes_refuse_signed_notes_change()` and a plain `BEFORE UPDATE` trigger of the same name on `public.quotes`. For a client caller (`current_user IN ('anon','authenticated')`, `auth.role() <> 'service_role'`, not `is_admin_email()`), a change to `quotes.notes` on a row whose `homeowner_signed_at` OR `contractor_signed_at` is set (Dustin, #2846, option (b), 2026-10-18T22:11:53Z) is refused 42501. Notes before signature stay writable. The bound is the one the RPC enforces (22023 after signature).

## Design choice (guard clause vs separate trigger)
Separate trigger. `quotes_guard_homeowner_columns()` is re-created whole by gh2626, gh2519 and gh2564 and the gh2564 order is open with #2819; one more full-body copy could revert a live clause depending on apply order, and its rollback would need the whole body again. The trigger never touches that body; rollback is two DROPs.

## Before applying
- `SELECT count(*) FROM pg_trigger WHERE tgname = 'quotes_refuse_signed_notes_change' AND NOT tgisinternal` is 0; `SELECT count(*) FROM pg_proc WHERE proname = 'quotes_refuse_signed_notes_change'` is 0.
- `SELECT count(*) FROM public.quotes WHERE homeowner_signed_at IS NOT NULL AND notes IS NOT NULL` shows how many signed bids carry notes (read-only; the trigger changes no existing row).
- gh2564 applied: `SELECT prosrc LIKE '%gh-2564%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure` is true.

## After applying
```sql
SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_refuse_signed_notes_change';
-- expect tgenabled O, BEFORE UPDATE ... FOR EACH ROW (no OF column list)
```
Then run the probe in `supabase/tests/gh2803_notes_signed_lock_proof.sql` on an is_test signed quote in a ROLLBACK block.

## Known edge (found by the proof's N17 probe, reported to Dustin and Ben; not fixed here)
Only the claim owner can write `homeowner_signed_at` (guard allow-list), so a contractor cannot clear the homeowner's signature. The contractor CAN, as a separate statement, clear their own `contractor_signed_at` (proof N17: `rows=1 ACCEPTED` both before and after this trigger; gh2519 allows the contractor to write it). The trigger reads OLD, so one statement that clears the signature and edits notes is refused (N16), but clear-then-edit in two statements reopens notes while `homeowner_signed_at` is still NULL. The ruling on #2846 (option (b), \"At contractor signature\") is only as firm as `contractor_signed_at` is. Closing it means also refusing a client change of `contractor_signed_at` from non-NULL to NULL; that is a separate guard change on a column the signing flow writes, so it is left as a question on #2803.

## Proof
`supabase/tests/gh2803_notes_signed_lock_proof_run.sh` (throwaway Postgres 16, repo throwaway schema + gh2626, gh2519, gh2564 + PR #2844 RPC): before the trigger a direct notes write after signature is ACCEPTED; after, REJECTED 42501; unsigned notes writable; RPC works before signature and refuses after; service_role still writes; after the rollback the before-lines return.

## Rollback
`supabase/migrations_drafts/gh2803_quotes_notes_signed_lock_rollback.sql`. No data lost.
