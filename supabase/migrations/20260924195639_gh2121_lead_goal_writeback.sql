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
-- file (create-payment-intent, create-hover-order, create-measurement-order,
-- stripe-webhook) is edited by this PR at all -- the join this migration
-- enables goes through the EXISTING claims.user_id / hover_orders.claim_id /
-- claims.loss_sheet_parsed_at columns, none of which are new. This migration
-- only adds (a) the one RPC needed to populate the already-existing,
-- already-reserved converted_user_id column from the client, and (b) a
-- read-only, per-lead view joining leads -> claims -> hover_orders/
-- loss-sheet for cro-daily. Two new objects, one already-existing nullable
-- column populated for the first time, zero ALTERs beyond IF NOT EXISTS
-- safety. Additive only.
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
--      created security_invoker so an admin/service-role caller's existing
--      read access is what makes it return rows; it grants no new privilege.
--
-- REVISION 2026-09-24 (PR #2163 REVIEW: FAIL, comment 5821864061, S1-S3):
-- the first draft of this migration took a p_user_id argument on
-- set_lead_converted straight from the client with no server-side check
-- that it matched the caller's own JWT -- any anon caller could link ANY
-- lead id to ANY user id it could guess/enumerate. S1 fixes that: the
-- function now derives the linked account from auth.uid() itself and
-- rejects a caller with no session at all (anon). S2: lead_goal_events
-- could return more than one row per lead (a converted user with more than
-- one claims row joined once per claim) -- now collapsed to exactly one row
-- per lead (the earliest goal across that lead's claims), documented on the
-- view comment. S3: the view had no REVOKE/GRANT of its own, so it
-- inherited default SELECT for anon/authenticated project-wide -- now
-- explicitly service-role-only.
--
-- Statements below are written to be safe to run more than once (repo
-- convention: `IF NOT EXISTS` / `DROP ... IF EXISTS`), matching
-- 20260916132127's own convention for this exact table.

BEGIN;

-- 1. set_lead_converted RPC -----------------------------------------------
-- Same shape as get_lead_prefill/set_lead_role/update_lead_contact in
-- 20260916132127: `leads` has no anon/authenticated UPDATE policy (only
-- "leads_admin_select", admin-only SELECT), so a SECURITY DEFINER RPC is
-- the only authenticated-safe path to writing this column.
--
-- S1 fix: the account linked is auth.uid() -- read server-side from the
-- caller's own JWT -- not a client-supplied p_user_id. A caller with no
-- session (auth.uid() IS NULL, i.e. anon) is rejected outright rather than
-- silently no-op'd, so this is never mistaken for "ran, matched nothing."
-- This does mean the call must happen once the caller genuinely holds a
-- session (post-signUp with email confirmation OFF, the Google OAuth
-- landing, or an already-signed-in visit) -- an anon-at-call-time window
-- (email confirmation required) is not linked by this call; that gap is
-- unchanged from before this revision and is not what S1 asked to fix.
--
-- Guard: a wider window than get_lead_prefill/set_lead_role/
-- update_lead_contact's shared 30 minutes (those guard a same-visit
-- destination-page read/correct; this guards "did this browser complete
-- sign-in for the visit it was captured on," which reasonably takes longer
-- than the visit that redeemed the prefill) -- 24 hours, chosen to cover a
-- distracted/interrupted signup without leaving the id exploitable
-- indefinitely. First write wins: only fires when converted_user_id IS
-- NULL, so a lead can be claimed by exactly one account, once, ever --
-- never overwritten by a later call (e.g. a second browser tab, or a
-- replayed id) once a real signup has already claimed it.
DROP FUNCTION IF EXISTS public.set_lead_converted(uuid, uuid);

CREATE OR REPLACE FUNCTION public.set_lead_converted(
  p_lead_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows int;
  v_uid uuid;
BEGIN
  IF p_lead_id IS NULL THEN
    RAISE EXCEPTION 'set_lead_converted: lead id required';
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    -- S1: reject an anon caller outright -- no anonymous write of this
    -- column is ever valid, whatever p_lead_id claims to be.
    RAISE EXCEPTION 'set_lead_converted: authentication required' USING ERRCODE = '28000';
  END IF;

  UPDATE public.leads
     SET converted_user_id = v_uid
   WHERE id = p_lead_id
     AND created_at > now() - interval '24 hours'
     AND converted_user_id IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

-- S1: EXECUTE is granted to `authenticated` only -- NOT anon. auth.uid()
-- would already reject an anon caller inside the function body, but not
-- granting EXECUTE at all is the belt to that suspenders (an anon caller
-- gets a permission-denied at the RPC layer, never reaches the guard).
REVOKE ALL ON FUNCTION public.set_lead_converted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_converted(uuid) TO authenticated;

COMMENT ON FUNCTION public.set_lead_converted(uuid) IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-24 (PR #2163 S1): SECURITY DEFINER write-back of leads.converted_user_id for auth.uid() (NOT a client-supplied user id -- an anon caller, auth.uid() IS NULL, is rejected). Called from get-started/page.tsx (password sign-up), auth-callback/page.tsx (Google OAuth landing), and help-measurements/page.tsx + help-estimate/page.tsx (an already-signed-in Arm F visitor) -- see lib/lead-capture.ts linkPendingLeadOnce(). RETURNS boolean -- true only when a row was actually claimed (lead exists, created within 24h, not already converted); false is not an error. First write wins: never overwrites an existing converted_user_id.';

COMMENT ON COLUMN public.leads.converted_user_id IS
  'gh-1994: FK to auth.users(id), ON DELETE SET NULL. Forced NULL on INSERT by trg_leads_force_safe_insert_defaults. gh-2121 (LRS HO-1 S16, revised 2026-09-24): now written by set_lead_converted(p_lead_id), which links auth.uid() (never a client-supplied id, PR #2163 S1) -- the phase-1 "not written anywhere" state this column''s original comment described is closed as of this migration.';

-- 2. Goal/activation join view for cro-daily -------------------------------
-- security_invoker: this view carries NO privilege of its own -- a caller
-- sees exactly the rows their own RLS (claims_admin_select /
-- hover_orders_admin_all / leads_admin_select, all is_admin_email(), or the
-- service role, which bypasses RLS) already lets them read directly. No PII
-- column (name/email/phone/zip) is selected from `leads` -- lead_id and the
-- derived goal fields only.
--
-- S2 fix: the first draft joined leads -> claims directly (one row PER
-- CLAIM, not per lead) -- a converted lead whose account has more than one
-- claims row would appear more than once, breaking "one row per lead" for
-- any per-lead aggregate (e.g. a naive COUNT(*) in cro-daily.py). Rewritten
-- below as an aggregate: claim_goals computes each claim's own earliest
-- goal event (unchanged logic from the first draft, per claim), then
-- DISTINCT ON (lead_id) collapses to exactly one row per lead -- the
-- EARLIEST goal across all of that lead's account's claims (NULLS LAST, so
-- a lead with claims but no goal yet still gets exactly one row, with
-- goal_at/goal_type NULL, rather than disappearing).
--
-- goal_type/goal_at per claim: the earlier of (a) the claim's first
-- hover_orders row (a $15 measurement purchase -- hover_orders is only ever
-- inserted after a successful charge, see create-hover-order/index.ts) and
-- (b) claims.loss_sheet_parsed_at (stamped by parse-loss-sheet on a
-- successful upload parse). Both are EXISTING columns; this view adds no
-- new one on claims or hover_orders.
CREATE OR REPLACE VIEW public.lead_goal_events
WITH (security_invoker = true) AS
WITH claim_goals AS (
  SELECT
    c.user_id,
    c.id                     AS claim_id,
    hv.first_hover_order_at,
    c.loss_sheet_parsed_at,
    LEAST(hv.first_hover_order_at, c.loss_sheet_parsed_at) AS claim_goal_at,
    CASE
      WHEN hv.first_hover_order_at IS NOT NULL
       AND (c.loss_sheet_parsed_at IS NULL OR hv.first_hover_order_at <= c.loss_sheet_parsed_at)
        THEN 'measurement_purchase'
      WHEN c.loss_sheet_parsed_at IS NOT NULL
        THEN 'loss_sheet_upload'
      ELSE NULL
    END AS claim_goal_type
  FROM public.claims c
  LEFT JOIN LATERAL (
    SELECT MIN(ho.created_at) AS first_hover_order_at
    FROM public.hover_orders ho
    WHERE ho.claim_id = c.id
  ) hv ON true
)
-- DISTINCT ON (l.id), with l.id as the ORDER BY's leading expression,
-- collapses this to exactly one row per lead (S2): the earliest-goal claim
-- wins per lead; a claim with no goal yet (claim_goal_at NULL) sorts last,
-- so a lead is only represented by a no-goal-yet row when NONE of its
-- account's claims have reached one.
SELECT DISTINCT ON (l.id)
  l.id                     AS lead_id,
  l.converted_user_id,
  l.source                 AS lead_source,
  l.utm_campaign           AS lead_utm_campaign,
  l.variant                AS lead_variant,
  g.claim_id,
  g.first_hover_order_at,
  g.loss_sheet_parsed_at,
  g.claim_goal_at          AS goal_at,
  g.claim_goal_type        AS goal_type
FROM public.leads l
JOIN claim_goals g ON g.user_id = l.converted_user_id
WHERE l.converted_user_id IS NOT NULL
ORDER BY l.id, g.claim_goal_at ASC NULLS LAST, g.claim_id ASC;

-- S3 fix: the first draft granted no explicit privilege on the view at
-- all, so it inherited the project's default SELECT grant to anon/
-- authenticated on new public objects -- readable by any signed-in (or
-- even anonymous, depending on project defaults) client despite
-- security_invoker, since an admin caller's OWN read access via
-- claims_admin_select/hover_orders_admin_all was the only thing standing
-- between "no rows" and "every row" for a non-admin authenticated caller
-- who happened to also be is_admin_email() -- not a real barrier for the
-- intended cro-daily/service-role-only readership. Explicitly service-role
-- only now.
REVOKE ALL ON public.lead_goal_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_goal_events TO service_role;

COMMENT ON VIEW public.lead_goal_events IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-24 (PR #2163 S2/S3): for a lead that converted (leads.converted_user_id set by set_lead_converted()), the SINGLE earliest goal event (a $15 hover_orders measurement purchase or a parsed loss-sheet upload, claims.loss_sheet_parsed_at) across all of that lead''s account''s claims -- exactly one row per lead_id (DISTINCT ON), never one row per claim. security_invoker, but SELECT is granted to service_role only (not anon/authenticated) -- read target for cro-daily.py / #2121''s scoreboard, which reads with the service key. No PII column is selected.';

COMMIT;

-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924195639_gh2121_lead_goal_writeback_rollback.sql
