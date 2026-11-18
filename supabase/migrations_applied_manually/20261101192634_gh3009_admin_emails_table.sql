-- gh-3009 item 2: ONE source for the admin email allow-list.
-- DRAFT ONLY. NOT APPLIED. Tier 3 (RLS / auth helper) -- needs CTO + owner approval.
-- Rollback: gh3009_admin_emails_table_rollback.sql. Pre-flight: gh3009_admin_emails_table_pre-flight.md.
--
-- Before: public.is_admin_email() held the emails as literals, duplicated in
-- netlify/edge-functions/admin-auth-gate.ts and react-app (middleware.ts,
-- admin-allowlist.ts, auth-provider.tsx). After: the list is the rows of
-- public.admin_emails; every caller asks is_admin_email().
-- Existing RLS policies call is_admin_email() by name and need no change.

BEGIN;

-- 1) The list. RLS on with NO policies and no grants to anon/authenticated:
--    no client can read or write it. Only SECURITY DEFINER is_admin_email() and
--    service_role (migrations/ops) touch it.
CREATE TABLE IF NOT EXISTS public.admin_emails (
  email      text PRIMARY KEY,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_emails FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_emails TO service_role;

-- 2) Seed = the exact current list (is_admin_email() in 20260621213735_p18).
INSERT INTO public.admin_emails (email, note) VALUES
  ('dustinstohler1@gmail.com', 'owner (seed from p18 is_admin_email literal)'),
  ('dustin@otterquote.com',    'owner role address (seed from p18 is_admin_email literal)')
ON CONFLICT (email) DO NOTHING;

-- 3) is_admin_email(): same name, args and return type, so every policy that
--    calls it keeps working. SECURITY DEFINER so it can read the locked table;
--    search_path pinned empty and every object schema-qualified. It still
--    decides from the CALLER's verified JWT email (auth.jwt() reads the request
--    claims, which are the caller's even inside a definer function). Exact-match,
--    same as the old IN (...) list. A NULL/absent email is now false, not NULL.
CREATE OR REPLACE FUNCTION public.is_admin_email()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_emails ae
    WHERE ae.email = (auth.jwt() ->> 'email')
  );
$$;

-- Callers include anon-evaluated policies (TO public), so keep EXECUTE broad;
-- the function reveals only the caller's own admin status.
REVOKE ALL ON FUNCTION public.is_admin_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_email() TO anon, authenticated, service_role;

COMMIT;
