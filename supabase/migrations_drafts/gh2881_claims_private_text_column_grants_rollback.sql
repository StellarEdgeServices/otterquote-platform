-- STATUS (gh-1438, as of 2026-10-19T19:10:11Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh2881_claims_private_text_column_grants
-- EVIDENCE: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881). Production was not touched; proved forward-then-rollback on a throwaway Postgres (supabase/tests/gh2881_claims_private_text_proof_run.sh, stage C).
-- REPO COPY: none. When the forward is applied, file this rollback in supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback: gh2881_claims_private_text_column_grants
-- Restores the table-level SELECT that `authenticated` held before (Supabase default privileges on public give authenticated ALL on a table),
-- then drops the owner RPC. The column grants the forward file added are revoked so the ACL is clean (a column REVOKE does not touch the
-- table-level grant). Safe to run twice. Run it first if any page breaks after the forward file: the cost is that the three columns are readable
-- again by the roles that could read them before (the exposure this set closes returns).
-- The line below restores SELECT only, because the forward file never touched any other privilege. The pre-flight records the ACL to compare (section 2).
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $restore$
DECLARE
  v_cols text;
  v_role text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.claims'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    -- only a role the forward file gave column grants to (it held SELECT before) gets the table-level SELECT back
    IF v_role = 'authenticated' OR has_any_column_privilege(v_role, 'public.claims', 'SELECT') THEN
      EXECUTE format('GRANT SELECT ON public.claims TO %I', v_role);
      EXECUTE format('REVOKE SELECT (%s) ON public.claims FROM %I', v_cols, v_role);
    END IF;
  END LOOP;
END
$restore$;

DROP FUNCTION IF EXISTS public.claim_private_text(uuid);

DO $assert$
BEGIN
  IF NOT has_column_privilege('authenticated', 'public.claims', 'homeowner_notes', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.claims', 'project_confirmation', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.claims', 'SELECT') THEN
    RAISE EXCEPTION 'gh2881 rollback: authenticated did not get SELECT back' USING ERRCODE = 'P0A88';
  END IF;
END
$assert$;

COMMIT;
