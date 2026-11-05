<!--
STATUS (gh-1438, as of 2026-11-05T22:40:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3470_create_monthly_fee_batch_guard_fail_closed (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-05 under #3470; production read-only SELECTs the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3470_create_monthly_fee_batch_guard_fail_closed (Tier 3B, money path, hardening with a normal notice)

NOT APPLIED. Refs #3470. Tier 3B (money path). This is hardening, not an R-134 fast path: the CTO correction (#3470 comment 6671253977) records that the live `is_admin_email()` already fails closed, so nothing is exposed during a notice window. It takes a normal R-097 24-hour notice and window before apply, plus REVIEW, LEGAL-READ and Ben's signature (bound 4). No notice has been posted by this PR.

## What it does
Replaces `public.create_monthly_fee_batch(date)` (SECURITY DEFINER, `search_path = public, pg_temp`) with the identical definition except the first guard line:

```
-  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.is_admin_email()) THEN
+  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR COALESCE(public.is_admin_email(), false)) THEN
```

`CREATE OR REPLACE` keeps owner, ACL (`authenticated`, `service_role`; anon and PUBLIC have none), `SET search_path` and the function COMMENT; no grant statement is repeated. The file opens with a DO block that raises (changing nothing) unless the live `prosrc` md5 is `1e48a0254db3b738f03f09d731ea90cf`.

## Byte comparison against production (SELECT only, project yeszghaspzwwstvsrioa, 2026-11-05)
- `pg_get_functiondef('public.create_monthly_fee_batch(date)'::regprocedure)`: 3871 chars, md5 `a8f66ee8688a71d710d05a644623c4a6`; `prosrc` md5 `1e48a0254db3b738f03f09d731ea90cf`; owner `postgres`; ACL `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`.
- The block in `gh3229_partner_measurement_fee.sql` (from `CREATE OR REPLACE FUNCTION` to `$function$`) has the same length and md5, so the draft equals production.
- `diff` of that definition against the forward file's definition: exactly one line differs (the guard line above).
- Ledger: `supabase_migrations.schema_migrations` version `20261105194055` `gh3229_partner_measurement_fee`.

## Is it reachable today? (read before applying; this narrows the urgency, not the fix)
Production `public.is_admin_email()` is the gh3009 definition (ledger `20261101192634`): `SELECT EXISTS (SELECT 1 FROM public.admin_emails ae WHERE ae.email = (auth.jwt() ->> 'email'))`. EXISTS never returns NULL, so on production today a no-email JWT is refused by the OLD body too (proof rows `gh3009 TODAY noemail`). The defect in the issue is real for the p18 definition (`... IN (...)`, NULL on a missing email; proof rows `p18 TODAY noemail` admit it), which the repo still carries and which a rollback of gh3009 would restore. The fix makes this function independent of that. Whether an `authenticated` JWT without an email can exist (anonymous or phone sign-in) was not checked: that is a Dashboard Auth setting, not readable by SELECT.

## Sweep (production, SELECT only, 2026-11-05, after gh3229/gh3257/gh3259/gh3428 applied)
All SECURITY DEFINER functions outside system schemas whose source mentions `is_admin_email` (8) or `jwt|auth.email|admin|auth.role` without it (20). Only `create_monthly_fee_batch(date)` has the NOT-form guard on a possibly-NULL value. Others: `get_contractor_last_logins` (`NOT COALESCE(is_admin_email(), false)`), `referral_agents_guard_vanity_slug` (COALESCE form), `claims_guard_measurement_shape` and `referral_agents_guard_payout_columns` (positive `if is_admin_email() then return new`; NULL falls through to the restriction), `admin_list_referrals` and `claim_private_text` (WHERE / OR predicates; NULL = no row), `partner_fee_events_mark_paid` (`COALESCE(auth.role(),'') <> 'service_role'`). The `auth.jwt() ->> 'email'` users (`advance_referral_registered`, `claim_partner_account`, `get_or_create_customer_referral_code`, `set_lead_converted`) read the caller's own identity and are not admin guards.

## Order
Independent of every other pending draft; depends only on gh3229 being applied (it replaces that function).

## Rollback
`gh3470_create_monthly_fee_batch_guard_fail_closed_rollback.sql` restores the gh3229 body verbatim (prosrc md5 `1e48a0254db3b738f03f09d731ea90cf`).

## Proof
`supabase/tests/gh3470_create_monthly_fee_batch_guard_proof.sql` via `gh3470_create_monthly_fee_batch_guard_local_run.sh` (throwaway Postgres 16): both `is_admin_email()` variants x today's body and the fixed body x no-email JWT, admin email, service role, other user; the real forward and rollback files are applied; drift guard negative control.
