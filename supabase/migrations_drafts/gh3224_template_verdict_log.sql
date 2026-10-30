-- STATUS (gh-1438, as of 2026-10-30T13:30Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3224_template_verdict_log (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-30 under #3224 (CEO scope comment 6523657464); production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): no contractor_template_verdicts table, no log_template_admin_verdict trigger; contractor_templates has 13 rows (0 rejected, 1 admin_validated); live bodies of contractor_templates_freeze_verdict and enforce_template_privileged_columns read via pg_get_functiondef and NOT modified by this set
-- REPO COPY: none (not applied; when applied, file under its real ledger version in supabase/migrations/ and the rollback in supabase/migrations_rollbacks/)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-3224: durable record of the last ADMIN verdict on a contractor template, so that a template an
-- admin rejected can never be turned into auto_validated / manual_validated without an admin.
--
-- WHY A LOG TABLE AND NOT A COLUMN ON contractor_templates
--   contractor_templates carries a self RLS policy (contractor_templates_self, cmd *) and authenticated has
--   UPDATE and DELETE on it. A marker column would be clearable by the contractor (UPDATE ... SET col = NULL
--   is not covered by enforce_template_privileged_columns), and a contractor could also DELETE the rejected
--   row and INSERT a fresh one in the same slot (unique_active_template is on contractor_id, trade,
--   funding_type), which drops any column with it. A separate table that the contractor has no privilege on
--   survives both. It is append-only, so "last admin verdict" is the newest row and an admin who later
--   validates a corrected template supersedes the rejection by an ordinary new row (no clearing needed).
--
-- COMPOSITION
--   Does NOT touch contractor_templates_freeze_verdict (the upload reset keeps working unchanged and has no
--   column here to clear) or enforce_template_privileged_columns (PR #3214 / gh3199 replaces that function;
--   this set is independent of it, apply order between the two does not matter).
--
-- READ BY: the validate-contract-template Edge Function (service role) through
--   template_admin_verdict_blocks_auto_validation(uuid). APPLY THIS BEFORE DEPLOYING THAT FUNCTION VERSION:
--   the new code fails closed (no write, HTTP 500) when the lookup errors, and only consults it when a scan
--   would otherwise write auto_validated / manual_validated.
--
-- Idempotent: every statement can be re-run.

BEGIN;

-- ------------------------------------------------------------------ table
CREATE TABLE IF NOT EXISTS public.contractor_template_verdicts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id   uuid        NOT NULL,   -- deliberately NO foreign key: the record must outlive a deleted row
  contractor_id uuid        NOT NULL,
  trade         text        NOT NULL,
  funding_type  text        NOT NULL,
  verdict       text        NOT NULL CHECK (verdict IN ('rejected', 'admin_validated')),
  actor         uuid,                   -- auth.uid() of the admin when there was a JWT, else NULL
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ctv_template ON public.contractor_template_verdicts (template_id, recorded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_ctv_slot ON public.contractor_template_verdicts (contractor_id, trade, funding_type, recorded_at DESC, id DESC);

ALTER TABLE public.contractor_template_verdicts ENABLE ROW LEVEL SECURITY;   -- no policies: deny by default
-- Production's pg_default_acl for postgres in public grants arwdDxtm on every new table to anon, authenticated
-- AND service_role, and service_role has BYPASSRLS, so service_role must be revoked explicitly (REVIEW
-- 6524262213 R1). After this: relacl = {postgres=arwdDxt, service_role=r}. The writer below is SECURITY
-- DEFINER owned by postgres, so logging does not depend on service_role holding INSERT.
REVOKE ALL ON public.contractor_template_verdicts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.contractor_template_verdicts TO service_role;

-- append-only: no UPDATE, DELETE or TRUNCATE by any role that is not the table owner or a superuser (the grants
-- above refuse those to every API role; the triggers below refuse them even to a role holding the privilege,
-- short of dropping or disabling the triggers, which only the owner can do). INSERT is the only write, and only
-- the owner and the SECURITY DEFINER writer hold it.
CREATE OR REPLACE FUNCTION public.contractor_template_verdicts_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'contractor_template_verdicts is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_ctv_append_only ON public.contractor_template_verdicts;
CREATE TRIGGER trg_ctv_append_only
  BEFORE UPDATE OR DELETE ON public.contractor_template_verdicts
  FOR EACH ROW EXECUTE FUNCTION public.contractor_template_verdicts_append_only();
-- TRUNCATE fires no row triggers, so it needs its own statement-level trigger.
DROP TRIGGER IF EXISTS trg_ctv_no_truncate ON public.contractor_template_verdicts;
CREATE TRIGGER trg_ctv_no_truncate
  BEFORE TRUNCATE ON public.contractor_template_verdicts
  FOR EACH STATEMENT EXECUTE FUNCTION public.contractor_template_verdicts_append_only();
-- a trigger function cannot be called directly; revoked anyway so the default ACL leaves nothing behind (REVIEW N3)
REVOKE ALL ON FUNCTION public.contractor_template_verdicts_append_only() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------- writer (fires for any actor)
-- AFTER trigger: it sees the row as stored, so a contractor write that
-- enforce_template_privileged_columns / freeze_verdict refused or rewrote never logs a verdict.
CREATE OR REPLACE FUNCTION public.log_template_admin_verdict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('rejected', 'admin_validated')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO public.contractor_template_verdicts (template_id, contractor_id, trade, funding_type, verdict, actor)
    VALUES (NEW.id, NEW.contractor_id, NEW.trade, NEW.funding_type, NEW.status, (SELECT auth.uid()));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.log_template_admin_verdict() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_contractor_templates_log_verdict ON public.contractor_templates;
CREATE TRIGGER trg_contractor_templates_log_verdict
  AFTER INSERT OR UPDATE OF status ON public.contractor_templates
  FOR EACH ROW EXECUTE FUNCTION public.log_template_admin_verdict();

-- ----------------------------------------------------------------- backfill
-- Rows already in a verdict status. Live on 2026-10-30: 0 rejected, 1 admin_validated.
INSERT INTO public.contractor_template_verdicts (template_id, contractor_id, trade, funding_type, verdict, actor, recorded_at)
SELECT t.id, t.contractor_id, t.trade, t.funding_type, t.status, t.reviewed_by, coalesce(t.reviewed_at, t.updated_at, now())
FROM public.contractor_templates t
WHERE t.status IN ('rejected', 'admin_validated')
  AND NOT EXISTS (SELECT 1 FROM public.contractor_template_verdicts v WHERE v.template_id = t.id);

-- ------------------------------------------------------------------- reader
-- true when the newest admin verdict for this template row, OR for its slot
-- (contractor_id, trade, funding_type), is 'rejected'. Both are checked so that neither a delete-and-reupload
-- (new row id, same slot) nor a trade/funding change (same row id, new slot) sheds the rejection.
CREATE OR REPLACE FUNCTION public.template_admin_verdict_blocks_auto_validation(p_template_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((SELECT v.verdict = 'rejected'
                     FROM public.contractor_template_verdicts v
                    WHERE v.template_id = p_template_id
                    ORDER BY v.recorded_at DESC, v.id DESC LIMIT 1), false)
      OR coalesce((SELECT v.verdict = 'rejected'
                     FROM public.contractor_templates t
                     JOIN public.contractor_template_verdicts v
                       ON v.contractor_id = t.contractor_id AND v.trade = t.trade AND v.funding_type = t.funding_type
                    WHERE t.id = p_template_id
                    ORDER BY v.recorded_at DESC, v.id DESC LIMIT 1), false);
$$;
REVOKE ALL ON FUNCTION public.template_admin_verdict_blocks_auto_validation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.template_admin_verdict_blocks_auto_validation(uuid) TO service_role;

COMMIT;
