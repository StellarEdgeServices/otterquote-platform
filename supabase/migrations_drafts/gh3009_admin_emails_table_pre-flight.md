# Pre-Flight: gh3009_admin_emails_table

**Status**: DRAFT ONLY, NOT APPLIED. Tier 3 (auth helper + new locked table). Owner: CTO. Issue: #3009 item 2.

## Change
- New `public.admin_emails(email PK, note, created_at)`; RLS enabled, no policies, all client grants revoked, service_role only.
- Seed of the two emails currently literal in `is_admin_email()` (p18 migration).
- `public.is_admin_email()` rewritten to read the table: SECURITY DEFINER, `search_path = ''`, EXECUTE to anon/authenticated/service_role. Signature unchanged, so the six p18 policies and any other caller are untouched.

## Behavior difference (intentional)
- NULL/absent JWT email now returns `false` (was `NULL`). Policies treat both as deny.
- SECURITY INVOKER -> DEFINER. Needed because clients cannot read the table. `auth.jwt()` still reflects the caller.

## Rollout order (no hazard either way)
`is_admin_email()` already exists, so the edge gate and static pages that call it work before AND after this migration. Apply the migration at any time after the PR merges. Adding/removing an admin afterwards is a service-role INSERT/DELETE on `admin_emails`, no deploy.

## Verify after apply (read-only)
1. `SELECT email FROM public.admin_emails ORDER BY 1;` -> the 2 seed rows.
2. `SELECT relrowsecurity FROM pg_class WHERE oid='public.admin_emails'::regclass;` -> t.
3. `SELECT has_table_privilege('authenticated','public.admin_emails','SELECT');` -> f.
4. As a non-admin session: `select public.is_admin_email();` -> false. As owner session -> true.
5. Load /admin-dashboard.html signed in as owner -> 200 (the live valid-session proof #3009 still owes).

## Rollback
`gh3009_admin_emails_table_rollback.sql` restores the literal function and drops the table. Rows added after the seed are lost on rollback; export them first.

## Remaining copy
`react-app/middleware.ts` still holds a literal list (PR #3062 owns that file; not touched here). After #3062 merges it should call `is_admin_email` the same way as the edge gate.
