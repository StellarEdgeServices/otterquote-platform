-- STATUS (gh-1438, as of 2026-10-23): NOT APPLIED
-- FILE ROLE: rollback file of set gh2875_sms_freeform_pause_review (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-23 under #2875. Production read-only (Supabase MCP execute_sql, SELECT only) 2026-10-23: sms_optout_review is absent
--   (to_regclass NULL); layer 1 (ledger 20261021013907 gh2875_d391_contractor_sms_numbers) is applied, contractor_sms_numbers and
--   sms_suppression_list are empty; md5 of pg_get_functiondef: contractor_textable_numbers(uuid) 9e531db5dda91d2028560e75d62c77cb,
--   contractor_sms_numbers_promote_primary() 9a29c4c6eca303a24b66630dd0db72ad. No database was written to produce this file.
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Restores the layer-1 definitions of the two functions (verbatim from gh2875_d391_contractor_sms_numbers.sql), then drops the pause objects.
-- DATA LOSS WARNING: dropping sms_optout_review discards any pending flags, which un-pauses those numbers. Export the table first if any
-- row exists, and review every pending row before running this.
BEGIN;
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
                  ORDER BY o.verified_at, o.id LIMIT 1);
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.contractor_sms_numbers_promote_primary() FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.sms_number_paused(text);
DROP TABLE IF EXISTS public.sms_optout_review;
COMMIT;
