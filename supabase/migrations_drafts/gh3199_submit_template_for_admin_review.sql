-- STATUS (gh-1438, as of 2026-10-30): NOT APPLIED
-- FILE ROLE: forward file of set gh3199_submit_template_for_admin_review (rollback and pre-flight are siblings in this directory; proof is supabase/tests/gh3199_submit_template_proof.sql, runner gh3199_submit_template_proof_run.sh)
-- EVIDENCE: drafted 2026-10-30 under #3199 (clause 6 of #2105, #2717 Q2, Ben's ruling on #3199 comment 6522660494). Live definitions read with pg_get_functiondef on production (read-only SELECT) the same day; no database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and the rollback and pre-flight in supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3199_submit_template_for_admin_review
-- GitHub: #3199. Tier: 3B (new authenticated-callable SECURITY DEFINER RPC + CREATE OR REPLACE of a status-guard trigger function). R-097 notice before apply.
--
-- Why: a regular contractor's manual-mapping submit can never leave contractor_templates.status = 'submitted_for_admin_review'.
-- Live trigger contractor_templates_freeze_verdict rewrites the status on every client UPDATE (to pending_validation when
-- manual_overrides/pdf/trade/funding changed, otherwise back to OLD.status), so the admin queue (admin/template-review/utils.ts:75)
-- never receives these templates. Production has 0 rows in that status.
--
-- What it does (Ben's ruling, A: an RPC):
--   1. public.submit_template_for_admin_review(p_template_id uuid, p_overrides jsonb, p_missing_fields text[]) RETURNS contractor_templates.
--      SECURITY DEFINER. Owner comes from auth.uid() (never an argument): the template must belong to a contractors row whose user_id = auth.uid().
--      Allowed from-statuses: pending_validation, manual_mapping_pending -> submitted_for_admin_review. Anything else raises.
--      manual_overrides and status are written in ONE statement, so a template never sits in review without the submitted mapping.
--      p_overrides NULL and p_missing_fields NULL = leave manual_overrides as it is (the "Request admin review" button).
--      Otherwise manual_overrides := coalesce(p_overrides,'{}') || {"_missing_fields": p_missing_fields} (the shape the client wrote before).
--   2. Trigger accommodation (Ben's conditional C). Reading the live bodies:
--        - contractor_templates_freeze_verdict does NOT block a SECURITY DEFINER caller: it starts with
--          IF current_user <> 'authenticated' THEN RETURN NEW, and inside a SECURITY DEFINER function owned by postgres current_user is postgres.
--          It is left untouched.
--        - enforce_template_privileged_columns DOES block it. It lets a status change through only for privileged requests
--          (request_is_privileged(): no jwt claims, service_role, or is_admin_email()), template admins, or the #510 pending_validation reset.
--          A contractor's JWT is none of those, so the RPC's UPDATE would raise 42501 "review/validation columns are admin-managed".
--        So this migration replaces enforce_template_privileged_columns with the live body plus ONE extra allowance, inside the status check only:
--        pass when set_config('oq.template_submit') = 'on' (transaction-local, set by the RPC around its single UPDATE) AND current_user NOT IN ('authenticated','anon')
--        (only code running as the function owner, i.e. inside a SECURITY DEFINER function, qualifies; a client cannot satisfy this even if it sets the GUC)
--        AND OLD.status IN (pending_validation, manual_mapping_pending) AND NEW.status = 'submitted_for_admin_review'. Nothing else is relaxed:
--        the reviewed_by / reviewed_at / admin_notes check below it is unchanged.
--   The admin queue filter is unchanged. Both d199-validation.tsx call sites switch to the RPC in the same PR.
BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_template_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.request_is_privileged()
     OR EXISTS (SELECT 1 FROM public.contractors
                 WHERE user_id = (SELECT auth.uid())
                   AND template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;

  -- #510: permit the freeze_verdict re-validation reset (status->pending_validation
  -- + validation_result->NULL) that accompanies a template re-upload/re-map.
  -- gh-3199: also permit exactly one transition, written by submit_template_for_admin_review():
  -- (pending_validation | manual_mapping_pending) -> submitted_for_admin_review, and only while the
  -- transaction-local flag oq.template_submit is 'on' AND the code runs as the function owner
  -- (current_user is not a client role: not authenticated, not anon), so a client-set GUC alone never opens this.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       NEW.status = 'pending_validation'
       AND NEW.validation_result IS NULL
       AND (
         NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path
         OR NEW.manual_overrides IS DISTINCT FROM OLD.manual_overrides
         OR NEW.trade IS DISTINCT FROM OLD.trade
         OR NEW.funding_type IS DISTINCT FROM OLD.funding_type
       )
     )
     AND NOT (
       coalesce(current_setting('oq.template_submit', true), '') = 'on'
       AND current_user NOT IN ('authenticated', 'anon')
       AND OLD.status IN ('pending_validation', 'manual_mapping_pending')
       AND NEW.status = 'submitted_for_admin_review'
     ) THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.admin_notes IS DISTINCT FROM OLD.admin_notes THEN
    RAISE EXCEPTION 'contractor_templates: review/validation columns are admin-managed'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_template_for_admin_review(
  p_template_id uuid,
  p_overrides jsonb,
  p_missing_fields text[]
)
RETURNS public.contractor_templates
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_new_overrides jsonb;
  v_row public.contractor_templates;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_template_id IS NULL THEN
    RAISE EXCEPTION 'template id required' USING ERRCODE = '22023';
  END IF;
  IF p_overrides IS NOT NULL AND jsonb_typeof(p_overrides) <> 'object' THEN
    RAISE EXCEPTION 'overrides must be a JSON object' USING ERRCODE = '22023';
  END IF;

  -- Caller's own row only. Not-found and not-yours give the same error (no oracle for template ids).
  SELECT t.status, t.manual_overrides
    INTO v_status, v_new_overrides
    FROM public.contractor_templates t
    JOIN public.contractors c ON c.id = t.contractor_id
   WHERE t.id = p_template_id
     AND c.user_id = v_uid
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'template not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_status IS NULL OR v_status NOT IN ('pending_validation', 'manual_mapping_pending') THEN
    RAISE EXCEPTION 'template cannot be submitted for admin review from its current status'
      USING ERRCODE = '55000';
  END IF;

  -- v_new_overrides currently holds the stored value; replace it only when the caller sent something.
  IF p_overrides IS NOT NULL OR p_missing_fields IS NOT NULL THEN
    v_new_overrides := coalesce(p_overrides, '{}'::jsonb)
      || CASE WHEN p_missing_fields IS NOT NULL AND cardinality(p_missing_fields) > 0
              THEN jsonb_build_object('_missing_fields', to_jsonb(p_missing_fields))
              ELSE '{}'::jsonb END;
  END IF;

  PERFORM set_config('oq.template_submit', 'on', true);

  UPDATE public.contractor_templates
     SET status = 'submitted_for_admin_review',
         manual_overrides = v_new_overrides
   WHERE id = p_template_id
  RETURNING * INTO v_row;

  PERFORM set_config('oq.template_submit', 'off', true);

  IF v_row.id IS NULL OR v_row.status <> 'submitted_for_admin_review' THEN
    RAISE EXCEPTION 'status transition did not apply' USING ERRCODE = 'XX000';
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_template_for_admin_review(uuid, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_template_for_admin_review(uuid, jsonb, text[]) TO authenticated;

COMMENT ON FUNCTION public.submit_template_for_admin_review(uuid, jsonb, text[]) IS
  'gh-3199 (#2717 Q2): the only path to contractor_templates.status = submitted_for_admin_review for a regular contractor. Owner from auth.uid(); from pending_validation or manual_mapping_pending only; writes manual_overrides and status in one statement; sets the transaction-local oq.template_submit flag that enforce_template_privileged_columns honours for this one transition.';

DO $$
DECLARE r record;
BEGIN
  SELECT p.prosecdef, p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x
    INTO r
    FROM pg_proc p
   WHERE p.oid = 'public.submit_template_for_admin_review(uuid,jsonb,text[])'::regprocedure;
  IF NOT r.prosecdef OR r.anon_x OR r.public_x OR NOT r.auth_x
     OR NOT (r.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'gh3199 self-check failed: %', r;
  END IF;
END $$;

COMMIT;
