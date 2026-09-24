-- gh-2121 (LRS HO-1 S16): goal/activation write-back from an Arm-F-style
-- `?lead=<uuid>` deep link to the account and purchase/upload it produces.
-- CEO RUN 67 audit (ceo67-audit-ho1-20260924.md row S16): the app captures
-- and strips `?lead=` (gh-2046) but nothing writes it back anywhere --
-- confirmed by re-reading supabase/migrations/20260916132127_gh1994_router_
-- leads_columns.sql's own COMMENT ON COLUMN public.leads.converted_user_id:
-- "reserved for a future backfill... not written anywhere in phase 1." A
-- live code search (react-app, this repo, 2026-09-24) found zero writers of
-- converted_user_id anywhere -- this migration is that first writer.
--
-- Scope, and what this migration deliberately does NOT touch: no money-path
-- file (create-payment-intent, create-hover-order, stripe-webhook) is
-- edited by this PR at all -- the join this migration enables goes through
-- the EXISTING claims.user_id / hover_orders.claim_id / claims.
-- loss_sheet_parsed_at columns, none of which are new. This migration only
-- adds (a) the one RPC needed to populate the already-existing, already-
-- reserved converted_user_id column from the client, and (b) a read-only
-- view joining leads -> claims -> hover_orders/loss-sheet for cro-daily.
-- Two new objects, one already-existing nullable column populated for the
-- first time, zero ALTERs beyond IF NOT EXISTS safety. Additive only.
--
-- Schema/policy re-verified LIVE (production yeszghaspzwwstvsrioa) before
-- drafting this file:
--   SELECT column_name FROM information_schema.columns WHERE
--     table_schema='public' AND table_name='leads' AND
--     column_name='converted_user_id';
--   -> present, uuid, nullable (added by 20260916132127, never populated).
--   SELECT policyname, cmd, qual FROM pg_policies WHERE schemaname='public'
--     AND tablename IN ('claims','hover_orders');
--   -> claims_admin_select (SELECT, is_admin_email()), hover_orders_admin_all
--      (ALL, is_admin_email()) both already exist -- the view below is
--      created security_invoker so an admin caller's existing read access
--      via those policies is what makes it return rows; it grants no new
--      privilege.
--
-- Statements below are written to be safe to run more than once (repo
-- convention: `IF NOT EXISTS` / `DROP ... IF EXISTS`), matching
-- 20260916132127's own convention for this exact table.

BEGIN;

