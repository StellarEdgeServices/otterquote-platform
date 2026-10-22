# gh-2619 (second piece) pre-flight: messages thread scope and no cross-party UPDATE/DELETE

Tier 3B (policy change on `public.messages`, new column and two triggers). NOT APPLIED. Independent review, R-097 24-hour notice, Dustin's word, then a recorded apply. Draft: `supabase/migrations_drafts/gh2619_messages_thread_scope_and_no_cross_delete.sql`. Rollback: `supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql`. Proof (throwaway Postgres only): `supabase/tests/gh2619_messages_thread_scope_proof.sql`. Review history: CLOSE-REVIEW 6168484981 (#2619), REVIEW: FAIL 6169771197 and 6170220911 (PR #2777).

## What changes
1. `public.messages`: the two `cmd ALL` policies `contractor_messages` and `homeowner_messages` become `contractor_messages_select`, `contractor_messages_insert`, `homeowner_messages_select`, `homeowner_messages_insert`. No UPDATE or DELETE policy remains for any non-service role. `service_role_messages` is untouched.
2. `public.claims`: new nullable column `contractor_released_at timestamptz` (catalogue-only, no default, brief ACCESS EXCLUSIVE lock) and trigger `claims_stamp_contractor_released_at` (BEFORE INSERT OR UPDATE): stamps `now()` only when a contractor LOSES the claim (old `selected_contractor_id` not null and it changes, to NULL or to another id); an award from NULL keeps the old value, so the winner still reads messages written before the award or while the claim was back in bidding. Client roles (`authenticated`, `anon`) cannot set the column; `service_role` and admin sessions can. There is NO backfill: a read-only guard in the forward file aborts the apply while any real claim is in a legacy set (below).
3. `public.messages`: trigger `messages_pin_created_at` (BEFORE INSERT) sets `created_at := now()` for client roles only (`current_user` in `authenticated`, `anon`); `service_role` and admin sessions keep the value they write.
4. Contractor SELECT also needs `messages.created_at >= coalesce(claims.contractor_released_at, claims.contractor_switched_at)` when either is set.

## Read-only checks to run on production before the apply (SELECT only)
```
-- policies as expected (the gate in the forward file also refuses otherwise)
SELECT policyname, cmd, qual LIKE '%selected_contractor_id%' AS q_sel, with_check LIKE '%selected_contractor_id%' AS wc_sel FROM pg_policies WHERE schemaname='public' AND tablename='messages' ORDER BY 1;
-- no existing objects with the new names
SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='claims' AND column_name='contractor_released_at';   -- expect 0
SELECT tgname FROM pg_trigger WHERE tgrelid IN ('public.claims'::regclass,'public.messages'::regclass) AND NOT tgisinternal ORDER BY 1;           -- expect no claims_stamp_contractor_released_at / messages_pin_created_at
-- any other trigger or function that writes messages.created_at or claims selection columns (expect none that conflicts)
SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.prosrc ILIKE '%messages%' OR p.prosrc ILIKE '%selected_contractor_id%') ORDER BY 1;
-- legacy exposure, real: claims a dunning reset sent back to bidding (process-dunning marks the failure contractor_out and clears the selection with no contractor_switched_at)
SELECT count(DISTINCT c.id) FILTER (WHERE c.is_test) AS test_claims, count(DISTINCT c.id) FILTER (WHERE NOT c.is_test) AS real_claims
  FROM public.claims c JOIN public.payment_failures pf ON pf.claim_id = c.id AND pf.dunning_status = 'contractor_out'
 WHERE c.contractor_switched_at IS NULL;
-- the guard's three sets, real claims only (is_test IS NOT TRUE); the apply refuses unless the sum is 0
-- (A) no selected contractor, thread holds a contractor-sent message
SELECT count(*) AS set_a FROM public.claims cl WHERE cl.is_test IS NOT TRUE AND cl.selected_contractor_id IS NULL AND EXISTS (SELECT 1 FROM public.messages m WHERE m.claim_id = cl.id AND m.sender_role = 'contractor');
-- (B) a selected contractor, thread holds contractor-sent messages from a different contractor
SELECT count(DISTINCT cl.id) AS set_b FROM public.claims cl JOIN public.messages m ON m.claim_id = cl.id AND m.sender_role = 'contractor' WHERE cl.is_test IS NOT TRUE AND cl.selected_contractor_id IS NOT NULL AND m.sender_id IS DISTINCT FROM (SELECT k.user_id FROM public.contractors k WHERE k.id = cl.selected_contractor_id);
-- (C) dunning released the contractor (same as the legacy-exposure query above, real claims only)
SELECT count(DISTINCT cl.id) AS set_c FROM public.claims cl JOIN public.payment_failures pf ON pf.claim_id = cl.id AND pf.dunning_status = 'contractor_out' WHERE cl.is_test IS NOT TRUE;
-- messages on real claims overall
SELECT count(*) FROM public.messages m JOIN public.claims c ON c.id = m.claim_id WHERE NOT c.is_test;
```
Record the counts on #2619. **If any count is non-zero, stop: the forward file will refuse to apply (RAISE naming the counts), and a data decision is needed first** (per-claim real release times from `payment_failures.resolved_at`, `contractor_switched_at` and `quotes.cancelled_at`, or a hand review of the threads); do not work around the guard.

