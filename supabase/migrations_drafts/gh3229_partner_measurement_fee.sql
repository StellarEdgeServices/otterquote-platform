-- STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3229_partner_measurement_fee (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3229 (P18). Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa): no partner_fee_events table;
--   hover_orders has no is_test column and no refund column (refund = process-hover-rebate sets rebate_paid_at after the Stripe refund; stripe-webhook has no charge.refunded handler);
--   payout_approvals.referral_id is nullable (FK ON DELETE SET NULL) but payout_approvals_payout_type_check admits only commission_referral and commission_recruit;
--   payout_approvals RLS: admin (is_admin_email()) all, partners read own rows by partner_id; referral_agents.agent_type has home_inspector (D-333), payments_blocked is NOT NULL;
--   platform_settings keys: no partner_measurement_fee_cents, no partner_payout_minimum_cents; referral_attribution_window() is IMMUTABLE 30 days (PR #3226 makes it a STABLE platform_settings read; this file only calls it);
--   apply_referral_commission() (pg_get_functiondef read) is the model for the is_test-agree, window and D-333 checks. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3229_partner_measurement_fee
-- GitHub: #3229 (PROJECT P18). Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097.
-- Rollback: gh3229_partner_measurement_fee_rollback.sql   Pre-flight: gh3229_partner_measurement_fee_pre-flight.md
-- Proof: supabase/tests/gh3229_partner_measurement_fee_proof.sql   Local run: supabase/tests/gh3229_partner_measurement_fee_local_run.sh
--
-- Founder decision 2026-10-30: every partner earns a $5 referral fee per paid homeowner measurement, accrued and paid monthly at a $25 minimum,
-- by hand (payouts stay manual: pending_approval -> approve-payout -> mark-payout-paid). The $200 completed-job fee is unchanged. D-333 applies to the $5.
--
-- What this file does
--   1. platform_settings: partner_measurement_fee_cents (500) and partner_payout_minimum_cents (2500); both read at use time.
--   2. payout_approvals_payout_type_check admits 'measurement_fees_monthly' (the monthly batch row; referral_id stays NULL).
--   3. partner_fee_events (ledger, one row per paid homeowner measurement) + RLS: a partner reads own rows, admin all, no client writes.
--   4. AFTER INSERT trigger on hover_orders (insert only, so editing an older order never backfills; create-measurement-order writes role, payment, amount and claim in one INSERT): a homeowner-paid order accrues one row when the claim carries a credited referral
--      inside the attribution window (D-402: from the partner click to the measurement order's own created_at, length from referral_attribution_window()), is_test agrees on claim/referral/agent, and the agent is not a home inspector. UNIQUE(hover_order_id) and UNIQUE(payment_ref) (the PaymentIntent id, else the charge id), so a retried payment that produced a second order row accrues once.
--      It never raises: the order is written after the buyer's money moved, so a fee-side failure is logged (WARNING) and the order stands.
--   5. NO void on refund (CEO ruling, #3236): the fee is earned when the purchase completes. The job-completion rebate (rebate_paid_at) does not touch
--      it. The status 'void' stays in the table for a manual correction. A refund made by hand in the Stripe dashboard is not detected (no charge.refunded handler).
--   6. get_partner_dashboard_stats(): the caller's numbers from auth.uid() only; rows whose is_test matches the caller's (a test partner sees test rows, a real
--      partner real rows); includes per-recruit recruit-bonus earnings.
--   7. create_monthly_fee_batch(p_month): admin/service-role only; one payout_approvals row per partner at or above the minimum; idempotent.
--   8. A payout_approvals AFTER UPDATE OF status trigger flips its batched events to paid when the payout becomes paid (atomic with the payout);
--      partner_fee_events_mark_paid(payout id), service-role only, stays as an idempotent repair tool and is still called by mark-payout-paid.
--   9. Rejecting a batch payout, or deleting it, releases its events back to accrued (so the money is not stranded as batched).
--  Month boundaries are America/New_York (the business day), not UTC; only past months can be batched.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 1. settings -------------------------------------------------------------------------------------------------------------------------
INSERT INTO public.platform_settings (key, value) VALUES
  ('partner_measurement_fee_cents', to_jsonb(500)),
  ('partner_payout_minimum_cents',  to_jsonb(2500))
ON CONFLICT (key) DO NOTHING;

-- 2. payout type ------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.payout_approvals DROP CONSTRAINT IF EXISTS payout_approvals_payout_type_check;
ALTER TABLE public.payout_approvals ADD CONSTRAINT payout_approvals_payout_type_check
  CHECK (payout_type = ANY (ARRAY['commission_referral'::text, 'commission_recruit'::text, 'measurement_fees_monthly'::text]));

-- 3. ledger -----------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.partner_fee_events (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_agent_id  uuid        NOT NULL REFERENCES public.referral_agents(id) ON DELETE RESTRICT,
  referral_id        uuid        REFERENCES public.referrals(id) ON DELETE SET NULL,
  claim_id           uuid        REFERENCES public.claims(id) ON DELETE SET NULL,
  hover_order_id     uuid        REFERENCES public.hover_orders(id) ON DELETE SET NULL,
  payment_ref        text        NOT NULL,   -- the Stripe PaymentIntent id, else the charge id: one fee per payment, even if a retry made two order rows
  event_type         text        NOT NULL DEFAULT 'measurement_purchase' CHECK (event_type IN ('measurement_purchase')),
  amount_cents       integer     NOT NULL CHECK (amount_cents > 0),
  status             text        NOT NULL DEFAULT 'accrued' CHECK (status IN ('accrued', 'batched', 'paid', 'void')),
  payout_approval_id uuid        REFERENCES public.payout_approvals(id) ON DELETE SET NULL,
  is_test            boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  voided_at          timestamptz,
  paid_at            timestamptz,
  CONSTRAINT partner_fee_events_hover_order_id_key UNIQUE (hover_order_id),
  CONSTRAINT partner_fee_events_payment_ref_key UNIQUE (payment_ref),
  CONSTRAINT partner_fee_events_void_stamp CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CONSTRAINT partner_fee_events_paid_stamp CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);

COMMENT ON TABLE public.partner_fee_events IS
  'gh-3229 (P18): one row per paid homeowner measurement credited to a partner ($5 default, platform_settings.partner_measurement_fee_cents at insert time). accrued -> batched (create_monthly_fee_batch) -> paid (mark-payout-paid); void on refund. Written only by SECURITY DEFINER functions.';

CREATE INDEX IF NOT EXISTS partner_fee_events_agent_status_idx ON public.partner_fee_events (referral_agent_id, status);
CREATE INDEX IF NOT EXISTS partner_fee_events_payout_idx ON public.partner_fee_events (payout_approval_id) WHERE payout_approval_id IS NOT NULL;

ALTER TABLE public.partner_fee_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Partners read own fee events" ON public.partner_fee_events;
CREATE POLICY "Partners read own fee events" ON public.partner_fee_events
  FOR SELECT TO authenticated
  USING (referral_agent_id IN (SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS "Admin reads all fee events" ON public.partner_fee_events;
CREATE POLICY "Admin reads all fee events" ON public.partner_fee_events
  FOR SELECT TO authenticated
  USING (public.is_admin_email());

-- no INSERT/UPDATE/DELETE policy exists, and no write grant: only the SECURITY DEFINER functions below (and service_role) write.
REVOKE ALL ON public.partner_fee_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.partner_fee_events TO authenticated;
GRANT ALL ON public.partner_fee_events TO service_role;

-- 4. accrual trigger --------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_fee_accrue_on_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claim_test    boolean;
  v_ref_id        uuid;
  v_ref_created   timestamptz;
  v_ref_test      boolean;
  v_agent_id      uuid;
  v_agent_test    boolean;
  v_agent_type    text;
  v_setting       text;
  v_cents         integer;
  v_ref           text;
BEGIN
  -- homeowner-paid order: requested by the homeowner, a Stripe payment id on it, and a positive charge
  v_ref := COALESCE(NULLIF(btrim(NEW.homeowner_stripe_payment_intent_id), ''), NULLIF(btrim(NEW.stripe_payment_id), ''));
  IF NEW.requested_by_role IS DISTINCT FROM 'homeowner'
     OR v_ref IS NULL
     OR COALESCE(NEW.homeowner_charge_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT c.is_test, r.id, r.created_at, r.is_test, a.id, a.is_test, a.agent_type
    INTO v_claim_test, v_ref_id, v_ref_created, v_ref_test, v_agent_id, v_agent_test, v_agent_type
    FROM public.claims c
    JOIN public.referrals r        ON r.id = c.referral_id
    JOIN public.referral_agents a  ON a.id = r.referral_agent_id
   WHERE c.id = NEW.claim_id;

  IF NOT FOUND THEN
    RETURN NEW;                                   -- no credited referral on this claim
  END IF;

  -- D-402: "Credit lasts 90 days from the partner click. A measurement or project started within that time is credited."
  -- So the window runs from the partner click to THIS measurement order (not to the claim); referral_attribution_window() is the single source of its length.
  IF v_ref_created IS NULL
     OR COALESCE(NEW.created_at, now()) > v_ref_created + public.referral_attribution_window() THEN
    RETURN NEW;
  END IF;

  -- is_test must agree on claim, referral and agent (hover_orders carries no is_test of its own)
  IF COALESCE(v_claim_test, false) IS DISTINCT FROM COALESCE(v_ref_test, false)
     OR COALESCE(v_claim_test, false) IS DISTINCT FROM COALESCE(v_agent_test, false) THEN
    RETURN NEW;
  END IF;

  -- D-333: no fee to a home inspector
  IF v_agent_type IS NOT DISTINCT FROM 'home_inspector' THEN
    RETURN NEW;
  END IF;

  -- amount: read at insert time; a missing or malformed setting accrues nothing (no invented amount) and says so in the log
  SELECT s.value #>> '{}' INTO v_setting FROM public.platform_settings s WHERE s.key = 'partner_measurement_fee_cents';
  IF v_setting IS NULL OR v_setting !~ '^[0-9]{1,6}$' OR v_setting::integer <= 0 THEN
    RAISE WARNING 'partner_fee_accrue_on_order: partner_measurement_fee_cents missing or invalid (%), no fee accrued for hover_order_id=%', v_setting, NEW.id;
    RETURN NEW;
  END IF;
  v_cents := v_setting::integer;

  INSERT INTO public.partner_fee_events
    (referral_agent_id, referral_id, claim_id, hover_order_id, payment_ref, event_type, amount_cents, status, is_test)
  VALUES
    (v_agent_id, v_ref_id, NEW.claim_id, NEW.id, v_ref, 'measurement_purchase', v_cents, 'accrued', COALESCE(v_claim_test, false))
  ON CONFLICT DO NOTHING;       -- either unique key (order row or payment) stops a second fee

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'partner_fee_accrue_on_order failed for hover_order_id=% sqlstate=% sqlerrm=%', NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_fee_accrue_on_order() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS partner_fee_accrue_on_order ON public.hover_orders;
CREATE TRIGGER partner_fee_accrue_on_order
  AFTER INSERT
  ON public.hover_orders
  FOR EACH ROW
  WHEN (NEW.requested_by_role = 'homeowner')
  EXECUTE FUNCTION public.partner_fee_accrue_on_order();

-- 6. dashboard stats (is_test-matching) ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_partner_dashboard_stats()
 RETURNS TABLE(
   clicks                        bigint,
   homeowners_signed_up          bigint,
   measurements_purchased        bigint,
   jobs_completed                bigint,
   referral_fees_accrued_cents   bigint,   -- $200 fees not yet paid (pending, approved)
   referral_fees_paid_cents      bigint,
   measurement_fees_accrued_cents bigint,  -- $5 fees accrued or batched, not yet paid
   measurement_fees_paid_cents   bigint,
   earnings_accrued_cents        bigint,   -- both fees
   earnings_paid_cents           bigint,
   recruit_earnings_cents        bigint,   -- recruit bonuses on the caller's recruits (paid or accrued)
   recruits                      jsonb,    -- [{recruit_id, earnings_cents}] bonuses only; never the recruit's own fees
   accrued_toward_minimum_cents  bigint,   -- $5 fees still 'accrued' (what the next batch would count)
   payments_blocked              boolean,  -- true: payouts are held (all of the caller's partner rows are payments_blocked)
   payout_minimum_cents          bigint,
   next_payout_cents             bigint,   -- estimate: accrued if at or above the minimum and not payments-blocked, else 0
   next_payout_month             date
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids      uuid[];
  v_blocked  boolean;
  v_test     boolean;
  v_min      bigint;
  v_setting  text;
  v_accrued  bigint;
BEGIN
  -- the caller is resolved from the session only; there is no partner argument
  SELECT array_agg(ra.id), COALESCE(bool_and(ra.payments_blocked), true), COALESCE(bool_or(ra.is_test), false)
    INTO v_ids, v_blocked, v_test
    FROM public.referral_agents ra
   WHERE ra.user_id = auth.uid();

  IF v_ids IS NULL THEN
    RETURN;                                       -- not a partner (or signed out): no row
  END IF;

  SELECT s.value #>> '{}' INTO v_setting FROM public.platform_settings s WHERE s.key = 'partner_payout_minimum_cents';
  v_min := CASE WHEN v_setting ~ '^[0-9]{1,7}$' THEN v_setting::bigint ELSE 2500 END;

  SELECT COALESCE(sum(e.amount_cents), 0) INTO v_accrued
    FROM public.partner_fee_events e
   WHERE e.referral_agent_id = ANY (v_ids) AND e.status = 'accrued' AND e.is_test = v_test;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.referrals r WHERE r.referral_agent_id = ANY (v_ids) AND r.is_test = v_test),
    (SELECT count(*) FROM public.referrals r WHERE r.referral_agent_id = ANY (v_ids) AND r.is_test = v_test AND r.status <> 'clicked'),
    (SELECT count(*) FROM public.partner_fee_events e WHERE e.referral_agent_id = ANY (v_ids) AND e.is_test = v_test AND e.status <> 'void'),
    (SELECT count(*) FROM public.referrals r WHERE r.referral_agent_id = ANY (v_ids) AND r.is_test = v_test AND r.status IN ('job_completed', 'commission_paid')),
    (SELECT COALESCE(round(sum(p.amount) * 100), 0)::bigint FROM public.payout_approvals p
      WHERE p.partner_id = ANY (v_ids) AND p.is_test = v_test AND p.payout_type = 'commission_referral'
        AND p.status IN ('pending_approval', 'approved', 'auto_approved', 'pre_approved')),
    (SELECT COALESCE(round(sum(p.amount) * 100), 0)::bigint FROM public.payout_approvals p
      WHERE p.partner_id = ANY (v_ids) AND p.is_test = v_test AND p.payout_type = 'commission_referral' AND p.status = 'paid'),
    (SELECT COALESCE(sum(e.amount_cents), 0)::bigint FROM public.partner_fee_events e
      WHERE e.referral_agent_id = ANY (v_ids) AND e.is_test = v_test AND e.status IN ('accrued', 'batched')),
    (SELECT COALESCE(sum(e.amount_cents), 0)::bigint FROM public.partner_fee_events e
      WHERE e.referral_agent_id = ANY (v_ids) AND e.is_test = v_test AND e.status = 'paid'),
    (
      (SELECT COALESCE(round(sum(p.amount) * 100), 0)::bigint FROM public.payout_approvals p
        WHERE p.partner_id = ANY (v_ids) AND p.is_test = v_test AND p.payout_type = 'commission_referral'
          AND p.status IN ('pending_approval', 'approved', 'auto_approved', 'pre_approved'))
      + (SELECT COALESCE(sum(e.amount_cents), 0)::bigint FROM public.partner_fee_events e
          WHERE e.referral_agent_id = ANY (v_ids) AND e.is_test = v_test AND e.status IN ('accrued', 'batched'))
    ),
    (
      (SELECT COALESCE(round(sum(p.amount) * 100), 0)::bigint FROM public.payout_approvals p
        WHERE p.partner_id = ANY (v_ids) AND p.is_test = v_test AND p.payout_type = 'commission_referral' AND p.status = 'paid')
      + (SELECT COALESCE(sum(e.amount_cents), 0)::bigint FROM public.partner_fee_events e
          WHERE e.referral_agent_id = ANY (v_ids) AND e.is_test = v_test AND e.status = 'paid')
    ),
    (SELECT COALESCE(round(sum(r.recruit_commission_amount) * 100), 0)::bigint
       FROM public.referrals r JOIN public.referral_agents rec ON rec.id = r.referral_agent_id
      WHERE rec.recruited_by_id = ANY (v_ids) AND r.is_test = v_test AND COALESCE(r.recruit_commission_amount, 0) > 0),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('recruit_id', t.recruit_id, 'earnings_cents', t.cents) ORDER BY t.recruit_id)
                FROM (SELECT rec.id AS recruit_id, round(sum(r.recruit_commission_amount) * 100)::bigint AS cents
                        FROM public.referrals r JOIN public.referral_agents rec ON rec.id = r.referral_agent_id
                       WHERE rec.recruited_by_id = ANY (v_ids) AND r.is_test = v_test AND COALESCE(r.recruit_commission_amount, 0) > 0
                       GROUP BY rec.id) t), '[]'::jsonb),
    v_accrued,
    v_blocked,
    v_min,
    CASE WHEN v_accrued >= v_min AND NOT v_blocked THEN v_accrued ELSE 0 END::bigint,
    (date_trunc('month', now() AT TIME ZONE 'America/New_York') + interval '1 month')::date;   -- the Eastern month, same as the batch
END;
$function$;

COMMENT ON FUNCTION public.get_partner_dashboard_stats() IS
  'gh-3229 (P18): the signed-in partner''s dashboard numbers. Caller from auth.uid() only (no partner argument); only rows whose is_test matches the caller''s (test partner sees test rows, real partner real rows); recruits[] carries the recruit bonus earned per recruit and nothing of the recruit''s own fees.';

REVOKE ALL ON FUNCTION public.get_partner_dashboard_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_partner_dashboard_stats() TO authenticated, service_role;

-- 7. monthly batch -------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_monthly_fee_batch(p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_month    date;
  v_end      timestamptz;
  v_setting  text;
  v_min      bigint;
  r          record;
  v_payout   uuid;
  v_updated  integer;
  v_created  integer := 0;
  v_batched  integer := 0;
  v_under    integer := 0;
  v_blocked  integer := 0;
  v_total    bigint  := 0;
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.is_admin_email()) THEN
    RAISE EXCEPTION 'create_monthly_fee_batch: admin or service role only' USING ERRCODE = '42501';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'create_monthly_fee_batch: p_month is required' USING ERRCODE = '22023';
  END IF;

  v_month := date_trunc('month', p_month)::date;
  -- only a month that has ended can be batched: an accrual landing during the run could not otherwise be told from the batch's own rows
  IF v_month >= date_trunc('month', now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'create_monthly_fee_batch: % is the current or a future month (Eastern time)', v_month USING ERRCODE = '22023';
  END IF;
  -- month boundary = midnight America/New_York (the business day), not UTC; everything accrued before it, rollover included
  v_end := ((v_month + interval '1 month')::timestamp AT TIME ZONE 'America/New_York');

  -- two clicks at once serialize here; the second finds nothing left to batch
  PERFORM pg_advisory_xact_lock(hashtext('create_monthly_fee_batch'));

  SELECT s.value #>> '{}' INTO v_setting FROM public.platform_settings s WHERE s.key = 'partner_payout_minimum_cents';
  v_min := CASE WHEN v_setting ~ '^[0-9]{1,7}$' THEN v_setting::bigint ELSE 2500 END;

  FOR r IN
    SELECT e.referral_agent_id AS agent_id, e.is_test, sum(e.amount_cents)::bigint AS total, count(*)::integer AS n,
           a.first_name, a.last_name, a.payments_blocked
      FROM public.partner_fee_events e
      JOIN public.referral_agents a ON a.id = e.referral_agent_id
     WHERE e.status = 'accrued' AND e.created_at < v_end
     GROUP BY e.referral_agent_id, e.is_test, a.first_name, a.last_name, a.payments_blocked
     ORDER BY e.referral_agent_id, e.is_test
  LOOP
    IF r.payments_blocked THEN
      v_blocked := v_blocked + 1;
      CONTINUE;                                    -- stays accrued
    END IF;
    IF r.total < v_min THEN
      v_under := v_under + 1;
      CONTINUE;                                    -- rolls over
    END IF;

    INSERT INTO public.payout_approvals
      (referral_id, payout_type, partner_id, partner_name, amount, trigger_event, status, auto_approve_at, is_test)
    VALUES
      (NULL, 'measurement_fees_monthly', r.agent_id,
       btrim(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')),
       round(r.total / 100.0, 2),
       'Measurement referral fees through ' || to_char(v_month, 'Mon YYYY') || ' (' || r.n || ' measurements)',
       'pending_approval', NULL, r.is_test)
    RETURNING id INTO v_payout;

    UPDATE public.partner_fee_events
       SET status = 'batched', payout_approval_id = v_payout
     WHERE referral_agent_id = r.agent_id AND is_test = r.is_test AND status = 'accrued' AND created_at < v_end;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> r.n THEN
      RAISE EXCEPTION 'create_monthly_fee_batch: batched % events for partner %, expected %', v_updated, r.agent_id, r.n;
    END IF;

    v_created := v_created + 1;
    v_batched := v_batched + v_updated;
    v_total   := v_total + r.total;
  END LOOP;

  RETURN jsonb_build_object(
    'month', v_month, 'payouts_created', v_created, 'events_batched', v_batched, 'total_cents', v_total,
    'under_minimum_partners', v_under, 'payments_blocked_partners', v_blocked, 'minimum_cents', v_min);
END;
$function$;

COMMENT ON FUNCTION public.create_monthly_fee_batch(date) IS
  'gh-3229 (P18): admin/service-role only. For every partner whose accrued measurement fees (through the end of p_month) reach partner_payout_minimum_cents and who is not payments_blocked, creates one payout_approvals row (measurement_fees_monthly, pending_approval, referral_id NULL) and marks those events batched. Idempotent. Month boundaries are midnight America/New_York; the current and future months are refused.';

REVOKE ALL ON FUNCTION public.create_monthly_fee_batch(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_monthly_fee_batch(date) TO authenticated, service_role;

-- 8. paid flip: repair tool and belt-and-braces call from mark-payout-paid (the payout_approvals trigger below is the primary path) ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_fee_events_mark_paid(p_payout_approval_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'partner_fee_events_mark_paid: service role only' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.payout_approvals p
                  WHERE p.id = p_payout_approval_id AND p.payout_type = 'measurement_fees_monthly' AND p.status = 'paid') THEN
    RETURN 0;                                      -- only a measurement-fee payout that is already paid flips its events
  END IF;

  UPDATE public.partner_fee_events
     SET status = 'paid', paid_at = now()
   WHERE payout_approval_id = p_payout_approval_id AND status = 'batched';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_fee_events_mark_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_fee_events_mark_paid(uuid) TO service_role;

-- 9. paid, rejected or deleted batch payout moves its events with it ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_fee_events_follow_payout()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.status = 'rejected' THEN
    UPDATE public.partner_fee_events                       -- released: batched again by the next run
       SET status = 'accrued', payout_approval_id = NULL
     WHERE payout_approval_id = OLD.id AND status = 'batched';
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- status became 'paid'
  UPDATE public.partner_fee_events
     SET status = 'paid', paid_at = COALESCE(NEW.paid_at, now())
   WHERE payout_approval_id = NEW.id AND status = 'batched';
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.partner_fee_events_follow_payout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS partner_fee_release_on_reject ON public.payout_approvals;
DROP TRIGGER IF EXISTS partner_fee_follow_payout_status ON public.payout_approvals;
CREATE TRIGGER partner_fee_follow_payout_status
  AFTER UPDATE OF status ON public.payout_approvals
  FOR EACH ROW
  WHEN (NEW.payout_type = 'measurement_fees_monthly'
        AND ((NEW.status = 'rejected' AND OLD.status IS DISTINCT FROM 'rejected')
             OR (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')))
  EXECUTE FUNCTION public.partner_fee_events_follow_payout();

DROP TRIGGER IF EXISTS partner_fee_follow_payout_delete ON public.payout_approvals;
CREATE TRIGGER partner_fee_follow_payout_delete
  BEFORE DELETE ON public.payout_approvals
  FOR EACH ROW
  WHEN (OLD.payout_type = 'measurement_fees_monthly')
  EXECUTE FUNCTION public.partner_fee_events_follow_payout();

COMMIT;
