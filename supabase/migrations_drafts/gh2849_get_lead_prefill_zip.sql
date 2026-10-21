-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
-- FILE ROLE: forward file of set gh2849_get_lead_prefill_zip (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-19 under #2849 (tier:3b, Ben 6256645058). Production definition read-only via pg_get_functiondef on 2026-10-19: RETURNS TABLE(name text, email text, phone text), SECURITY DEFINER, VOLATILE, search_path=public, pg_temp, proacl {postgres=X,service_role=X,anon=X,authenticated=X}, body identical to supabase/migrations/20260916132127_gh1994_router_leads_columns.sql:318-334; leads.zip exists (text). No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2849_get_lead_prefill_zip
-- GitHub: #2849 (parent #2598, P05 New homepage). Tier: 3B (DROP + CREATE of an anon-callable SECURITY DEFINER RPC). R-097 24-hour notice.
-- Decision: D-389 (Dustin 2026-10-18 on #2801, "Store it, purpose: prefill + service area").
-- Rollback: supabase/migrations_drafts/gh2849_get_lead_prefill_zip_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2849_get_lead_prefill_zip_pre-flight.md
--
-- What changes: get_lead_prefill(uuid) also returns l.zip, so get-started can seed the property-step ZIP the homepage stored
-- (start.html writes it to leads.zip on the homeowner insert, PR #2799). Nothing else changes: same single-use guard (30-minute
-- window AND prefill_used_at IS NULL), same atomic UPDATE ... RETURNING stamp, same SECURITY DEFINER, VOLATILE, search_path, same
-- grants. A new OUT column cannot go through CREATE OR REPLACE (42P13), so the function is dropped and re-created in one
-- transaction; callers see either the old or the new function, never none. Existing callers (contractor-join, ins-1/3/5, hi-1/4/5,
-- re-1, partner-*.html, get-started page.tsx) read name/email/phone by key; an extra key is ignored by all of them.
BEGIN;

DROP FUNCTION public.get_lead_prefill(uuid);

CREATE FUNCTION public.get_lead_prefill(p_lead_id uuid)
RETURNS TABLE(name text, email text, phone text, zip text)
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
  RETURNING l.name, l.email, l.phone, l.zip;
END;
$$;

-- Same grant shape as gh1994: project default privileges grant EXECUTE to anon/authenticated explicitly, so revoke all first,
-- then grant exactly the two pre-auth roles (real anon callers, kept by gh1529_p2).
REVOKE ALL ON FUNCTION public.get_lead_prefill(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_lead_prefill(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_lead_prefill(uuid) IS
  'gh-1994 fix round 1: SECURITY DEFINER, single-use prefill lookup for the router''s ?lead=<uuid> redirect. Stamps prefill_used_at atomically via UPDATE...RETURNING and returns zero rows on a second call, past the 30-minute window, or for any id that never matched -- callers must treat an empty result as "no prefill available", never as an error. gh-2849: also returns zip (D-389: prefill the property step + service area).';

-- Post-apply assertions (fail the transaction if the shape or grants are wrong).
DO $$
DECLARE r record;
BEGIN
  SELECT pg_get_function_result(p.oid) AS res, p.prosecdef, p.provolatile, p.proconfig,
         has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
         EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_x
    INTO r
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_lead_prefill';
  IF r.res <> 'TABLE(name text, email text, phone text, zip text)' THEN RAISE EXCEPTION 'gh2849: result shape %', r.res; END IF;
  IF NOT r.prosecdef OR r.provolatile <> 'v' THEN RAISE EXCEPTION 'gh2849: security/volatility changed'; END IF;
  IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN RAISE EXCEPTION 'gh2849: search_path %', r.proconfig; END IF;
  IF NOT r.anon_x OR NOT r.auth_x THEN RAISE EXCEPTION 'gh2849: anon/authenticated EXECUTE missing'; END IF;
  IF r.public_x THEN RAISE EXCEPTION 'gh2849: PUBLIC still has EXECUTE'; END IF;
END $$;

COMMIT;
