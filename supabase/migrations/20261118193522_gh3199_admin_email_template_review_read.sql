-- STATUS (gh-1438, as of 2026-11-15T17:14:55Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3199_admin_email_template_review_read (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-15 under #3199 (reviewer FAIL 6898076317, gap B4). Production read-only SELECTs (project yeszghaspzwwstvsrioa, 2026-11-15): pg_policy on public.contractor_templates holds exactly two policies,
--   contractor_templates_self (own rows) and contractor_templates_admin (contractors.template_review_role = 'admin'); 0 contractors have that role; RLS enabled, not forced; admin_emails has 2 rows.
--   BEGIN READ ONLY / SET LOCAL ROLE authenticated / jwt email dustinstohler1@gmail.com / ROLLBACK: is_admin_email() = true, visible_rows = 0. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3199_admin_email_template_review_read
-- GitHub: #3199. Tier 3B (RLS change): R-097 notice owed before apply. REVIEW owed. Not applied by this PR.
-- Rollback: gh3199_admin_email_template_review_read_rollback.sql   Pre-flight: gh3199_admin_email_template_review_read_pre-flight.md
--
-- What this file does
--   The admin page /admin/template-review reads and writes public.contractor_templates with the browser (anon-key, user JWT) client, so RLS decides what an admin sees.
--   Today only own rows and template_review_role = 'admin' contractors pass, so an ADMIN_EMAILS admin sees an empty queue and Approve/Reject match zero rows.
--   Adds two PERMISSIVE policies for role authenticated, both gated on public.is_admin_email() (the gh3009 admin_emails-table check, SECURITY DEFINER, EXISTS so never NULL):
--     contractor_templates_admin_email_select  FOR SELECT
--     contractor_templates_admin_email_update  FOR UPDATE (USING and WITH CHECK)
--   No INSERT or DELETE policy is added. Existing policies are untouched. The column-level guards (trg_templates_privileged_guard, whose request_is_privileged() already honours is_admin_email()) are untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- refuse to run against a table that is not in the state this file was written against
DO $g$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.contractor_templates'::regclass) THEN
    RAISE EXCEPTION 'gh3199: RLS is not enabled on public.contractor_templates; re-diff before applying';
  END IF;
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh3199: public.is_admin_email() does not exist; apply gh3009 first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.contractor_templates'::regclass AND polname = 'contractor_templates_self')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.contractor_templates'::regclass AND polname = 'contractor_templates_admin') THEN
    RAISE EXCEPTION 'gh3199: expected existing policies contractor_templates_self and contractor_templates_admin are not both present; re-diff before applying';
  END IF;
END
$g$;

DROP POLICY IF EXISTS contractor_templates_admin_email_select ON public.contractor_templates;
CREATE POLICY contractor_templates_admin_email_select ON public.contractor_templates
  FOR SELECT TO authenticated
  USING (public.is_admin_email());

DROP POLICY IF EXISTS contractor_templates_admin_email_update ON public.contractor_templates;
CREATE POLICY contractor_templates_admin_email_update ON public.contractor_templates
  FOR UPDATE TO authenticated
  USING (public.is_admin_email())
  WITH CHECK (public.is_admin_email());

-- post-check: both new policies exist with the intended command and role, and the two old ones are still there
DO $p$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policy
   WHERE polrelid = 'public.contractor_templates'::regclass
     AND ((polname = 'contractor_templates_admin_email_select' AND polcmd = 'r')
       OR (polname = 'contractor_templates_admin_email_update' AND polcmd = 'w'))
     AND polroles = ARRAY['authenticated'::regrole]::oid[];
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'gh3199 post-check: expected 2 new admin-email policies for role authenticated, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_policy WHERE polrelid = 'public.contractor_templates'::regclass;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'gh3199 post-check: expected 4 policies on contractor_templates, found %', v_n;
  END IF;
END
$p$;

COMMIT;
