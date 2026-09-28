-- gh-2121 (LRS HO-1 S16) -- REVIEW: FAIL 5849942876 fixes D1/D4/D5 against
-- the view/RPC that 20260924195639_gh2121_lead_goal_writeback.sql (PR #2163)
-- already shipped and that migration has already been applied to
-- production (yeszghaspzwwstvsrioa) -- confirmed live via read-only
-- Supabase MCP SQL, comment 5836101654. This migration amends those two
-- objects in place (CREATE OR REPLACE); it adds no new table, RLS policy or
-- privilege grantee beyond what 20260924195639 already granted.
--
-- SHIPPED, NOT APPLIED (same posture as 20260924195639 and PR #2226's
-- migrations): this worker is hard-limited from applying a migration or
-- writing to any database under any circumstance. This file, and its
-- companion proof supabase/tests/gh2121_s16_lead_goal_proof.sql, are for an
-- operator with DB access (Ben/Marty/executive-dispatched refuter) to apply
-- and run.
--
-- D1 -- MONEY (blocking): the original view's claim_goals CTE took
-- MIN(ho.created_at) over EVERY hover_orders row for a claim, with no
-- payment filter. lib/services.ts's createHoverOrder() inserts a
-- status='pending' hover_orders row from the browser, with no
-- PaymentIntent, before the create-hover-order Edge Function ever runs --
-- so a reload-before-paying leaves a permanent unpaid row that the old view
-- counted as a completed $15 measurement_purchase goal. Fix: require both
-- homeowner_stripe_payment_intent_id IS NOT NULL and
-- homeowner_charge_amount > 0 -- the two columns create-hover-order's
-- verifyHoverPayment() path writes, and ONLY after Stripe confirms
-- 'succeeded' at the expected amount (see supabase/migrations/
-- 20260101000000_v000_baseline_schema.sql:577-604 for both columns'
-- definitions). A paid order whose downstream Hover call then fails never
-- gets counted either (its PaymentIntent id/amount are still written by
-- verifyHoverPayment before the Hover call, so this is not expected to
-- under-count in practice -- noted per the reviewer's comment as a
-- theoretical, safe-direction gap, not fixed here).
--
-- D4 -- SECURITY (blocking): set_lead_converted(p_lead_id) checked only
-- that the caller was signed in, the lead was <24h old and unclaimed --
-- nothing tied the lead to the account claiming it. Since the id travels as
-- a bare query-string parameter (?lead=<uuid>), a signed-in visitor who
-- edits it to someone else's fresh lead id could claim that lead
-- permanently (first-write-wins) and have their own purchase/upload
-- credited to the victim's Arm F attribution. Fix (the reviewer's proposed
-- minimal patch, comment 5849942876 D4): require the caller's own JWT email
-- to match the lead's email, when the lead has one on file (email is
-- NOT NULL on leads per the baseline schema, so today this always applies
-- for a normal Arm F row; the IS NULL branch is defensive only, for any
-- lead ever inserted without one). This is a stopgap -- the real fix is
-- #2226's hashed lead_token model (resolve_lead_by_token), which is not
-- merged yet; once it lands, this RPC should be revisited to accept a
-- token instead of a raw id, per the reviewer's D4 note.
--
-- D5 -- ATTRIBUTION (blocking): the view joined ALL of the converted user's
-- claims, so an existing customer's OLD paid claim (predating the Arm F
-- lead entirely) could be picked up as "the" goal for a brand-new lead
-- that same user later linked. Fix: a claim's goal only counts toward a
-- lead if it happened at or after that lead's created_at.
--
-- D3 (overlap with PR #2226, not merged as of this migration): #2226 adds
-- lead_measurement_orders/lead_loss_sheet_uploads, keyed by lead_id
-- directly (no converted_user_id hop), and once it lands the Arm F
-- thank-you CTAs move to /measure-lead and /loss-sheet-lead by default,
-- with /help-measurements|estimate surviving only as a token-mint-failure
-- fallback. This view does not read those tables -- they do not exist on
-- main yet. Deferred to a follow-up migration once #2226 merges (adding a
-- UNION ALL branch per the reviewer's sketch); tracked as a Q: on #2121,
-- not implemented here.
--
-- Statements are idempotent (CREATE OR REPLACE / DROP ... IF EXISTS),
-- matching 20260924195639's own convention.

BEGIN;

-- 1. set_lead_converted: add the D4 email-match guard --------------------
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
    -- S1 (PR #2163): reject an anon caller outright -- no anonymous write
    -- of this column is ever valid, whatever p_lead_id claims to be.
    RAISE EXCEPTION 'set_lead_converted: authentication required' USING ERRCODE = '28000';
  END IF;

  -- D4 fix: the caller's own JWT email must match the lead's email (case-
  -- insensitive) when the lead has one on file. leads.email is NOT NULL on
  -- every Arm F row, so this is not a no-op guard in practice -- it closes
  -- the "edit ?lead= to someone else's uuid" hijack the reviewer described,
  -- without requiring #2226's token model to land first.
  UPDATE public.leads
     SET converted_user_id = v_uid
   WHERE id = p_lead_id
     AND created_at > now() - interval '24 hours'
     AND converted_user_id IS NULL
     AND (email IS NULL OR lower(email) = lower(auth.jwt() ->> 'email'));

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.set_lead_converted(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lead_converted(uuid) TO authenticated;

COMMENT ON FUNCTION public.set_lead_converted(uuid) IS
  'gh-2121 (LRS HO-1 S16), revised 2026-09-26 (REVIEW: FAIL 5849942876, D4): SECURITY DEFINER write-back of leads.converted_user_id for auth.uid(), now ALSO requiring the caller''s JWT email to match the lead''s email (case-insensitive) when the lead has one -- closes the raw-uuid hijack (a signed-in visitor editing ?lead= to someone else''s fresh lead id). Stopgap ahead of PR #2226''s hashed lead_token model. First write wins; 24h window; anon rejected outright.';

-- 2. lead_goal_events: add the D1 payment filter and D5 time-order guard --
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
  'gh-2121 (LRS HO-1 S16), revised 2026-09-26 (REVIEW: FAIL 5849942876, D1/D5): for a lead that converted (leads.converted_user_id set by set_lead_converted()), the SINGLE earliest CONFIRMED-PAID goal event (a hover_orders row with a real PaymentIntent + charge amount, or a parsed loss-sheet upload) at or after the lead''s own created_at, across all of that lead''s account''s claims -- exactly one row per lead_id. A pending/unpaid hover_orders row and a pre-lead-existence claim are both excluded. security_invoker; SELECT granted to service_role only.';

COMMIT;
