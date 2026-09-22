-- Migration: gh2068_leads_oq_internal_synthetic_flag
-- Issue: #2068 -- "[DATA MODEL, money] `leads` inserts carrying the
--        `oq_internal` marker must be written with the #2055 synthetic-data
--        column = true -- the server-side half RUN 56's 13 synthetic-row
--        incident is still missing"
-- Parent chain: #2047 (is_test overload) -> #2055 (adds leads.is_synthetic,
--        merged, ADD COLUMN only, no reader -- comment 5752694347) and
--        #2064 (client-side oq_internal opt-out cookie/flag, PR #2066).
--        This issue is the missing connecting rule both of those left
--        explicitly for it: #2055's own closing note says so verbatim
--        ("#2068 is the server-side writer", comment 5769126333).
--
-- Scope, per the issue body: a server-side rule on the `leads` write path
-- that, when the inbound request carries the oq_internal marker, writes
-- is_synthetic = true unconditionally at write time -- not backfilled
-- after. Explicitly OUT of scope (per the issue): naming/adding the column
-- (#2055, done), the mint-test-session structural fix (#1513), any
-- analytics-side change (#2064), and a backfill of existing unmarked rows
-- (raised by Marty, CTO RUN 36, comment 5777865315, 2026-09-22 -- 17 of 87
-- production `leads` rows are @example.com with no marker at all; that is
-- a data cleanup, not a write-path defect, and stays out of this migration
-- for the same reason #2055 refused to backfill is_synthetic itself:
-- "backfilling values... stay on #2047").
--
-- Mechanism: `public.leads` already has exactly one BEFORE INSERT trigger,
-- trg_leads_force_safe_insert_defaults -> leads_force_safe_insert_defaults()
-- (supabase/migrations/20260916132127_gh1994_router_leads_columns.sql,
-- extended once already by
-- supabase/migrations/20260917010217_gh1994_router_lead_alert.sql to also
-- null alerted_at). It is the one place this table already forces safe
-- values on every insert regardless of what an anon client sends (the
-- anon INSERT policy is WITH CHECK (true)), so it is also the one place
-- that catches every CURRENT and FUTURE leads-insert call site
-- automatically, without each one having to remember to set is_synthetic
-- itself -- exactly the property the issue's "unconditionally, at write
-- time -- not backfilled after" language asks for. This migration adds one
-- IF block to that existing function; it does not touch the trigger
-- definition, the other four forced columns, or anything else on the
-- table.
--
-- Signal: request.headers, populated by PostgREST for every request it
-- handles (table INSERT or RPC alike) -- the same GUC already read by
-- record_cpa_ip()/record_attestation_ip()
-- (20260101000000_v000_baseline_schema.sql) and register_partner()
-- (20260820004212_gh1059_partner_agreement_acceptance.sql) for IP/UA
-- capture. Primary check is an explicit `X-OQ-Internal: 1` request header
-- -- a HEADER, not the `oq_internal` cookie itself, because both insert
-- call sites (start.html's ensureSb(), react-app/app/lib/supabase.ts) call
-- the Supabase REST API on a different origin
-- (yeszghaspzwwstvsrioa.supabase.co) than the `.otterquote.com`-scoped
-- cookie gh-2064 sets, and supabase-js does not send credentials
-- cross-origin -- the cookie itself never reaches PostgREST. Confirmed
-- live before writing this migration: an OPTIONS preflight against
-- production's own /rest/v1/leads with
-- `Access-Control-Request-Headers: x-oq-internal, apikey, content-type`
-- returned `access-control-allow-headers` reflecting all three back
-- (Supabase's hosted gateway allows arbitrary request headers), so this
-- header reaches PostgREST with no project config change required. A
-- `cookie` header check is included as a harmless belt-and-suspenders
-- fallback only, for any future same-origin proxy path that would
-- actually forward it.
--
-- Client-side wiring (this PR's sibling diff, not this file): start.html's
-- ensureSb() and react-app/app/lib/supabase.ts both now pass this header
-- via supabase-js's `global.headers` client option, computed once at
-- client-creation time from the exact same query-param/cookie contract
-- js/ga-gate.js's oqInternal() and react-app/app/lib/internal-traffic.ts's
-- isInternalTraffic() already use -- so it is set consistently for every
-- insert either client makes, present or future, without a per-call-site
-- opt-in. Verified (grep, this session): these two files are the ONLY
-- places in the repo that call `.from('leads').insert(...)` today
-- (start.html's insertFreshLead(), called by every router variant via the
-- bridge object, and react-app/app/get-started/page.tsx's
-- persistSignupContext()) -- js/config.js's and js/supabase-client.js's
-- own client factories are not currently in this table's insert path, so
-- they are not touched here; a future leads-insert call site built on
-- either of them would need the same header wired in separately for this
-- trigger to see it, since the trigger can only act on what the request
-- actually carries.
--
-- Interaction with start.html's existing client-side is_synthetic write
-- (PR #2088, merged ahead of this issue): start.html's insertFreshLead()
-- already sets `payload.is_synthetic = true` directly for its own narrower
-- oq_internal detection (query-param-only, and only for arm E's override
-- or the same-page-load walk case -- see that file's own comments).
-- Unaffected by this migration: CREATE OR REPLACE FUNCTION only ADDS a new
-- IF block; it does not touch, and cannot un-set, whatever the client
-- payload sent. Where both fire, the result is the same `true`. Where the
-- client payload sends nothing (react-app, or a start.html page whose walk
-- carried the cookie but not the query param this page load), this
-- migration's header check is what actually sets it.
--
-- Rollback: restore leads_force_safe_insert_defaults() to its pre-gh2068
-- body (the exact body live in production as of 2026-09-22, re-verified
-- against pg_proc.prosrc immediately before drafting this file). Rollback
-- block at the bottom of this file, same inline convention as
-- 20260917010217_gh1994_router_lead_alert.sql and
-- 20260916132127_gh1994_router_leads_columns.sql (this table has not been
-- granted a separate supabase/migrations_rollbacks/ file).
--
-- Tier: additive-only in effect (CREATE OR REPLACE on an existing
-- function; no new column, no existing column's meaning changed for any
-- row that does not carry the new header) -- classification left to the
-- claim-holder's own tier judgement per this repo's process; not
-- self-applied here.

BEGIN;

CREATE OR REPLACE FUNCTION public.leads_force_safe_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_headers jsonb;
BEGIN
  NEW.created_at        := now();
  NEW.converted_user_id := NULL;
  NEW.role              := NULL;
  NEW.partner_industry  := NULL;
  NEW.alerted_at        := NULL;

  -- gh-2068: server-side half of gh-2064's oq_internal opt-out -- see this
  -- migration's header comment for the full mechanism and why a header
  -- (not the oq_internal cookie itself) is what reaches PostgREST here.
  -- Read inside its own BEGIN/EXCEPTION block, like every other
  -- request.headers read in this codebase, so a missing or malformed GUC
  -- can never fail the insert of a real lead.
  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  IF (v_headers->>'x-oq-internal') = '1'
     OR (COALESCE(v_headers->>'cookie', '') ~ '(^|; )oq_internal=1(;|$)') THEN
    NEW.is_synthetic := true;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.leads_force_safe_insert_defaults() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.leads_force_safe_insert_defaults() IS
  'gh-1994 fix round 1, extended gh-1994/router-lead-alert and gh-2068: BEFORE INSERT guard on public.leads -- forces created_at=now() and nulls converted_user_id/role/partner_industry/alerted_at so an anon insert (with_check=true) cannot forge them, and (gh-2068) forces is_synthetic=true whenever the request carries an X-OQ-Internal: 1 header (or, belt-and-suspenders, an oq_internal=1 cookie header) -- the server-side connecting rule between gh-2064''s client-side opt-out and gh-2055''s synthetic-data column. SECURITY DEFINER only so the function itself cannot be re-pointed by a non-owner; it grants no privilege an ordinary trigger would lack.';

COMMENT ON COLUMN public.leads.is_synthetic IS
  'gh-2055: synthetic-vs-real marker, distinct from contractors.notifications_suppressed (see that migration). NULL/false = real. Set true by two paths: (a) gh-2068''s leads_force_safe_insert_defaults() BEFORE INSERT trigger, whenever the insert request carries the oq_internal marker (X-OQ-Internal: 1 header, set by every current client factory in this repo''s own leads-insert path from the same query-param/cookie contract js/ga-gate.js''s oqInternal() uses) -- the authoritative, unconditional write-time path; (b) start.html''s insertFreshLead() also sets it directly in the insert payload for its own narrower same-page-load detection (PR #2088) -- redundant with (a) where both fire, and harmless. Rows written before either path existed (this migration, or #2088) are NOT backfilled by this change -- see #2068''s CTO RUN 36 comment for the pre-existing unmarked-row count.';

COMMIT;

-- ROLLBACK (manual -- restores the pre-gh2068 body, re-verified live
-- against production pg_proc.prosrc immediately before this file was
-- drafted; identical to the body 20260917010217_gh1994_router_lead_alert.sql
-- last left it).
--
-- BEGIN;
-- CREATE OR REPLACE FUNCTION public.leads_force_safe_insert_defaults()
-- RETURNS trigger
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = public, pg_temp
-- AS $$
-- BEGIN
--   NEW.created_at        := now();
--   NEW.converted_user_id := NULL;
--   NEW.role              := NULL;
--   NEW.partner_industry  := NULL;
--   NEW.alerted_at        := NULL;
--   RETURN NEW;
-- END;
-- $$;
-- COMMENT ON FUNCTION public.leads_force_safe_insert_defaults() IS
--   'gh-1994 fix round 1: BEFORE INSERT guard on public.leads -- forces created_at=now() and nulls converted_user_id/role/partner_industry/alerted_at so an anon insert (with_check=true) cannot forge them or suppress its own alert. SECURITY DEFINER only so the function itself cannot be re-pointed by a non-owner; it grants no privilege an ordinary trigger would lack.';
-- COMMENT ON COLUMN public.leads.is_synthetic IS NULL;
-- COMMIT;