-- 1. set_lead_converted RPC -----------------------------------------------
-- Same shape as get_lead_prefill/set_lead_role/update_lead_contact in
-- 20260916132127: `leads` has no anon/authenticated UPDATE policy (only
-- "leads_admin_select", admin-only SELECT), so a SECURITY DEFINER RPC is
-- the only anon/authenticated-safe path to writing this column, exactly
-- like those three existing writers.
--
-- Guard: a wider window than get_lead_prefill/set_lead_role/
-- update_lead_contact's shared 30 minutes (those guard a same-visit
-- destination-page read/correct; this guards "did this browser complete
-- the signup form it was prefilled for," which reasonably takes longer
-- than the visit that redeemed the prefill) -- 24 hours, chosen to cover a
-- distracted/interrupted signup without leaving the id exploitable
-- indefinitely. First write wins: only fires when converted_user_id IS
-- NULL, so a lead can be claimed by exactly one account, once, ever --
-- never overwritten by a later call (e.g. a second browser tab, or a
-- replayed id) once a real signup has already claimed it. p_user_id is not
-- separately authorized against the caller's own JWT here (the caller may
-- still be anon at this point -- GoTrue can return a user with no live
-- session when email confirmation is required, exactly like
-- get_lead_prefill and set_lead_role's own anon callers); the
-- leads_converted_user_id_fkey FK (20260916132127) still rejects any
-- p_user_id that is not a real auth.users row, and the 24h+first-write
-- guard bounds what a forged id can do to "attribute one already-known
-- lead id to one already-real, freshly-created account" -- a marketing
-- attribution row, not an access grant to anything.
CREATE OR REPLACE FUNCTION public.set_lead_converted(
  p_lead_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_lead_id IS NULL THEN
    RAISE EXCEPTION 'set_lead_converted: lead id required';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'set_lead_converted: user id required';
  END IF;

  UPDATE public.leads
     SET converted_user_id = p_user_id
   WHERE id = p_lead_id
     AND created_at > now() - interval '24 hours'
     AND converted_user_id IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- Project default privileges grant EXECUTE on new public functions to anon
-- and authenticated explicitly (see 20260916132127's own note, same
-- reasoning: the caller of this RPC, get-started/page.tsx's handleSubmit,
-- runs immediately after supabase.auth.signUp() and may still be
-- unauthenticated at that point when email confirmation is required).
REVOKE ALL ON FUNCTION public.set_lead_converted(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_converted(uuid, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.set_lead_converted(uuid, uuid) IS
  'gh-2121 (LRS HO-1 S16): SECURITY DEFINER write-back of leads.converted_user_id, called once from get-started/page.tsx handleSubmit right after a successful supabase.auth.signUp() when window.__oqRouterLeadId (gh-2046 strip script) was set. RETURNS boolean -- true only when a row was actually claimed (lead exists, created within 24h, not already converted); false is not an error. First write wins: never overwrites an existing converted_user_id.';

COMMENT ON COLUMN public.leads.converted_user_id IS
  'gh-1994: FK to auth.users(id), ON DELETE SET NULL. Forced NULL on INSERT by trg_leads_force_safe_insert_defaults. gh-2121 (LRS HO-1 S16, 2026-09-24): now written by set_lead_converted(), called from get-started/page.tsx on a successful signup when the visit carried ?lead=<uuid> -- the phase-1 "not written anywhere" state this column''s original comment described is closed as of this migration.';

-- 2. Goal/activation join view for cro-daily -------------------------------
-- security_invoker: this view carries NO privilege of its own -- a caller
-- sees exactly the rows their own RLS (claims_admin_select /
-- hover_orders_admin_all / leads_admin_select, all is_admin_email()) already
-- lets them read directly. No PII column (name/email/phone/zip) is
-- selected from `leads` -- lead_id and the derived goal fields only.
--
-- goal_type/goal_at: the earliest of (a) the claim's first hover_orders row
-- (a $15 measurement purchase -- hover_orders is only ever inserted after a
-- successful charge, see create-hover-order/index.ts) and (b) claims.
-- loss_sheet_parsed_at (stamped by parse-loss-sheet on a successful upload
-- parse). Both are EXISTING columns; this view adds no new one on claims or
-- hover_orders.
CREATE OR REPLACE VIEW public.lead_goal_events
WITH (security_invoker = true) AS
SELECT
  l.id                    AS lead_id,
  l.converted_user_id,
  l.source                AS lead_source,
  l.utm_campaign           AS lead_utm_campaign,
  l.variant                AS lead_variant,
  c.id                    AS claim_id,
  hv.first_hover_order_at,
  c.loss_sheet_parsed_at,
  LEAST(hv.first_hover_order_at, c.loss_sheet_parsed_at) AS goal_at,
  CASE
    WHEN hv.first_hover_order_at IS NOT NULL
     AND (c.loss_sheet_parsed_at IS NULL OR hv.first_hover_order_at <= c.loss_sheet_parsed_at)
      THEN 'measurement_purchase'
    WHEN c.loss_sheet_parsed_at IS NOT NULL
      THEN 'loss_sheet_upload'
    ELSE NULL
  END AS goal_type
FROM public.leads l
JOIN public.claims c ON c.user_id = l.converted_user_id
LEFT JOIN LATERAL (
  SELECT MIN(ho.created_at) AS first_hover_order_at
  FROM public.hover_orders ho
  WHERE ho.claim_id = c.id
) hv ON true
WHERE l.converted_user_id IS NOT NULL;

COMMENT ON VIEW public.lead_goal_events IS
  'gh-2121 (LRS HO-1 S16): for a lead that converted (leads.converted_user_id set by set_lead_converted()), the earliest goal event on its claim -- a $15 hover_orders measurement purchase or a parsed loss-sheet upload (claims.loss_sheet_parsed_at), whichever came first. security_invoker: returns only what the caller''s own RLS already permits (admin-only today, via claims_admin_select/hover_orders_admin_all/leads_admin_select). No PII column is selected. Read target for cro-daily.py / #2121''s scoreboard.';

COMMIT;

-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924195639_gh2121_lead_goal_writeback_rollback.sql
