-- STATUS (gh-1438, as of 2026-11-15T17:41Z): NOT APPLIED. EVIDENCE: read-only production SELECT 2026-11-15 (pg_get_viewdef of public.lead_goal_events equals the 20260927143606 S16 view, no gh3722 columns); PR #3729 (REVIEW 6898394451, Ben ruling: unapplied, so a draft). REPO COPY: this file only. DO NOT RUN FROM THIS DIRECTORY; at apply, Marty files it under its ledger version in supabase/migrations/ and the rollback in supabase/migrations_rollbacks/.
-- gh-3722 (P12) -- lead_goal_events cannot tell a paid goal from an organic one.
--
-- SHIPPED, NOT APPLIED. Tier 3B per the issue (view replace, append-only). The
-- author does not apply it; the CTO decides apply timing. Companion static
-- test: tests/gh3722-static-lead-goal-attribution.mjs. Rollback:
-- supabase/migrations_drafts/gh3722_lead_goal_events_paid_click_rollback.sql
--
-- Appends four columns to public.lead_goal_events (CREATE OR REPLACE VIEW may
-- only append, so the existing ten columns keep name, type and order):
--   lead_utm_source   leads.utm_source
--   lead_utm_medium   leads.utm_medium
--   lead_has_click_id boolean: fbclid, fbc or gclid IS NOT NULL (gclid: REVIEW 6898262141 M1)
--   lead_paid_click   boolean: lead_has_click_id OR source = 'meta_leadgen' (native Meta
--                     lead-form leads are paid Meta ads; Ben ruling, M2) OR
--                     lower(btrim(coalesce(utm_medium,''))) IN ('paid','cpc','paid_social',
--                     'paid-social','ppc','lead_form')
-- The click id itself is never selected. No table column is added and no new
-- identifier is stored: every value is already on public.leads (gh-1983,
-- gh-2122). The view body is otherwise byte-for-byte the live definition from
-- 20260927143606_gh2121_s16_lead_goal_security_fix.sql (checked against
-- pg_get_viewdef on yeszghaspzwwstvsrioa, 2026-11-15). Access stays
-- service_role only.
--
-- Verification after apply (closes-on of #3722), run as service_role:
--   select lead_id, lead_utm_source, lead_utm_medium, lead_has_click_id,
--          lead_paid_click, goal_type
--     from public.lead_goal_events where lead_id::text like '147641e5%';
--   -> expect chatgpt.com / false (organic control); a synthetic lead with
--      fbclid and utm_medium 'paid' -> lead_paid_click = true.

BEGIN;

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
    -- D1 fix: only a hover_orders row with a real, confirmed-amount
    -- PaymentIntent counts -- these two columns are written by
    -- create-hover-order's verifyHoverPayment() path, and only once Stripe
    -- reports the charge succeeded at the expected amount. A pending row
    -- inserted client-side before payment (lib/services.ts
    -- createHoverOrder()) never has either column set, so it is excluded.
    SELECT MIN(ho.created_at) AS first_hover_order_at
    FROM public.hover_orders ho
    WHERE ho.claim_id = c.id
      AND ho.homeowner_stripe_payment_intent_id IS NOT NULL
      AND ho.homeowner_charge_amount > 0
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
  g.claim_goal_type        AS goal_type,
  -- gh-3722: appended columns (order of the ten above is unchanged).
  l.utm_source             AS lead_utm_source,
  l.utm_medium             AS lead_utm_medium,
  (l.fbclid IS NOT NULL OR l.fbc IS NOT NULL OR l.gclid IS NOT NULL) AS lead_has_click_id,
  ((l.fbclid IS NOT NULL OR l.fbc IS NOT NULL OR l.gclid IS NOT NULL)
    OR l.source = 'meta_leadgen'
    OR lower(btrim(coalesce(l.utm_medium, ''))) IN ('paid', 'cpc', 'paid_social', 'paid-social', 'ppc', 'lead_form')) AS lead_paid_click
FROM public.leads l
JOIN claim_goals g ON g.user_id = l.converted_user_id
WHERE l.converted_user_id IS NOT NULL
  -- D5 fix: a goal only belongs to this lead if it happened at or after the
  -- lead itself was created -- an existing customer's old paid claim from
  -- before this lead ever existed must not be picked up as its goal. A
  -- claim with no goal yet (claim_goal_at NULL) is unaffected -- it still
  -- sorts last and still produces the lead's one no-goal-yet row.
  AND (g.claim_goal_at IS NULL OR g.claim_goal_at >= l.created_at)
ORDER BY l.id, g.claim_goal_at ASC NULLS LAST, g.claim_id ASC;

REVOKE ALL ON public.lead_goal_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.lead_goal_events TO service_role;

COMMENT ON VIEW public.lead_goal_events IS
  'gh-2121 (LRS HO-1 S16) + gh-3722: for a lead that converted (leads.converted_user_id set by set_lead_converted()), the SINGLE earliest CONFIRMED-PAID goal event (a hover_orders row with a real PaymentIntent + charge amount, or a parsed loss-sheet upload) at or after the lead''s own created_at, exactly one row per lead_id. gh-3722 appends lead_utm_source, lead_utm_medium, lead_has_click_id (fbclid, fbc or gclid present; the id itself is never exposed) and lead_paid_click (click id present OR source meta_leadgen OR utm_medium in paid/cpc/paid_social/paid-social/ppc/lead_form) so a goal can be classed paid vs organic. security_invoker; SELECT granted to service_role only.';

COMMIT;