## What the legacy guard covers, exactly
- Covers (real claims only): (A) unselected with contractor messages; (B) selected with another contractor's messages (a former selected contractor, or a bidder who posted through the pre-#2622 hole); (C) any process-dunning release (`contractor_out`).
- Does not cover: `is_test` claims in those sets (test data keeps today's unbounded read for the next winner; the proof shows F1 reading 2 after an award with no stamp); a claim that lost a contractor through a path that left no trace in A, B or C; real exposure that appears after the pre-flight but before the apply (the guard re-reads inside the apply transaction); homeowner messages that predate the first award are visible to the winner by design.
- The guard is read-only; it is not a backfill, so legacy threads are not bounded afterwards on any claim. It never runs the `claims` UPDATEs the round 3 backfill needed, so no `claims_updated_at` bump and no rehearsal UPDATE is needed.

## Idempotence
The set is single-shot: after the apply the order gate (it requires the `ALL` policy with `selected_contractor_id`) refuses a second run before any change, and `ADD COLUMN` would fail anyway. The guard is a read-only SELECT block, so a refused apply changes nothing, and re-running it after the data question is settled is safe. A rollback followed by a re-apply recomputes nothing (there is no backfill): the trigger stamps only from then on, and stamps made before the rollback are lost with the column. The transaction starts with `SET LOCAL lock_timeout = '5s'`: if the brief ACCESS EXCLUSIVE locks on `claims` and `messages` cannot be had in 5 seconds the whole apply fails and nothing changes.

## Client write sites of `messages` (unfiltered, from the PR review 6169771197 and `grep -rn "from(.messages.)"`)
SELECT and INSERT ... RETURNING only: `dashboard.html` 3547/3585, `contractor-dashboard.html` 2188/2227, `react-app/app/(homeowner)/dashboard/actions.ts:197`, `MessagesPanel.tsx:32`, `Messaging.tsx:91/128`; `send-message-notification` reads with the service role. No client or Edge Function with a user JWT UPDATEs or DELETEs `messages`; the `read_at` writes in the repo are on `notifications`.

Paths that change `claims.selected_contractor_id` (all covered by the trigger, which does not depend on the writer): `switch-contractor` (sets `contractor_switched_at` with the Edge Function clock), `process-dunning/index.ts:677` (clears it without `contractor_switched_at`), `accept_bid` / `bids/actions.ts` (award), admin SQL.

## Visible behaviour change
- A contractor selected after a switch, a dunning reset or any reselection sees only messages from that selection onward. A contractor re-selected on the same claim also loses sight of their own earlier thread (accepted, disclosed in the draft header and the PR body). The homeowner still sees the full history.
- Nobody can edit or delete a sent message through the API (no UI offers it today).
- `created_at` on messages written by a client is always the database clock; `service_role` and admin writes keep their own value.
- A restore that re-inserts `claims` rows as `service_role` or an admin session (the `sql/2026-07-13-purge-*-rollback.sql` pattern) keeps `contractor_released_at` as supplied; as a client role it is nulled.
- The homeowner's messages written before the first award, or while the claim was back in bidding, are shown to the next winner; only messages from before the previous contractor's release are hidden. Follow-up after apply: add `claims.contractor_released_at` to `sql/schema-snapshot.json` and `Docs/code-map.json`.

## Apply and verify (not done by this PR)
1. R-097 notice window, PR merged with review. 2. Apply the forward SQL through the Tier 3B path; record the ledger version; file under `supabase/migrations/<version>_gh2619_messages_thread_scope_and_no_cross_delete.sql`. 3. Paste live `pg_policies` for `messages` (expect five policies: four new plus `service_role_messages`), `information_schema.columns` for the new column, and `pg_trigger` for the two triggers. 4. Re-run the proof's probes on is_test rows inside one rolled-back transaction (the throwaway file's `try_as` pattern); expect the NEW column of the PR's table.

## Rollback
Run the rollback file (one transaction: drops the four policies, recreates the two `ALL` policies from the post-#2622 text, drops both triggers and functions and the column). Verify `pg_policies` equals the pre-apply paste.
