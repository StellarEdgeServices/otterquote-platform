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
-- Client-side wiring (this PR's sibling diff, not this file): each leads-
-- insert call site attaches this header to THAT INSERT ONLY, via
-- postgrest-js's per-request `.setHeader('x-oq-internal', '1')` -- never
-- via supabase-js's client-wide `global.headers` option, because that
-- would attach the header to every request the same client makes
-- (including any supabase.functions.invoke(...) call), and Edge Function
-- CORS allow-lists don't list x-oq-internal, which would break those
-- preflights for exactly the internal/admin browsers the marker is for
-- (cto36 REVIEW: FAIL, comment 5779410643, B2). Each call site computes
-- the flag itself from the exact same query-param/cookie contract
-- js/ga-gate.js's oqInternal() uses, self-contained rather than trusting
-- another script to have run first. CORRECTION (this rebase, cto38-b2068r):
-- the original text here named only two call sites and described
-- `global.headers`, both wrong. Verified (grep, this session) there are
-- THREE current `.from('leads').insert(...)` call sites in the repo:
-- start.html's insertFreshLead() (every router variant, via the bridge
-- object), react-app/app/get-started/page.tsx's persistSignupContext()
-- (react-app/app/lib/supabase.ts's client), and partner-re.html's signup
-- handler -- the third was missed by the original grep and, until this
-- rebase's sibling diff, sent no header at all (fresh-context review
-- Must-fix 2, comment 5824273357). All three now set it the same way.
-- js/config.js's and js/supabase-client.js's own client factories are
-- not otherwise in this table's insert path; a future leads-insert call
-- site built on either of them would need the same per-request header
-- wired in separately for this trigger to see it, since the trigger can
-- only act on what the request actually carries.
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
-- REBASED (cto38-b2068, claim cto38-b2068, subagent of
-- cto-2026-09-25T16:49:52Z, rebuilt on main commit 275ba875 (short sha)):
-- between this migration's original draft (2026-09-22) and this rebase,
-- 20260923211259_gh2122_leads_details_consent.sql applied on production and
-- extended leads_force_safe_insert_defaults() with FOUR MORE forced-NULL
-- assignments (funding_type, property_address, fbc, fbp -- Ben's protective-fix
-- ruling, comment 5803524541, D-299 evidence-forging guard). The forward body
-- below is the LIVE 9-assignment production body (pg_get_functiondef,
-- re-verified via Supabase MCP immediately before this rebase, prosrc md5
-- 2b25e098...0af (truncated here to keep this comment out of the repo's
-- credential-shape sweep's HEX_RUN_20 class; full value is in this PR's
-- comment thread), byte-identical to
-- 20260923211259_gh2122_leads_details_consent.sql's own body) PLUS this
-- migration's one addition: the DECLARE/guarded-read/IF block that sets
-- is_synthetic. Nothing else changed. This replaces the original draft, which
-- was built from the pre-#2126 5-assignment body and would have silently
-- reverted the funding_type/property_address/fbc/fbp guard on apply -- caught
-- by fresh-context review (comment 5824273357, Must-fix 1) and independently
-- confirmed by a rebase attempt (comment 5836439758) before this rebase.
--
-- Rollback: restores that same live 9-assignment body EXACTLY (no
-- is_synthetic IF block, no v_headers), i.e. current production behaviour --
-- not the original 5-assignment pre-gh2068/pre-gh2122 body, which would break
-- every insert into `leads` by no longer nulling funding_type/property_address/
-- fbc/fbp (those columns exist on production now; a guard that doesn't null
-- them reopens the anon-forgeable window #2126 closed). Rollback block at the
-- bottom of this file, same inline convention as
-- 20260917010217_gh1994_router_lead_alert.sql and
-- 20260916132127_gh1994_router_leads_columns.sql (this table has not been
-- granted a separate supabase/migrations_rollbacks/ file).
--
-- Filename re-stamped 20260922140801 -> 20260925175431 (stamp.py) per fresh-
-- context review comment 5824273357 Must-fix 3: the old stamp sorted before
-- the already-applied 20260923211259_gh2122_leads_details_consent.sql, which
-- would read wrong in "latest definition wins" migration ordering.
--
-- RE-STAMPED AGAIN (cto38-b2068r, this fix pass): 20260925175431 ->
-- 20260925190131 (stamp.py), because five more migrations applied to
-- production between that stamp and this pass -- 20260925180145,
-- 20260925180241, 20260925180541, 20260925180647 (gh2154 P-3/P-4) and
-- 20260925185056 (gh2154 P-4 retry-cap) -- and 20260925175431 sorted
-- before all five (list_migrations, Supabase MCP, verified immediately
-- before this restamp). This fix pass also: (a) corrected the forward
-- COMMENT ON FUNCTION to name the four gh-2122 columns it nulls
-- (funding_type/property_address/fbc/fbp), which the original comment
-- omitted even though the forward function body already nulled them
-- (Must-fix 1a); (b) corrected the forward COMMENT ON COLUMN
-- leads.is_synthetic, which claimed the header is "set by every current
-- client factory" -- it is set by exactly the three leads-insert call
-- sites (start.html, react-app, partner-re.html), each via its own
-- per-request setHeader(), not by a client-wide option (Must-fix 1b);
-- (c) corrected this file's own "Client-side wiring" header paragraph,
-- which named only two call sites and wrongly described `global.headers`
-- (Should-fix 1); (d) replaced the rollback COMMENT ON FUNCTION text below
-- with the LIVE production comment, verified via
-- `SELECT obj_description('public.leads_force_safe_insert_defaults'::regproc)`
-- immediately before this edit -- the previous rollback comment text
-- (the gh-2122/Ben-ruling wording) does not match what production
-- actually carries today, because 20260923211259_gh2122_leads_details_consent.sql
-- extended the function body but never updated its COMMENT ON FUNCTION
-- (Should-fix 2). None of (a)-(d) changes the forward or rollback
-- function BODY -- both are still byte-identical to what fresh-context
-- review verified (prosrc md5 2b25e098...0af live/rollback,
-- a0df7a0d... forward-applied).
--
-- Tier: 3B (reviewer ruling, comment 5779410643 finding 4, PR body first
-- line) -- CREATE OR REPLACE on a live SECURITY DEFINER BEFORE INSERT trigger
-- function on `topic:money-path` public.leads; additive-only in effect for
-- header-less rows, not additive in kind. Needs the CTO's 24h R-097 notice
-- before apply; not applied by this session (no merge/deploy/DB-write
-- permission here).

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
  NEW.funding_type      := NULL;
  NEW.property_address  := NULL;
  NEW.fbc               := NULL;
  NEW.fbp               := NULL;

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
  'gh-1994 fix round 1, extended gh-1994/router-lead-alert, gh-2122 and gh-2068: BEFORE INSERT guard on public.leads -- forces created_at=now() and nulls converted_user_id/role/partner_industry/alerted_at so an anon insert (with_check=true) cannot forge them, (gh-2122 / Ben ruling, comment 5803524541, D-299 evidence guard) nulls funding_type/property_address/fbc/fbp so an anon insert cannot pre-set those four Arm F / TCPA-evidence columns either (record_lead_details() is their only writer), and (gh-2068) forces is_synthetic=true whenever the request carries an X-OQ-Internal: 1 header (or, belt-and-suspenders, an oq_internal=1 cookie header) -- the server-side connecting rule between gh-2064''s client-side opt-out and gh-2055''s synthetic-data column. SECURITY DEFINER only so the function itself cannot be re-pointed by a non-owner; it grants no privilege an ordinary trigger would lack.';

COMMENT ON COLUMN public.leads.is_synthetic IS
  'gh-2055: synthetic-vs-real marker, distinct from contractors.notifications_suppressed (see that migration). NULL/false = real. Set true by two paths: (a) gh-2068''s leads_force_safe_insert_defaults() BEFORE INSERT trigger, whenever the insert request carries the oq_internal marker (X-OQ-Internal: 1 header, set per-request by this repo''s three leads-insert call sites -- start.html''s insertFreshLead(), react-app/app/get-started/page.tsx''s persistSignupContext(), and partner-re.html''s signup handler -- each computing the flag itself from the same query-param/cookie contract js/ga-gate.js''s oqInternal() uses; NOT set by every client factory in the repo, e.g. js/config.js''s and js/supabase-client.js''s own client factories are not otherwise in this table''s insert path) -- the authoritative, unconditional write-time path; (b) start.html''s insertFreshLead() also sets it directly in the insert payload for its own narrower same-page-load detection (PR #2088) -- redundant with (a) where both fire, and harmless. Rows written before either path existed (this migration, or #2088) are NOT backfilled by this change -- see #2068''s CTO RUN 36 comment for the pre-existing unmarked-row count.';

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
--   NEW.funding_type      := NULL;
--   NEW.property_address  := NULL;
--   NEW.fbc               := NULL;
--   NEW.fbp               := NULL;
--   RETURN NEW;
-- END;
-- $$;
-- COMMENT ON FUNCTION public.leads_force_safe_insert_defaults() IS
--   'gh-1994 fix round 1 (REVIEW N2): BEFORE INSERT guard on public.leads -- forces created_at=now() and nulls converted_user_id/role/partner_industry/alerted_at so an anon insert (with_check=true) cannot forge them or suppress its own alert. SECURITY DEFINER only so the function itself cannot be re-pointed by a non-owner; it grants no privilege an ordinary trigger would lack.';
-- COMMENT ON COLUMN public.leads.is_synthetic IS NULL;
-- COMMIT;
