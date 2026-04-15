-- v41-admin-last-login-view.sql
--
-- Purpose: Expose auth.users.last_sign_in_at on the admin Incomplete Profiles page
--          without requiring the service role key client-side.
--
-- Approach: A SECURITY INVOKER = false (default) view in the public schema.
--   * PostgreSQL views are owned by their creator (postgres in Supabase) and
--     resolve underlying table permissions as the OWNER, not the caller.
--   * This lets the view reference auth.users even when called via the anon key.
--   * The WHERE clause calls auth.email() — evaluated in the calling session's JWT
--     context — so non-admin sessions receive 0 rows rather than an error.
--   * No service role key is ever sent to the client.
--
-- Called by: admin-incomplete-profiles.html
--   SELECT contractor_id, last_sign_in_at FROM admin_contractor_last_logins
--   (fetched in parallel with the contractors query, joined client-side by id)

CREATE OR REPLACE VIEW public.admin_contractor_last_logins AS
SELECT
    c.id              AS contractor_id,
    u.last_sign_in_at
FROM public.contractors c
LEFT JOIN auth.users u ON c.user_id = u.id
WHERE (SELECT auth.email()) = 'dustinstohler1@gmail.com';

COMMENT ON VIEW public.admin_contractor_last_logins IS
    'Admin-only view: last_sign_in_at for all contractors joined from auth.users. '
    'Restricted by auth.email() — non-admin sessions always receive 0 rows. '
    'No service role key required client-side. See v41 migration (Session 191).';

-- Grant SELECT to authenticated role only (admin is always authenticated).
-- The WHERE clause is the access gate — this grant does not expose data to
-- any non-admin session because auth.email() will not match.
GRANT SELECT ON public.admin_contractor_last_logins TO authenticated;

-- Supabase auto-grants to anon on object creation; revoke it explicitly.
-- anon (unauthenticated) sessions have no JWT, so auth.email() = NULL ≠ admin,
-- but defense-in-depth: no reason for unauthenticated access to this view at all.
REVOKE ALL ON public.admin_contractor_last_logins FROM anon;
