# gh-2619 (second piece) pre-flight: messages thread scope and no cross-party UPDATE/DELETE

Tier 3B (policy change on `public.messages`, new column and two triggers). NOT APPLIED. Independent review, R-097 24-hour notice, Dustin's word, then a recorded apply. Draft: `supabase/migrations_drafts/gh2619_messages_thread_scope_and_no_cross_delete.sql`. Rollback: `supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql`. Proof (throwaway Postgres only): `supabase/tests/gh2619_messages_thread_scope_proof.sql`. Review history: CLOSE-REVIEW 6168484981 (#2619), REVIEW: FAIL 6169771197 (PR #2777).

## What changes
1. `public.messages`: the two `cmd ALL` policies `contractor_messages` and `homeowner_messages` become `contractor_messages_select`, `contractor_messages_insert`, `homeowner_messages_select`, `homeowner_messages_insert`. No UPDATE or DELETE policy remains for any non-service role. `service_role_messages` is untouched.
2. `public.claims`: new nullable column `contractor_selected_at timestamptz` (catalogue-only, no default, brief ACCESS EXCLUSIVE lock) and trigger `claims_stamp_contractor_selected_at` (BEFORE INSERT OR UPDATE): stamps `now()` when `selected_contractor_id` changes, pins the column to its old value on every other UPDATE.
3. `public.messages`: trigger `messages_pin_created_at` (BEFORE INSERT) sets `created_at := now()`.
4. Contractor SELECT also needs `messages.created_at >= coalesce(claims.contractor_selected_at, claims.contractor_switched_at)` when either is set.

## Read-only checks to run on production before the apply (SELECT only)
```
-- policies as expected (the gate in the forward file also refuses otherwise)
SELECT policyname, cmd, qual LIKE '%selected_contractor_id%' AS q_sel, with_check LIKE '%selected_contractor_id%' AS wc_sel FROM pg_policies WHERE schemaname='public' AND tablename='messages' ORDER BY 1;
-- no existing objects with the new names
SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='claims' AND column_name='contractor_selected_at';   -- expect 0
SELECT tgname FROM pg_trigger WHERE tgrelid IN ('public.claims'::regclass,'public.messages'::regclass) AND NOT tgisinternal ORDER BY 1;           -- expect no claims_stamp_contractor_selected_at / messages_pin_created_at
-- any other trigger or function that writes messages.created_at or claims selection columns (expect none that conflicts)
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.prosrc ILIKE '%messages%' OR p.prosrc ILIKE '%selected_contractor_id%') ORDER BY 1;
-- legacy exposure: claims with a selected contractor, no contractor_switched_at (these have no lower bound until their next selection change)
SELECT count(*) FILTER (WHERE is_test) AS test_claims, count(*) FILTER (WHERE NOT is_test) AS real_claims FROM public.claims WHERE selected_contractor_id IS NOT NULL AND contractor_switched_at IS NULL;
-- messages that exist on those claims
SELECT count(*) FROM public.messages m JOIN public.claims c ON c.id=m.claim_id WHERE c.selected_contractor_id IS NOT NULL AND c.contractor_switched_at IS NULL AND NOT c.is_test;
```
Record the counts on #2619. As of the last read on #2619 (CLOSE-REVIEW 6168484981) there were 4 messages, 0 on real claims.

## Client write sites of `messages` (unfiltered, from the PR review 6169771197 and `grep -rn "from(.messages.)"`)
SELECT and INSERT ... RETURNING only: `dashboard.html` 3547/3585, `contractor-dashboard.html` 2188/2227, `react-app/app/(homeowner)/dashboard/actions.ts:197`, `MessagesPanel.tsx:32`, `Messaging.tsx:91/128`; `send-message-notification` reads with the service role. No client or Edge Function with a user JWT UPDATEs or DELETEs `messages`; the `read_at` writes in the repo are on `notifications`.

Paths that change `claims.selected_contractor_id` (all covered by the trigger, which does not depend on the writer): `switch-contractor` (sets `contractor_switched_at` with the Edge Function clock), `process-dunning/index.ts:677` (clears it without `contractor_switched_at`), `accept_bid` / `bids/actions.ts` (award), admin SQL.

## Visible behaviour change
- A contractor selected after a switch, a dunning reset or any reselection sees only messages from that selection onward. A contractor re-selected on the same claim also loses sight of their own earlier thread (accepted, disclosed in the draft header and the PR body). The homeowner still sees the full history.
- Nobody can edit or delete a sent message through the API (no UI offers it today).
- `created_at` on new messages is always the database clock.

## Apply and verify (not done by this PR)
1. R-097 notice window, PR merged with review. 2. Apply the forward SQL through the Tier 3B path; record the ledger version; file under `supabase/migrations/<version>_gh2619_messages_thread_scope_and_no_cross_delete.sql`. 3. Paste live `pg_policies` for `messages` (expect five policies: four new plus `service_role_messages`), `information_schema.columns` for the new column, and `pg_trigger` for the two triggers. 4. Re-run the proof's probes on is_test rows inside one rolled-back transaction (the throwaway file's `try_as` pattern); expect the NEW column of the PR's table.

## Rollback
Run the rollback file (one transaction: drops the four policies, recreates the two `ALL` policies from the post-#2622 text, drops both triggers and functions and the column). Verify `pg_policies` equals the pre-apply paste.
