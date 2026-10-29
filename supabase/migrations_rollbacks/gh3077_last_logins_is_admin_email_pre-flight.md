<!--
STATUS (gh-1438, as of 2026-10-29): NOT APPLIED
FILE ROLE: pre-flight file of set gh3077_last_logins_is_admin_email (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-29 (CTO RUN 87, tid cto87-b3077) under #3077; read-only SELECTs only.
REPO COPY: none in supabase/migrations/
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh3077_last_logins_is_admin_email

**Forward**: supabase/migrations_drafts/gh3077_last_logins_is_admin_email.sql
**Rollback**: supabase/migrations_rollbacks/gh3077_last_logins_is_admin_email_rollback.sql
**GitHub**: #3077 (Ben's ruling 6478566612). **Tier**: 3B (auth gate). **Status**: DRAFT, nothing applied.

## What changes
`public.get_contractor_last_logins()` authorizes through `public.is_admin_email()` instead of a literal primary-admin email. Nothing else in the function changes.

## Access change (ruled, not a surprise)
Before: only the primary admin address. After: every address `is_admin_email()` accepts (today the primary and `dustin@otterquote.com`; after #3009's `admin_emails` table is applied, the table rows). Ruled yes by Ben, 6478566612.

## Live state read before drafting (SELECT only, 2026-10-29)
- `pg_get_functiondef('public.get_contractor_last_logins()')`: LANGUAGE plpgsql, SECURITY DEFINER, `SET search_path TO 'public'`, gate `IF auth.email() IS DISTINCT FROM '<literal>' THEN RAISE EXCEPTION 'Access denied'`. This is the text the rollback restores.
- ACL: `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` (no anon, no PUBLIC; the added REVOKEs are no-ops today and pin it).
- `is_admin_email()`: SQL, STABLE, `SET search_path TO 'public','pg_temp'`, `(auth.jwt() ->> 'email') IN (two literals)`, EXECUTE to PUBLIC/anon/authenticated/service_role.
- Only caller in the repo: `admin-incomplete-profiles.html` (the `:679` comment claiming `is_admin_email()` gating becomes true after this applies).

## Pre-apply checks (re-run immediately before apply)
1. `SELECT md5(pg_get_functiondef('public.get_contractor_last_logins()'::regprocedure));` equals the md5 of the rollback body (drift check; if it differs, stop).
2. R-097 24h notice posted on #3077 (Tier 3B).

## Proof after apply (one admin call, one negative control)
- As the primary admin JWT: `SELECT count(*) FROM get_contractor_last_logins();` returns a count (success).
- As an authenticated non-admin test user JWT (test row only): the same call raises `Access denied` (negative control).
- As anon: `permission denied for function` (no EXECUTE).
- `SELECT proacl FROM pg_proc WHERE proname='get_contractor_last_logins';` unchanged from the ACL above.

## Rollback
Run the rollback file; then re-run check 1 (md5 matches the pre-apply value). Lossless: no data is touched.
