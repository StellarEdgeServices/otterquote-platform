# gh-3816 pre-flight: new-contractor admin alert (notify_admin_new_contractor) enqueues a request pg_net can resolve (Tier 3B, R-097 24-hour notice, R-177 pair, Dustin's GO)

Forward: `supabase/migrations_drafts/gh3816_notify_admin_new_contractor_body.sql`. Rollback: `supabase/migrations_rollbacks/gh3816_notify_admin_new_contractor_body_rollback.sql`.
Proof: `supabase/tests/gh3816_notify_admin_new_contractor_body_proof.sql` (runner `..._proof_run.sh`, throwaway Postgres with stub pg_net and Vault only). Not applied; nothing in this PR touches production.

## What is wrong, and what changes
`trg_notify_admin_new_contractor` (AFTER INSERT OR UPDATE OF status ON public.contractors) runs `notify_admin_new_contractor()`, installed 2026-06-02. Its `net.http_post` passes `body := jsonb_build_object('contractor_id', NEW.id)::text::bytea`. pg_net 0.20.0 in production has one overload, `net.http_post(text, jsonb, jsonb, jsonb, integer)`, and pg_cast has no bytea-to-jsonb cast, so the call raises 42883 on every execution; `EXCEPTION WHEN OTHERS` logs and returns NEW, so the signup succeeds and nothing is sent. `notifications` holds zero `admin_new_contractor` rows ever. The same defect was noted, not fixed, in a comment in `supabase/migrations/20260817222018_gh752_move_notify_functions_to_vault.sql`.
Three changes, all inside this one function body (CREATE OR REPLACE; owner, SECURITY DEFINER, `search_path = public, net` and the ACL are preserved and re-asserted by the proof):
1. body is `jsonb_build_object('contractor_id', NEW.id)` (no cast). This is the fix.
2. BEHAVIOUR ADDITION: the `EXCEPTION WHEN OTHERS` handler now also inserts one `platform_alerts_log` row (`alert_type` `contractor_admin_notify_failed`, `function_name` `notify_admin_new_contractor`, message = contractor id + SQLSTATE + SQLERRM; no email, no name) inside its own nested exception block, so neither the failure nor a failing log write can block the signup. None of the working siblings (new-claim, new-partner, router-lead, out-of-state-claim, the referral and GA4 notifiers) does this; they only RAISE LOG (the feature-request one has no handler at all). The row is visible in the admin panel (`admin-contractors.html` reads the table). It sends no email.
3. The "Vault secret `cron_service_role_key` not found" skip branch writes the same visible row.
Not changed: status filter, test-email filter, URL, headers, Vault lookup, the trigger.
Limit: `net.http_post` is asynchronous. A later non-2xx from the Edge Function is not seen by this handler (it lands in `net._http_response`, about 6 h retention).

## Production base (read-only SELECT 2026-11-19, project yeszghaspzwwstvsrioa)
Installed definition = the repo's latest (`20260817222018_gh752...`, part 1 of 2): `length(prosrc)` 1551, `md5(prosrc)` beginning 4299011d, `md5(pg_get_functiondef)` beginning 06115f96 (first 8 hex only: the credential sweep flags longer hex runs, and the existing proofs abbreviate the same way); the proof installs the rollback file and asserts the length and both prefixes, then compares full md5s within the script, so the rollback file is byte-equal to production for all practical purposes. Owner postgres, SECURITY DEFINER, `search_path=public, net`, ACL `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`. `platform_alerts_log`: columns id, alert_type, function_name, message, sent_at, acknowledged_at (no CHECK constraints), owner postgres, RLS enabled and not forced (the SECURITY DEFINER owner can insert). pg_net 0.20.0.

## Target Edge Function (main f64abdbf, supabase/functions/notify-admin-new-contractor/index.ts)
Reads `const body = await req.json()` and then only `body?.contractor_id` (string); 400 if missing. Requires `Authorization: Bearer <service role key>`. Skips (200, `skipped: test_account`) when the contractor's email contains `otterquote-internal.test`, `pfw-` or `authdoctor` (same filter as the trigger function; neither reads the `is_test` column). Skips if an `admin_new_contractor` notification already exists for that `user_id`. Otherwise sends one Mailgun email "New Contractor Signup ... (pending review)" to dustinstohler1@gmail.com and inserts a `notifications` row (`notification_type` `admin_new_contractor`, `channel` email, `user_id` = the contractor's user_id). The runner asserts the file reads no other body field; proof B3 asserts the queued body is exactly `{"contractor_id": "<uuid string>"}`.

