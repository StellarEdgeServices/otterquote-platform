-- Rollback for supabase/migrations/20260926221500_gh2121_s16_lead_goal_security_fix.sql
-- (gh-2121, LRS HO-1 S16, REVIEW: FAIL 5849942876 D1/D4/D5 fixes).
--
-- Restores set_lead_converted(uuid) and lead_goal_events to EXACTLY the
-- definitions 20260924195639_gh2121_lead_goal_writeback.sql (PR #2163)
-- shipped -- i.e. this rollback re-introduces D1/D4/D5, it does not drop
-- the objects. That mirrors 20260924195639's own rollback style (restore
-- prior state, not delete): converted_user_id values already written under
-- the fixed function are real attribution data and are not touched either
-- way.
--
-- Roll back only if the forward migration itself is found to be wrong --
-- not as a way to "undo" the security/money fix while keeping the feature
-- live.

BEGIN;

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

REVOKE ALL ON FUNCTION public.set_lead_converted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_converted(uuid) TO authenticated;

COMMENT ON FUNCTION public.set_lead_converted(uuid) IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-24 (PR #2163 S1): SECURITY DEFINER write-back of leads.converted_user_id for auth.uid() (NOT a client-supplied user id -- an anon caller, auth.uid() IS NULL, is rejected). Called from get-started/page.tsx (password sign-up), auth-callback/page.tsx (Google OAuth landing), and help-measurements/page.tsx + help-estimate/page.tsx (an already-signed-in Arm F visitor) -- see lib/lead-capture.ts linkPendingLeadOnce(). RETURNS boolean -- true only when a row was actually claimed (lead exists, created within 24h, not already converted); false is not an error. First write wins: never overwrites an existing converted_user_id.';

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

REVOKE ALL ON public.lead_goal_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_goal_events TO service_role;

COMMENT ON VIEW public.lead_goal_events IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-24 (PR #2163 S2/S3): for a lead that converted (leads.converted_user_id set by set_lead_converted()), the SINGLE earliest goal event (a $15 hover_orders measurement purchase or a parsed loss-sheet upload, claims.loss_sheet_parsed_at) across all of that lead''s account''s claims -- exactly one row per lead_id (DISTINCT ON), never one row per claim. security_invoker, but SELECT is granted to service_role only (not anon/authenticated) -- read target for cro-daily.py / #2121''s scoreboard, which reads with the service key. No PII column is selected.';

COMMIT;
