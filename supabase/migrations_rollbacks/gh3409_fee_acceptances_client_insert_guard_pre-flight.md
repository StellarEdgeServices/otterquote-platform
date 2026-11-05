# gh-3409 pre-flight: fee_acceptances client-insert guard

Forward: `supabase/migrations_drafts/gh3409_fee_acceptances_client_insert_guard.sql`. Rollback: `gh3409_fee_acceptances_client_insert_guard_rollback.sql` (this directory). Tier 3B. Nothing here is applied.

**How to apply.** Run the forward file ALONE: `psql -v ON_ERROR_STOP=1 -f <file>`. Its own `COMMIT` ends any wrapper, so never dry-run it inside `BEGIN ... ROLLBACK` (proven for gh-3320 in PR #3406). A plain `psql -f` exits 0 even when the closing guard fires (nothing is committed): read checks 1 and 2 afterwards and confirm the `schema_migrations` row.

**Order with PR #3406 (gh-3320).** Independent. This file adds a BEFORE INSERT trigger and two functions; #3406 drops one UPDATE policy and revokes UPDATE/DELETE. Neither reads nor writes what the other changes. Apply #3406 first (smaller, reviewed), then this file. The runner proves both orders and independent rollback (`C-A`, `C-B`).

Read-only SELECTs only. Run each as one statement against project `yeszghaspzwwstvsrioa`.

## 1. Today's state (re-read at apply time; the closes-on needs this beside the post-apply read)
```sql
SELECT 'policy' k, policyname || ' | ' || cmd || ' | ' || coalesce(qual,'') || ' | ' || coalesce(with_check,'') v FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances'
UNION ALL SELECT 'trigger', tgname || ' ' || tgenabled FROM pg_trigger WHERE tgrelid='public.fee_acceptances'::regclass AND NOT tgisinternal
UNION ALL SELECT 'grant', grantee || ' ' || privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='fee_acceptances' AND grantee IN ('anon','authenticated','service_role')
UNION ALL SELECT 'rls', relrowsecurity::text || ' force=' || relforcerowsecurity::text FROM pg_class WHERE oid='public.fee_acceptances'::regclass
UNION ALL SELECT 'functions', count(*)::text FROM pg_proc WHERE proname IN ('fee_acceptances_guard_client_insert','fee_acceptance_text_matches');
```
Expect (measured 2026-11-05, before this file): policies admin read / admin UPDATE (unless #3406 is applied) / contractor INSERT own `WITH CHECK (contractor_id IN (...own...))` / contractor read own; **no trigger**; RLS on, not forced; functions 0. If a trigger already exists, stop and read it.

## 2. Prerequisite: gh-2519 is applied (the bid's fee is server-set), and a client can read its own bids
```sql
SELECT to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') AS fee_for,
       (SELECT prosrc ILIKE '%quotes_platform_fee_for%' FROM pg_proc WHERE proname='quotes_guard_homeowner_columns' AND pronamespace='public'::regnamespace) AS guard_uses_it,
       has_table_privilege('authenticated','public.quotes','SELECT') AS auth_can_select_quotes,
       (SELECT relrowsecurity FROM pg_class WHERE oid='public.quotes'::regclass) AS quotes_rls;
```
Expect (measured 2026-11-05): `fee_for` non-null, `guard_uses_it` true (prosrc md5 `d2aeffb8...`), `auth_can_select_quotes` true, `quotes_rls` true. The forward file also refuses to run without `quotes_platform_fee_for`.

## 3. Every existing row passes the new rules (so the rules describe real acceptances)
```sql
SELECT f.id, (q.id IS NOT NULL) has_bid, (q.contractor_id = f.contractor_id) contractor_ok, (q.claim_id = f.claim_id) claim_ok,
       (f.fee_pct = COALESCE(q.platform_fee_pct, q.fee_percentage)) pct_ok, (f.fee_amount = q.fee_amount) fee_ok,
       round(extract(epoch FROM (f.created_at - q.created_at))::numeric, 2) secs_after_bid, f.invoice_url IS NOT NULL has_invoice, f.rescinded_at IS NOT NULL rescinded,
       f.fee_text_displayed = ('Platform fee for this job: $' || to_char(f.fee_amount,'FM999,999,999,990.00') || ' (' || to_char(f.fee_pct,'FM990.00') || '% of your bid). By submitting this bid, you agree to pay Otter Quotes this fee if the homeowner selects your bid and a contract is signed. The fee is due upon contract execution and will be charged to your card on file. Submitting this bid constitutes your acceptance of this fee.') html_text_ok,
       (SELECT count(*) FROM public.fee_acceptances g WHERE g.bid_id = f.bid_id) rows_for_bid
  FROM public.fee_acceptances f LEFT JOIN public.quotes q ON q.id = f.bid_id ORDER BY f.created_at;
```
Measured 2026-11-05: 8 rows, all `true` / `true` / `true` / `true` / `true`, `secs_after_bid` 0.16 to 1.10, `has_invoice` false, `rescinded` false, `html_text_ok` true, `rows_for_bid` 1. (All 8 are the HTML form's wording; the React form's wording is covered by the proof, which renders it from `copy.ts`. If the React form is live and later rows use it, `html_text_ok` is false for them and that is expected.) A row that fails a rule here is a real acceptance this file would have refused: stop and read it.

## 4. Bids without an acceptance (informational, today)
```sql
SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.fee_acceptances f WHERE f.bid_id = q.id)) AS bids_without_acceptance, count(*) AS bids FROM public.quotes q;
```
Measured 2026-11-05: 4 of 12. These are not changed by this file (the form's insert is non-fatal and the change-bid flow writes none, by design, ADR-010). After apply, a client can no longer add an acceptance to such an old bid (rule 3). If Legal wants a way to record a late acceptance, it is a service_role path, a separate ticket.

## 5. Watch after apply (the one way this file can hurt: a real acceptance refused)
The forms treat a failed acceptance insert as non-fatal, so a refusal would be silent to the contractor. For the first week after apply, daily:
```sql
SELECT q.id, q.created_at FROM public.quotes q WHERE q.created_at > '<apply time>' AND coalesce(q.is_auto_bid,false) = false
   AND NOT EXISTS (SELECT 1 FROM public.fee_acceptances f WHERE f.bid_id = q.id) AND coalesce(q.is_test,false) = false ORDER BY q.created_at;
```
and search Sentry for `[D-215] Fee acceptance record failed` / `fee_acceptances: ... (gh-3409)`. A new bid with no row, or that Sentry message, means a form's wording or numbers drifted from `fee_acceptance_text_matches()`: roll back (this directory) and fix the function. A change-bid save writes no row by design, so exclude those (they update an existing bid and create no new `quotes` row).

## 6. After apply (read again, paste beside check 1)
Re-run check 1: expect the trigger `fee_acceptances_guard_client_insert O` and functions 2, policies and grants unchanged from before (except what #3406 changes if applied). Then the closes-on's live read: `SELECT pg_get_functiondef('public.fee_acceptances_guard_client_insert()'::regprocedure)` equals the forward file's function body.

## Residuals (not fixed here)
- `ip_address` and `user_agent` are the browser's own report; a contractor can still choose them.
- `service_role` and `postgres` can still insert, edit and delete (D-214 "no deletes" against them is Ben's question on #3320 / #3406).
- Nothing writes `rescinded_at` or `invoice_url`; this file only stops a client setting them.
- The form's IP fetch can return the string `unknown`, which the `inet` column refuses, so that acceptance is not recorded today (existing, non-fatal, unchanged).
- A concurrent pair of inserts for the same bid could both pass rule 4; both are forced to the bid's own fee and a form text, so neither can outrank the other with a forged value. A unique index on `bid_id` would close it and needs a data check; left out to keep this change small.
- Legal changes to either form's wording must change `fee_acceptance_text_matches()` in the same release.