## Danger patterns (migration-author-code Step 1)
1-8: not triggered (no column, index, rename, truncate, delete or cascade). 9 (new public function): not triggered; no function is created, CREATE OR REPLACE keeps the ACL (proof B0, D1, D2). No secret literal; the key comes from Vault exactly as in `notify_admin_new_partner`. Tier 3B: it replaces a function that causes an email to be sent to the admin and adds a write path (the alert row).

## Proof (throwaway Postgres 16, stub pg_net with production's signature): 33 assertions, FAILING=0
Negative control (before): the production call expression raises 42883; the INSERT of a pending_approval contractor succeeds; zero queued requests; zero alert rows. After: one request to the function URL with body `{"contractor_id": id}`; an `is_test` contractor with a test-pattern email queues nothing (by design); an `is_test` contractor with an ordinary email queues one (the function does not read `is_test`); status filter unchanged; forced failure in `net.http_post` leaves the INSERT successful with one trace row; the log write also failing still leaves the INSERT successful; missing Vault key leaves a trace row; forward twice is a no-op; rollback restores production's exact body and grants; forward again works.

## Scan: every public-schema function that calls net.http_post / http_get resolves to an installed overload
Production query (read-only; extracts every `net.http_*(...)` call with balanced parentheses, 160 public functions scanned):
```sql
with f as (select p.oid, p.proname, p.prosrc from pg_proc p where p.pronamespace='public'::regnamespace and p.prosrc ~* 'net\s*\.\s*http_'),
st as (select f.oid, f.proname, f.prosrc, n, regexp_instr(f.prosrc,'net\s*\.\s*http_(post|get|delete|collect_response)\w*\s*\(',1,n) as s from f, generate_series(1,30) n),
st2 as (select * from st where s>0),
ch as (select st2.oid, st2.proname, st2.n, st2.s, i, substr(st2.prosrc, st2.s+i-1,1) c from st2, generate_series(1,3000) i where st2.s+i-1 <= length(st2.prosrc)),
dp as (select *, sum(case when c='(' then 1 when c=')' then -1 else 0 end) over (partition by oid,n order by i) d from ch),
endp as (select oid,n,min(i) e from dp where d=0 and c=')' group by oid,n)
select st2.proname, st2.n, regexp_replace(substr(st2.prosrc, st2.s, endp.e), '[A-Za-z0-9_\-\.]{40,}','<REDACTED>','g') call from st2 join endp using (oid,n) order by 1,2;
```
Result 2026-11-19: 12 calls in 11 functions, all `net.http_post`, no `http_get`/`http_delete`, no unqualified `http_post(`. Each call's arguments were typed from their outermost expression and the call was resolved by a real Postgres holding pg_net's signatures: 11 resolve; `notify_admin_new_contractor` (body bytea) does not (`function net.http_post(url => text, body => bytea, headers => jsonb) does not exist`). After this migration that call is jsonb and resolves. The 19 pg_cron jobs that call `net.http_post` contain no bytea cast. The only non-public function that mentions `net.http_*` is Supabase's own `extensions.grant_pg_net_access`.

## Post-apply verification (read this: it writes to production and sends one real email)
The trigger skips test-pattern emails itself, so a pattern email (`...otterquote-internal.test`, `pfw-`, `authdoctor`) queues nothing and proves nothing. To see the call succeed, an `is_test = true` contractor must be inserted (or moved into `pending_approval`) with an email that does NOT match those three patterns. That causes the Edge Function to send ONE real email to dustinstohler1@gmail.com ("New Contractor Signup ... (pending review)") and to write one `notifications` row. It is a production write and needs Dustin's word, as does removing the test row afterwards. Read-only checks after it:
```sql
SELECT id, status_code, error_msg, created FROM net._http_response ORDER BY id DESC LIMIT 5;   -- a 2xx row within seconds (the table has no URL column: match by time)
SELECT id, notification_type, recipient, sent_at, delivered FROM public.notifications WHERE notification_type = 'admin_new_contractor' ORDER BY sent_at DESC LIMIT 3;
SELECT alert_type, message, sent_at FROM public.platform_alerts_log WHERE alert_type = 'contractor_admin_notify_failed' ORDER BY sent_at DESC LIMIT 3;   -- expect none
```
Pre-fix result of the same INSERT (negative control, observed 2026-11-19 by read): zero `admin_new_contractor` notifications ever; zero queue rows. Also `SELECT count(*) FROM public.contractors WHERE NOT is_test AND status = 'pending_approval'` before and after, to see who is waiting.

## Contractor 22adcbd6
The one real contractor who signed up on 2026-09-25 is still `pending_approval` (read 2026-11-19). The migration does not re-send anything: the trigger fires only on INSERT or on a change of `status` into `pending_approval`. Look at that contractor by hand in the admin contractors page.

## Rollback
Run the rollback file. It restores production's installed body (the broken one) and leaves owner, grants and trigger as they are. Rows already written to `platform_alerts_log` stay.
