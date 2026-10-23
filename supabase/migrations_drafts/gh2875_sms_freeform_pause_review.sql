-- STATUS (gh-1438, as of 2026-10-23): NOT APPLIED
-- FILE ROLE: forward file of set gh2875_sms_freeform_pause_review (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-23 under #2875. Production read-only (Supabase MCP execute_sql, SELECT only) 2026-10-23: sms_optout_review is absent
--   (to_regclass NULL); layer 1 (ledger 20261021013907 gh2875_d391_contractor_sms_numbers) is applied, contractor_sms_numbers and
--   sms_suppression_list are empty; md5 of pg_get_functiondef: contractor_textable_numbers(uuid) 9e531db5dda91d2028560e75d62c77cb,
--   contractor_sms_numbers_promote_primary() 9a29c4c6eca303a24b66630dd0db72ad. No database was written to produce this file.
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2875_sms_freeform_pause_review
-- GitHub: #2875 (D-391), the free-text opt-out flagger. Ruling: Marty (exec:cto), #2875 comment 6365843245: an inbound text that contains an
--   opt-out keyword as a whole word PAUSES all sends to that number and queues it for human review; it is not recorded as a full opt-out
--   until reviewed. Tier 3B (consent path). R-177: REVIEW + LEGAL-READ + CEO `R-177 SIGNED:` owed before merge. This file writes NO consent
--   or customer-facing text and NO row.
-- Rollback: supabase/migrations_drafts/gh2875_sms_freeform_pause_review_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2875_sms_freeform_pause_review_pre-flight.md
--
-- What it adds: (1) public.sms_optout_review, the review queue; a row with status 'pending' IS the pause. (2) public.sms_number_paused(text),
-- the one read every sender uses. (3) CREATE OR REPLACE of the two layer-1 functions that already carry the suppression test, adding the pause
-- test, so contractor_textable_numbers() (the sender read) and primary promotion both exclude a paused number. No table, column or privilege of
-- layer 1 changes. Pausing needs no suppression row, so the START-only release rule on sms_suppression_list is untouched.
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; CREATE OR REPLACE FUNCTION; DROP POLICY IF EXISTS before CREATE.
-- Apply order: this file BEFORE deploying twilio-sms-optout / send-sms / process-dunning from the same PR (the send-path lookup treats a
-- missing table as 'not paused'; the webhook insert would 500 and Twilio would retry).

BEGIN;

DO $gate$
BEGIN
  IF to_regclass('public.sms_suppression_list') IS NULL OR to_regclass('public.contractor_sms_numbers') IS NULL THEN
    RAISE EXCEPTION 'gh2875 pause gate: layer 1 (gh2875_d391_contractor_sms_numbers) is not applied';
  END IF;
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh2875 pause gate: public.is_admin_email() is missing';
  END IF;
END
$gate$;

-- 1. The review queue. History rows stay (they are evidence of what we saw and who decided).
CREATE TABLE IF NOT EXISTS public.sms_optout_review (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164         text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  inbound_body       text NOT NULL,
  matched_keywords   text[] NOT NULL CHECK (cardinality(matched_keywords) > 0),
  message_sid        text,
  flagged_at         timestamptz NOT NULL DEFAULT now(),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cleared', 'confirmed_opt_out')),
  reviewed_at        timestamptz,
  reviewed_by_email  text,
  review_note        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_optout_review_decision_recorded CHECK (
    status = 'pending' OR (reviewed_at IS NOT NULL AND btrim(coalesce(reviewed_by_email, '')) <> '' AND btrim(coalesce(review_note, '')) <> ''))
);
-- A Twilio retry of the same inbound message must not queue it twice.
CREATE UNIQUE INDEX IF NOT EXISTS sms_optout_review_message_sid_uniq ON public.sms_optout_review (message_sid) WHERE message_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_optout_review_pending_phone_idx ON public.sms_optout_review (phone_e164) WHERE status = 'pending';

-- 2. The pause read.
CREATE OR REPLACE FUNCTION public.sms_number_paused(p_phone text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.sms_optout_review r WHERE r.phone_e164 = p_phone AND r.status = 'pending')
$fn$;
REVOKE ALL ON FUNCTION public.sms_number_paused(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sms_number_paused(text) TO service_role;

-- 2b. A pending row cannot be resolved as 'confirmed_opt_out' unless the number is ALREADY on the open suppression list. Without this, confirming
-- an opt-out would remove the pause and resume texting a person who revoked. The review step must open the suppression row first (service_role),
-- then confirm. 'cleared' (a person decided it was not an opt-out) needs no such row.
CREATE OR REPLACE FUNCTION public.sms_optout_review_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.status = 'confirmed_opt_out' AND NOT EXISTS (
       SELECT 1 FROM public.sms_suppression_list s WHERE s.phone_e164 = NEW.phone_e164 AND s.released_at IS NULL) THEN
    RAISE EXCEPTION 'gh2875: cannot confirm an opt-out for % without an open suppression row', NEW.phone_e164 USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.sms_optout_review_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS sms_optout_review_guard ON public.sms_optout_review;
CREATE TRIGGER sms_optout_review_guard BEFORE INSERT OR UPDATE OF status ON public.sms_optout_review
  FOR EACH ROW EXECUTE FUNCTION public.sms_optout_review_guard();

-- 3. Privileges and RLS: service_role writes (the webhook, and the review screen when it is built); admins read.
REVOKE ALL ON public.sms_optout_review FROM anon, authenticated;
GRANT SELECT ON public.sms_optout_review TO authenticated;
GRANT ALL ON public.sms_optout_review TO service_role;
ALTER TABLE public.sms_optout_review ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sms_optout_review_admin_read ON public.sms_optout_review;
CREATE POLICY sms_optout_review_admin_read ON public.sms_optout_review FOR SELECT TO authenticated USING (public.is_admin_email());

-- 4. Layer-1 functions, redefined with the pause test added (otherwise byte-for-byte the layer-1 definitions).
CREATE OR REPLACE FUNCTION public.contractor_textable_numbers(p_contractor_id uuid)
RETURNS TABLE (number_id uuid, phone_e164 text, is_primary boolean)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT n.id, n.phone_e164, n.is_primary
    FROM public.contractor_sms_numbers n
   WHERE n.contractor_id = p_contractor_id
     AND n.status = 'verified'
     AND n.last_confirmed_at > now() - interval '395 days'
     AND NOT EXISTS (SELECT 1 FROM public.sms_suppression_list s
                      WHERE s.phone_e164 = n.phone_e164 AND s.released_at IS NULL)
     AND NOT public.sms_number_paused(n.phone_e164)
   ORDER BY n.is_primary DESC, n.verified_at, n.id
$fn$;
REVOKE ALL ON FUNCTION public.contractor_textable_numbers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contractor_textable_numbers(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.contractor_sms_numbers_promote_primary()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.is_primary AND NOT NEW.is_primary AND NOT EXISTS (
       SELECT 1 FROM public.contractor_sms_numbers p WHERE p.contractor_id = NEW.contractor_id AND p.is_primary) THEN
    UPDATE public.contractor_sms_numbers SET is_primary = true
     WHERE id = (SELECT o.id FROM public.contractor_sms_numbers o
                  WHERE o.contractor_id = NEW.contractor_id AND o.status = 'verified'
                    AND o.last_confirmed_at > now() - interval '395 days'
                    AND NOT EXISTS (SELECT 1 FROM public.sms_suppression_list s
                                     WHERE s.phone_e164 = o.phone_e164 AND s.released_at IS NULL)
                    AND NOT public.sms_number_paused(o.phone_e164)
                  ORDER BY o.verified_at, o.id LIMIT 1);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.contractor_sms_numbers_promote_primary() FROM PUBLIC, anon, authenticated;

COMMIT;
