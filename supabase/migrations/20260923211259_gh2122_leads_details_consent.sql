-- gh-2122 (Arm F, #2121 row 1.1): durable storage for what the homeowner short
-- path collects BEFORE any account exists -- the funding answer, the property
-- address, the Meta browser ids -- and the D-299 TCPA consent evidence.
-- Authorised by Ben (CEO RUN 66, claim ceo-2026-09-23T18:56:07Z), "A: MIGRATION: GO"
-- on #2122 (comment 5802853627), answering Kevin's Q 5802781694. Tier 3A
-- (additive: nullable columns, one new table, one new function, one config row;
-- nothing dropped, renamed, retyped or rewritten) under D-261, no R-097 window.
--
-- WHY THIS EXISTS. Measured on production yeszghaspzwwstvsrioa, 2026-09-23,
-- read-only: public.leads has 21 columns and NONE of them holds a funding answer,
-- a property address, fbc/fbp, or any consent evidence; and there is no consent
-- table (information_schema search on '%consent%' / '%tcpa%' returned nothing).
-- Without this, Arm F would create real leads that are then called with no
-- stored TCPA record. D-299 requires the rendered consent language, timestamp,
-- IP, user agent, page URL and payload to be retained per submission.
--
-- WHAT IT DOES NOT TOUCH (Ben's ruling, stated so a reviewer can check the diff):
--   * leads_force_safe_insert_defaults() and trg_leads_force_safe_insert_defaults
--     -- untouched. The new columns are written by an UPDATE inside the RPC below,
--     never by an anon INSERT, so the BEFORE INSERT guard is irrelevant to them.
--   * trg_notify_admin_new_router_lead -- untouched. It fires only when role goes
--     NULL -> non-NULL; the RPC below never writes role, so it cannot re-alert.
--   * Every RLS policy on public.leads -- untouched. No policy is created, dropped
--     or altered there.
--   * NO CHECK constraint is added to public.leads. 20260918122231_gh2011_leads_variant.sql
--     records why (a CHECK on a measurement column can reject a revenue record and
--     `leads` has no UPDATE policy). Normalisation to the allowed funding values
--     happens inside the RPC instead, so a bad value becomes NULL, never an error.
--
-- HOW THE DATA GETS IN. The browser cannot write these itself: an anon client has
-- no UPDATE policy on `leads` and no INSERT policy on the new table, and the
-- client IP is not visible to browser JS. So the write is ONE server hop: the new
-- Edge Function `record-lead-details` reads the client IP from the request headers
-- and calls public.record_lead_details() below with the service role. That is the
-- only role that can EXECUTE it (see the grants section).
--
-- Companion rollback: supabase/migrations_rollbacks/20260923211259_gh2122_leads_details_consent_rollback.sql
-- Companion pre-flight: supabase/migrations_rollbacks/20260923211259_gh2122_leads_details_consent_pre-flight.md

BEGIN;

-- 1. leads: four nullable columns ---------------------------------------------
-- Additive and nullable with no default: no table rewrite, no backfill, and every
-- existing row (and every non-Arm-F writer) reads NULL, which is the correct
-- "not collected" state. Written once, by record_lead_details() only.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS funding_type     text,
  ADD COLUMN IF NOT EXISTS property_address text,
  ADD COLUMN IF NOT EXISTS fbc              text,
  ADD COLUMN IF NOT EXISTS fbp              text;

COMMENT ON COLUMN public.leads.funding_type IS
  'gh-2122: Arm F screen-1 answer, normalised by record_lead_details() to insurance | cash | unsure (anything else is stored as NULL). Not constrained by a CHECK on purpose -- see the header of 20260923211259_gh2122_leads_details_consent.sql.';
COMMENT ON COLUMN public.leads.property_address IS
  'gh-2122: the property address as typed on Arm F screen 2, trimmed and capped at 300 characters by record_lead_details(). Personal data. Admin/service-role read only (leads_admin_select).';
COMMENT ON COLUMN public.leads.fbc IS
  'gh-2122: Meta click id cookie (_fbc), capped at 200 characters. Used for server-side Meta attribution.';
COMMENT ON COLUMN public.leads.fbp IS
  'gh-2122: Meta browser id cookie (_fbp), capped at 200 characters.';

-- 2. lead_consents: the D-299 evidence store ----------------------------------
-- One row per (lead, consent key) -- the unique constraint is what makes the
-- Edge Function safe to retry once without writing a second evidence row.
-- consent_given records BOTH outcomes: a row with consent_given = false is the
-- evidence of what was displayed when the visitor did not tick the box.
-- consent_text is the exact rendered string, so the record survives any later
-- copy change. ip/user_agent are what the server observed, never client-claimed.
-- lead_id is ON DELETE RESTRICT: TCPA evidence must outlive casual cleanup, so a
-- lead that has consent evidence cannot be deleted until an explicit, deliberate
-- retention decision removes its evidence rows first. (No code path deletes from
-- `leads` today -- see the 2026-09-22 leads-delete pass on #2096 -- so this blocks
-- nothing that exists.)
CREATE TABLE IF NOT EXISTS public.lead_consents (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid        NOT NULL REFERENCES public.leads(id) ON DELETE RESTRICT,
  consent_key   text        NOT NULL,
  consent_given boolean     NOT NULL,
  consent_text  text        NOT NULL,
  page_url      text,
  user_agent    text,
  ip            text,
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_consents_lead_key_uniq UNIQUE (lead_id, consent_key)
);

COMMENT ON TABLE public.lead_consents IS
  'gh-2122 / D-299: per-submission TCPA consent evidence for router leads (exact rendered text, given/not given, page URL, server-observed IP and user agent, non-PII payload summary). Written only by record_lead_details() via the record-lead-details Edge Function (service role). RLS on with no policy: anon and authenticated cannot read or write it.';
COMMENT ON COLUMN public.lead_consents.consent_text IS
  'The exact string rendered next to the checkbox at submit time, capped at 2000 characters.';
COMMENT ON COLUMN public.lead_consents.ip IS
  'Client IP as seen by the Edge Function (cf-connecting-ip, else the first x-forwarded-for hop). Server-observed, never client-supplied.';

ALTER TABLE public.lead_consents ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policy: with RLS on, that denies anon and authenticated
-- everything. service_role bypasses RLS.

-- Supabase default privileges grant new public tables to anon and authenticated.
-- Strip them explicitly (RLS alone is one layer; the grant is the other).
REVOKE ALL ON TABLE public.lead_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.lead_consents TO service_role;

-- 3. record_lead_details(): the one write path ------------------------------------
-- SECURITY DEFINER so it can UPDATE `leads` and INSERT the evidence row while the
-- caller (the Edge Function, service role) holds no table policy of its own on the
-- anon side. Guard mirrors set_lead_role()/update_lead_contact(): the lead must have
-- been created in the last 30 minutes and must not have been redeemed by a
-- destination page (prefill_used_at IS NULL), so knowing an old lead id lets nobody
-- rewrite it. First write wins (COALESCE): a retry, or a second call, cannot
-- overwrite what is already stored. Returns true when the lead row was in scope,
-- false when it was not (unknown id, too old, or redeemed) -- never raises for a
-- state problem, so the Edge Function can report it without a 500.
CREATE OR REPLACE FUNCTION public.record_lead_details(
  p_lead_id          uuid,
  p_funding_type     text,
  p_property_address text,
  p_fbc              text,
  p_fbp              text,
  p_consent_key      text,
  p_consent_given    boolean,
  p_consent_text     text,
  p_page_url         text,
  p_user_agent       text,
  p_ip               text,
  p_payload          jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_touched integer;
BEGIN
  IF p_lead_id IS NULL THEN
    RAISE EXCEPTION 'record_lead_details: p_lead_id is required';
  END IF;
  IF p_consent_key IS NULL OR btrim(p_consent_key) = '' THEN
    RAISE EXCEPTION 'record_lead_details: p_consent_key is required';
  END IF;
  IF p_consent_given IS NULL THEN
    RAISE EXCEPTION 'record_lead_details: p_consent_given is required (true or false)';
  END IF;
  IF p_consent_text IS NULL OR btrim(p_consent_text) = '' THEN
    RAISE EXCEPTION 'record_lead_details: p_consent_text (the exact rendered string) is required';
  END IF;

  UPDATE public.leads
     SET funding_type     = COALESCE(funding_type,
                                     CASE WHEN lower(btrim(p_funding_type)) IN ('insurance', 'cash', 'unsure')
                                          THEN lower(btrim(p_funding_type)) END),
         property_address = COALESCE(property_address, left(NULLIF(btrim(p_property_address), ''), 300)),
         fbc              = COALESCE(fbc, left(NULLIF(btrim(p_fbc), ''), 200)),
         fbp              = COALESCE(fbp, left(NULLIF(btrim(p_fbp), ''), 200))
   WHERE id = p_lead_id
     AND created_at > now() - interval '30 minutes'
     AND prefill_used_at IS NULL;
  GET DIAGNOSTICS v_touched = ROW_COUNT;

  IF v_touched = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.lead_consents
    (lead_id, consent_key, consent_given, consent_text, page_url, user_agent, ip, payload)
  VALUES
    (p_lead_id,
     left(btrim(p_consent_key), 100),
     p_consent_given,
     left(p_consent_text, 2000),
     left(NULLIF(btrim(p_page_url), ''), 2000),
     left(NULLIF(btrim(p_user_agent), ''), 1000),
     left(NULLIF(btrim(p_ip), ''), 64),
     p_payload)
  ON CONFLICT (lead_id, consent_key) DO NOTHING;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.record_lead_details(uuid, text, text, text, text, text, boolean, text, text, text, text, jsonb) IS
  'gh-2122: the single write path for Arm F details + D-299 consent evidence. SECURITY DEFINER; EXECUTE is granted to service_role ONLY (called by the record-lead-details Edge Function, which supplies the server-observed IP and user agent). First write wins; 30-minute / prefill_used_at guard as set_lead_role(). Returns false when the lead is out of scope, never raises for that.';

-- Supabase default privileges grant EXECUTE on every new public function to anon
-- AND authenticated; REVOKE FROM PUBLIC alone does not remove them (v95/v95a
-- lesson, GitHub #571). Name every role, then grant the one that needs it.
REVOKE ALL ON FUNCTION public.record_lead_details(uuid, text, text, text, text, text, boolean, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_lead_details(uuid, text, text, text, text, text, boolean, text, text, text, text, jsonb)
  TO service_role;

-- 4. rate_limit_config row, IN LOCKSTEP with the function that calls it ---------
-- check_rate_limit() fails CLOSED when a function has no row here ("that default
-- has produced this exact outage four times now" -- see the header of
-- 20260908194734_gh1724_check_email_exists_rate_limit.sql), so the row ships in
-- the same migration as the Edge Function that needs it, never after.
-- Judgment call, not traffic-validated: a real visitor makes one call, two with the
-- single retry. 30/hour, 100/day, 1000/month per IP bucket leaves room for many
-- households behind one carrier or in-app-browser NAT address and still stops a
-- scripted burst. Raise it if a legitimate visitor is ever throttled.
INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('record-lead-details', 30, 100, 1000, true, 0.0000, 0.00,
   'gh2122: per-IP synthetic-UUID bucket (sha256 of "record-lead-details:<ip>", not a real user_id -- this endpoint is called pre-auth from /start?v=f). One call per Arm F submit, two with the single retry. Starting judgment call; raise if a legitimate visitor is throttled.')
ON CONFLICT (function_name) DO NOTHING;

COMMIT;

-- =============================================================================
-- ROLLBACK lives in supabase/migrations_rollbacks/ (NOT here: a file in this
-- directory would be applied by the Supabase runner as a migration). See
-- 20260923211259_gh2122_leads_details_consent_rollback.sql.
-- =============================================================================
