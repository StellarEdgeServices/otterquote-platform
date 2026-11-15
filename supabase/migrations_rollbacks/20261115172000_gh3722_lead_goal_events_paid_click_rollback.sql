-- Rollback for 20261115172000_gh3722_lead_goal_events_paid_click.sql (gh-3722).
-- CREATE OR REPLACE cannot drop columns, so drop and recreate the view with the
-- S16 definition (20260927143606_gh2121_s16_lead_goal_security_fix.sql). Nothing
-- depends on the view (service_role reads only); re-check pg_depend first.
-- Not applied by the author.

BEGIN;

DROP VIEW IF EXISTS public.lead_goal_events;

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
  g.claim_goal_type        AS goal_type
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
  'gh-2121 (LRS HO-1 S16), restored by gh-3722 rollback: for a lead that converted (leads.converted_user_id set by set_lead_converted()), the SINGLE earliest CONFIRMED-PAID goal event (a hover_orders row with a real PaymentIntent + charge amount, or a parsed loss-sheet upload) at or after the lead''s own created_at, exactly one row per lead_id.'
;

COMMIT;
