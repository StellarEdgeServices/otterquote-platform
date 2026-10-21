-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: rollback file of set gh2849_get_lead_prefill_zip (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: forward file not applied; see gh2849_get_lead_prefill_zip.sql
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback for gh2849_get_lead_prefill_zip. Run by hand, only after the forward file was applied.
-- Restores the exact pre-gh2849 definition (gh1994, supabase/migrations/20260916132127_gh1994_router_leads_columns.sql:318-344).
-- Effect: get-started stops prefilling the ZIP (page.tsx treats a missing `zip` key as no prefill); no data changes.
-- If the migration was applied through the ledger, also delete its supabase_migrations.schema_migrations row.
BEGIN;

DROP FUNCTION public.get_lead_prefill(uuid);

CREATE FUNCTION public.get_lead_prefill(p_lead_id uuid)
RETURNS TABLE(name text, email text, phone text)
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.leads l
     SET prefill_used_at = now()
   WHERE l.id = p_lead_id
     AND l.created_at > now() - interval '30 minutes'
     AND l.prefill_used_at IS NULL
  RETURNING l.name, l.email, l.phone;
END;
$$;

REVOKE ALL ON FUNCTION public.get_lead_prefill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_lead_prefill(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_lead_prefill(uuid) IS
  'gh-1994 fix round 1: SECURITY DEFINER, single-use prefill lookup for the router''s ?lead=<uuid> redirect. Stamps prefill_used_at atomically via UPDATE...RETURNING and returns zero rows on a second call, past the 30-minute window, or for any id that never matched -- callers must treat an empty result as "no prefill available", never as an error.';

COMMIT;
