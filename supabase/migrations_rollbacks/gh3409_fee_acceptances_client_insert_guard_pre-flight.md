# gh-3409 pre-flight: fee_acceptances client-insert guard (revised after REVIEW 6668449870, LEGAL-READ 6668344412 and REVIEW 6669057587)

Forward: `supabase/migrations_drafts/gh3409_fee_acceptances_client_insert_guard.sql`. Rollback: `gh3409_fee_acceptances_client_insert_guard_rollback.sql` (this directory). Tier 3B. Nothing here is applied.

**How to apply.** Run the forward file ALONE: `psql -v ON_ERROR_STOP=1 -f <file>`. Its own `COMMIT` ends any wrapper, so never dry-run it inside `BEGIN ... ROLLBACK` (proven for gh-3320 in PR #3406). A plain `psql -f` exits 0 even when the closing guard fires (nothing is committed): read checks 1 and 2 afterwards and confirm the `schema_migrations` row.

**Order with PR #3406 (gh-3320).** Independent. This file adds a BEFORE INSERT trigger, three functions and one new table (public.fee_acceptance_quarantine); #3406 drops one UPDATE policy and revokes UPDATE/DELETE. Neither reads nor writes what the other changes. Apply #3406 first (smaller, reviewed), then this file. The runner proves both orders and independent rollback (`C-A`, `C-B`).

**Ship order (REVIEW 6669057587 B1).** The contractor-bid-form.html change in this PR (no `.single()` on the fee_acceptances insert) must be LIVE before this migration is applied. With the old form live, a diverted acceptance makes PostgREST answer 406 PGRST116 and roll the request back, taking the quarantine row with it (proved against a real PostgREST 12.2.3 and supabase-js 2.116.0: runner case P4). A genuine acceptance is unaffected by the old form (case P1), so the exposure is only the diverted rows, which are logged (a WARNING with the shown text) but not kept in the table. Order: merge and deploy the form, run check 0, then apply #3406, then this file.

Read-only SELECTs only (check 0 is a read of the public page). Run each SQL check as one statement against project `yeszghaspzwwstvsrioa`.

## 0. The deployed HTML form has no `.single()` on the fee_acceptances insert (blocks the apply)
```bash
curl -s "<production origin>/contractor-bid-form.html" -o /tmp/live-bid-form.html && node supabase/tests/gh3409_form_shape_check.mjs /tmp/live-bid-form.html
```
Expect `FORMSHAPE|insert ends with .select('id') and no .single()/.maybeSingle()|OK`. `FAIL` means the old form is still being served (or a CDN copy is stale): do not apply. Also confirm no other client inserts into `fee_acceptances` with `.single()` (`grep -rn "from('fee_acceptances')" --include=*.html --include=*.ts --include=*.tsx .`; on this head the only inserts are the two bid forms).

## 1. Today's state (re-read at apply time; the closes-on needs this beside the post-apply read)
```sql
SELECT 'policy' k, policyname || ' | ' || cmd || ' | ' || coalesce(qual,'') || ' | ' || coalesce(with_check,'') v FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances'
UNION ALL SELECT 'trigger', tgname || ' ' || tgenabled::text FROM pg_trigger WHERE tgrelid='public.fee_acceptances'::regclass AND NOT tgisinternal
UNION ALL SELECT 'grant', grantee || ' ' || privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='fee_acceptances' AND grantee IN ('anon','authenticated','service_role')
UNION ALL SELECT 'rls', relrowsecurity::text || ' force=' || relforcerowsecurity::text FROM pg_class WHERE oid='public.fee_acceptances'::regclass
UNION ALL SELECT 'functions', count(*)::text FROM pg_proc WHERE proname IN ('fee_acceptances_guard_client_insert','fee_acceptance_text_check','fee_acceptance_quarantine_add')
UNION ALL SELECT 'quarantine_table', coalesce(to_regclass('public.fee_acceptance_quarantine')::text, 'absent');
```
Expect (measured 2026-11-05, before this file): policies admin read / admin UPDATE (unless #3406 is applied) / contractor INSERT own `WITH CHECK (contractor_id IN (...own...))` / contractor read own; **no trigger**; RLS on, not forced; functions 0; quarantine_table absent. If a trigger already exists, stop and read it.

## 2. Prerequisite: gh-2519 is applied (the bid's fee is server-set), and a client can read its own bids
```sql
SELECT to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') AS fee_for,
       (SELECT prosrc ILIKE '%quotes_platform_fee_for%' FROM pg_proc WHERE proname='quotes_guard_homeowner_columns' AND pronamespace='public'::regnamespace) AS guard_uses_it,
       has_table_privilege('authenticated','public.quotes','SELECT') AS auth_can_select_quotes,
       (SELECT relrowsecurity FROM pg_class WHERE oid='public.quotes'::regclass) AS quotes_rls;
```
Expect (measured 2026-11-05): `fee_for` non-null, `guard_uses_it` true (prosrc md5 `d2aeffb8...`), `auth_can_select_quotes` true, `quotes_rls` true. The forward file also refuses to run without `quotes_platform_fee_for`.

## 3. Every existing row passes the new rules (they describe TEST acceptances; see below)
```sql
SELECT f.id, (q.id IS NOT NULL) has_bid, (q.contractor_id = f.contractor_id) contractor_ok, (q.claim_id = f.claim_id) claim_ok,
       (f.fee_pct = COALESCE(q.platform_fee_pct, q.fee_percentage)) pct_ok, (f.fee_amount = q.fee_amount) fee_ok,
       round(extract(epoch FROM (f.created_at - q.created_at))::numeric, 2) secs_after_bid, f.invoice_url IS NOT NULL has_invoice, f.rescinded_at IS NOT NULL rescinded,
       f.fee_text_displayed = ('Platform fee for this job: $' || to_char(f.fee_amount,'FM999,999,999,990.00') || ' (' || to_char(f.fee_pct,'FM990.00') || '% of your bid). By submitting this bid, you agree to pay Otter Quotes this fee if the homeowner selects your bid and a contract is signed. The fee is due upon contract execution and will be charged to your card on file. Submitting this bid constitutes your acceptance of this fee.') html_text_ok,
       (SELECT count(*) FROM public.fee_acceptances g WHERE g.bid_id = f.bid_id) rows_for_bid
  FROM public.fee_acceptances f LEFT JOIN public.quotes q ON q.id = f.bid_id ORDER BY f.created_at;
```
Measured 2026-11-05: 8 rows, all `is_test = true` per the reviewer (REVIEW 6668449870), all `true` / `true` / `true` / `true` / `true`, `secs_after_bid` 0.16 to 1.10, `has_invoice` false, `rescinded` false, `html_text_ok` true, `rows_for_bid` 1. (All 8 are the HTML form's wording; the React form's wording is covered by the proof, which renders it from `copy.ts`. If the React form is live and later rows use it, `html_text_ok` is false for them and that is expected.) A row that fails a rule here is a real acceptance this file would have refused: stop and read it.

## 4. Bids without an acceptance (informational, today)
```sql
SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.fee_acceptances f WHERE f.bid_id = q.id)) AS bids_without_acceptance, count(*) AS bids FROM public.quotes q;
```
Measured 2026-11-05: 4 of 12. These are not changed by this file (the form's insert is non-fatal and the change-bid flow writes none, by design, ADR-010). After apply, a client can no longer add an acceptance to such an old bid (rule 3). If Legal wants a way to record a late acceptance, it is a service_role path, a separate ticket.

## 5. Watch after apply, STANDING (not a one-week check)
A genuine acceptance is never refused and never lost: when the screen and the server disagree, or a form's wording is not yet mirrored in `fee_acceptance_text_check()`, the row is kept in `public.fee_acceptance_quarantine` and is NOT added to `fee_acceptances`. The client sees a success: the HTML form gets an empty array and reports `[D-215] Fee acceptance diverted to quarantine` to Sentry (warning); the React form sends no returning clause and reports nothing. Each diversion also writes a server log WARNING (`gh-3409 fee acceptance quarantined: bid ... reasons ... shown ...`, the shown text capped at 700 characters) that survives even if a client rolls its request back. The quarantine keeps the row exactly as sent (own id, created_at, accepted_at; text capped at 4000, original length in `fee_text_length`) and takes at most 25 rows an hour per caller, past which it only logs (a flood cap so a contractor session cannot fill the table). So the quarantine table is the alert, and it must be read on a schedule (daily, and on every Sentry event above or `Fee acceptance record failed`):
```sql
SELECT quarantined_at, reasons, bid_id, contractor_id, server_fee_pct, server_fee_amount, fee_pct, fee_amount, left(fee_text_displayed, 80) AS shown
  FROM public.fee_acceptance_quarantine ORDER BY quarantined_at DESC;
SELECT q.id, q.created_at FROM public.quotes q WHERE q.created_at > '<apply time>' AND coalesce(q.is_auto_bid,false) = false AND coalesce(q.is_test,false) = false
   AND NOT EXISTS (SELECT 1 FROM public.fee_acceptances f WHERE f.bid_id = q.id) ORDER BY q.created_at;
```
Reasons: `displayed_fee_differs` (the figure on the screen is not the bid's fee: state-specific `platform_fee_config` row, a rate change while a form was open, an out-of-order refresh), `text_not_form_wording` (a wording change not yet mirrored here: update `fee_acceptance_text_check()` in the same release as the form), `duplicate_bid`, `bid_has_no_fee`. A change-bid save writes no row by design (ADR-010); exclude those. Wire this into the ATC or ops sweep; the apply is not complete until someone owns the check (Q on #3409).

Rows inserted between check 3 and the apply are not re-checked by this file: re-run check 3 right after the apply and read any row that fails a rule.

## 6. After apply (read again, paste beside check 1)
Re-run check 1: expect the trigger `fee_acceptances_guard_client_insert O`, functions 3, quarantine_table `fee_acceptance_quarantine`, policies and grants of `fee_acceptances` unchanged (except what #3406 changes if applied). Then: `SELECT has_table_privilege('anon','public.fee_acceptance_quarantine','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('authenticated','public.fee_acceptance_quarantine','SELECT,INSERT,UPDATE,DELETE')` expects `false, false`; and `SELECT pg_get_functiondef('public.fee_acceptances_guard_client_insert()'::regprocedure)` equals the forward file's function body (the closes-on's live read, I-7).

## Edge Function change (separate deploy)
`supabase/functions/stripe-webhook/index.ts` now reads the acceptance of the SELECTED bid and only when its fee equals that bid's current fee (`fee-acceptance-select.ts`, test `fee-acceptance-select.test.ts`). This closes the second-bid and price-dip shapes the table guard cannot see (REVIEW 6668449870 B1). It deploys through the normal Edge Function path, independent of this migration, in either order; until it is deployed those shapes still reach the dispute packet.

## Residuals (not fixed here)
- `ip_address` and `user_agent` are the browser's own report; a contractor can still choose them.
- `service_role` and `postgres` can still insert, edit and delete (D-214 "no deletes" against them is Ben's question on #3320 / #3406).
- Nothing writes `rescinded_at` or `invoice_url`; this file only stops a client setting them.
- The form's IP fetch can return the string `unknown`, which the `inet` column refuses, so that acceptance is not recorded today (existing, unchanged; the row is not diverted, the insert errors before the trigger).
- A concurrent pair of inserts for the same bid could both pass the duplicate test; both are forced to the bid's fee and a form text, so neither is forged. A unique index on `bid_id` would close it; all 8 production rows are one per bid, so the data check is already answered, but it is left for a separate change.
- The forms read the rate with `contractor.state` (no such column on production; the server uses `address_state`) and the HTML form's fee refresh is not sequenced. Those make the screen and server disagree; this file keeps the record when they do. Fixing the forms to read `quotes_platform_fee_for` and sequencing the refresh is a separate code change (LEGAL-READ item 3).
- The React form ignores the insert result; with diversion that no longer loses anything, but a refusal (A in the file header) is silent there.
- Which figure stands when the screen and the server disagree (D-267 points to the accepted figure; gh-2519 sets the charged one), and the React sentence "deducted from your bid amount ... You will receive $X" against D-226, are Tier C questions for Ben and Legal.
- A CI job for the proof runner is not added in this PR (it needs a Postgres service, the PostgREST binary and supabase-js); until then the runner is run by hand (`PGRST_BIN` and `SUPABASE_JS_DIR` set, or the PostgREST section reports SKIPPED and does not count as proved).
- The PostgREST proof ran PostgREST 12.2.3 with supabase-js 2.116.0 (the version the form pins). The PostgREST version Supabase runs for this project was not checked; the `.single()` behaviour (406 PGRST116 and rollback on a count other than one) is long-standing PostgREST behaviour, but confirm the live version if it matters.
- A revised bid (ADR-010: a change-bid writes no new acceptance row) whose fee moved no longer matches its old acceptance: the webhook treats that as no evidence and the dispute packet says to gather it manually (Q on #3409).
