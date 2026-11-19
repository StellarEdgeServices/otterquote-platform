-- gh-3428: owner alert sweep. Schema half: table public.owner_alerts + two service-role-only functions + a no-ring baseline.
-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (ledger version 20261105212726, name gh3428_owner_alert_sweep; read-only ledger query, CTO RUN 104, #3324; the lines below are the pre-apply drafting record)
-- EVIDENCE: drafted on main 32193ce7 by reading the repo (supabase/migrations/20260101000000_v000_baseline_schema.sql, create-measurement-order/index.ts, dashboard.html submitForBids,
-- the gh3197 draft). No production read was made by the author (no database connection, by instruction): column names below are the repo's; the applier re-reads them (pre-flight, checks 1-4).
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, review, R-097 notice, a recorded apply). Dustin's early GO is on #3428 (comment 6667032327).
-- Rollback: supabase/migrations_rollbacks/gh3428_owner_alert_sweep_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3428_owner_alert_sweep_pre-flight.md  Proof (throwaway Postgres): supabase/tests/gh3428_owner_alert_sweep_proof.sql (runner ..._proof_run.sh)
-- ORDER: apply THIS file, deploy the Edge Function owner-alert-sweep, set the secrets, THEN apply gh3428_owner_alert_sweep_cron.sql (the schedule). This file schedules nothing and rings nothing.
-- TRANSACTION: carries its own BEGIN ... COMMIT; run it ALONE (psql -v ON_ERROR_STOP=1 -f). Never wrap it.
--
-- Design: Marty's answer on #3428 (comment 6666968789): a short-interval SWEEP, not a trigger on a money table and not the stripe-webhook. Nothing here touches hover_orders, claims,
-- quotes, profiles or any payment table: the new functions only SELECT from them and only WRITE public.owner_alerts. A fault in the sweep cannot reach the payment path.
--
-- What counts as an event (names are exact):
--   measurement_paid  one row of public.hover_orders per paid homeowner measurement report. There is no payments table for hover_measurement: the PaymentIntent (metadata.type =
--                     'hover_measurement') is verified as succeeded by create-measurement-order (verifyPayment) BEFORE it inserts the hover_orders row, so the row's existence is the
--                     durable "payment reached succeeded" fact. Qualifies when: homeowner_stripe_payment_intent_id IS NOT NULL, requested_by_contractor_id IS NULL,
--                     COALESCE(requested_by_role,'homeowner') = 'homeowner', product_code <> 'roof_upgrade_detailed' (the contractor-bought upgrade), created_at within the lookback.
--   claim_bidding     one row of public.claims per claim that entered the bid process. dashboard.html submitForBids() writes claims.status = 'active' and claims.ready_for_bids = true
--                     (plus <trade>_bid_released_at). switch-contractor / process-dunning later write status = 'bidding'. Qualifies when ready_for_bids IS TRUE AND status IN ('active','bidding')
--                     and updated_at is within the lookback. First sight only: the unique key means a later 'active' -> 'bidding' change on the same claim never rings again.
-- Every is_test flag on the path is checked, for BOTH events: claims.is_test (the claim), profiles.is_test of the claim owner (claims.user_id) and of the buyer (hover_orders.user_id),
-- and the staff e-mail rule (public.is_internal_test_email(profiles.email) plus the five internal domains spelled out here). hover_orders has no is_test column. contractors.is_test is NOT
-- consulted: contractor-bought rows are excluded by requested_by_contractor_id IS NULL, and that column carries two meanings (test account / synthetic lead marker, gh-2055), so using it as a
-- gate would be wrong in either direction. Residual false-alarm risk (a ring for a non-customer): a staff test whose e-mail is outside the domains above and whose rows are unflagged
-- (gh-3197 says 40 profiles / 3 claims were like that on 2026-11-01); a real homeowner is never suppressed by these rules. Residual miss risk: a homeowner whose browser never calls
-- create-measurement-order after paying has no hover_orders row until support records it, so no measurement ring (the webhook is deliberately untouched).
--
-- Spoken content is built in the Edge Function from event_kind, state and claim_id only; this table stores no name, address, phone or e-mail.

BEGIN;

CREATE TABLE IF NOT EXISTS public.owner_alerts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_kind      text        NOT NULL CHECK (event_kind IN ('measurement_paid', 'claim_bidding')),
  source_id       uuid        NOT NULL,                 -- hover_orders.id (measurement_paid) or claims.id (claim_bidding)
  claim_id        uuid        NOT NULL,
  state           text,                                 -- claims.property_state, spoken as two letters; NULL is spoken as "state unknown"
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'calling', 'called', 'failed_final', 'baseline')),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),   -- retry time while pending; lease expiry while calling
  twilio_call_sid text,
  last_error      text,                                 -- fixed code only, e.g. twilio_http_400_code_21211; never a phone number or a response body
  created_at      timestamptz NOT NULL DEFAULT now(),
  called_at       timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_alerts_event_source_uniq UNIQUE (event_kind, source_id)   -- the dedupe
);

COMMENT ON TABLE public.owner_alerts IS
  'gh-3428: one row per owner phone alert (event_kind, source_id unique = the dedupe). Written only by service_role via owner_alert_claim_batch / owner_alert_mark. status baseline = qualifying event that existed when the sweep was installed (never rings).';

ALTER TABLE public.owner_alerts ENABLE ROW LEVEL SECURITY;   -- no policies: anon and authenticated see nothing
REVOKE ALL ON TABLE public.owner_alerts FROM PUBLIC, anon, authenticated;
-- RW-CTO41-GRANT-BLOCK: Supabase stops auto-granting new public tables on 2026-10-30 (#2145); CI gate from PR #2201 enforces the service_role grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owner_alerts TO service_role;

-- Shared "is this a real customer" predicate, as SQL so the claim and the measurement paths cannot drift apart.
CREATE OR REPLACE FUNCTION public.owner_alert_is_internal(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE((
    SELECT p.is_test IS TRUE
        OR (p.email IS NOT NULL AND (
              public.is_internal_test_email(p.email)
              OR split_part(lower(btrim(p.email)), '@', 2) IN
                 ('otterquote.com', 'stellaredgeservices.com', 'tryotterquote.com', 'stohlerroof.com', 'otterquote-internal.test')))
      FROM public.profiles p
     WHERE p.id = p_profile_id
  ), false);
$fn$;

-- Enqueue qualifying events, then lease a batch for calling. One call per sweep tick from the Edge Function.
CREATE OR REPLACE FUNCTION public.owner_alert_claim_batch(
  p_max_attempts integer  DEFAULT 3,
  p_lookback     interval DEFAULT interval '24 hours',
  p_lease        interval DEFAULT interval '2 minutes',
  p_limit        integer  DEFAULT 5)
RETURNS TABLE (id uuid, event_kind text, claim_id uuid, state text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
SET statement_timeout = '8s'
AS $fn$
#variable_conflict use_column
BEGIN
  -- (a) measurement_paid: a paid homeowner measurement report on a real claim.
  INSERT INTO public.owner_alerts (event_kind, source_id, claim_id, state)
  SELECT 'measurement_paid', h.id, h.claim_id, c.property_state
    FROM public.hover_orders h
    JOIN public.claims c ON c.id = h.claim_id
   WHERE h.homeowner_stripe_payment_intent_id IS NOT NULL
     AND h.requested_by_contractor_id IS NULL
     AND COALESCE(h.requested_by_role, 'homeowner') = 'homeowner'
     AND h.product_code IS DISTINCT FROM 'roof_upgrade_detailed'
     AND h.created_at >= now() - p_lookback
     AND c.is_test IS NOT TRUE
     AND NOT public.owner_alert_is_internal(c.user_id)
     AND NOT public.owner_alert_is_internal(h.user_id)
  ON CONFLICT (event_kind, source_id) DO NOTHING;

  -- (b) claim_bidding: a real claim that has entered the bid process.
  INSERT INTO public.owner_alerts (event_kind, source_id, claim_id, state)
  SELECT 'claim_bidding', c.id, c.id, c.property_state
    FROM public.claims c
   WHERE c.ready_for_bids IS TRUE
     AND c.status IN ('active', 'bidding')
     AND c.updated_at >= now() - p_lookback
     AND c.is_test IS NOT TRUE
     AND NOT public.owner_alert_is_internal(c.user_id)
  ON CONFLICT (event_kind, source_id) DO NOTHING;

  -- Attempt cap: a row whose lease or retry time has passed with the cap already used goes final (never rings again).
  UPDATE public.owner_alerts a
     SET status = 'failed_final', updated_at = now(),
         last_error = COALESCE(a.last_error, 'attempt_cap_reached')
   WHERE a.status IN ('pending', 'calling') AND a.next_attempt_at <= now() AND a.attempts >= p_max_attempts;

  -- Lease: pending rows that are due, or calling rows whose lease expired (the previous worker died). SKIP LOCKED: two overlapping ticks never lease the same row.
  RETURN QUERY
  WITH due AS (
    SELECT a.id FROM public.owner_alerts a
     WHERE a.status IN ('pending', 'calling') AND a.next_attempt_at <= now() AND a.attempts < p_max_attempts
     ORDER BY a.created_at
     LIMIT GREATEST(p_limit, 1)
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.owner_alerts a
     SET status = 'calling', attempts = a.attempts + 1, next_attempt_at = now() + p_lease, updated_at = now()
    FROM due
   WHERE a.id = due.id
  RETURNING a.id, a.event_kind, a.claim_id, a.state, a.attempts;
END
$fn$;

-- Record the outcome of one call attempt. Returns the new status (the Edge Function reports failed_final to Sentry).
CREATE OR REPLACE FUNCTION public.owner_alert_mark(
  p_id           uuid,
  p_ok           boolean,
  p_sid          text,
  p_error        text,
  p_max_attempts integer DEFAULT 3)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_status text;
BEGIN
  UPDATE public.owner_alerts a
     SET status          = CASE WHEN p_ok THEN 'called'
                                WHEN a.attempts >= p_max_attempts THEN 'failed_final'
                                ELSE 'pending' END,
         twilio_call_sid = CASE WHEN p_ok THEN left(p_sid, 64) ELSE a.twilio_call_sid END,
         last_error      = CASE WHEN p_ok THEN NULL ELSE left(p_error, 120) END,
         called_at       = CASE WHEN p_ok THEN now() ELSE a.called_at END,
         next_attempt_at = CASE WHEN p_ok THEN a.next_attempt_at ELSE now() + interval '30 seconds' * a.attempts END,
         updated_at      = now()
   WHERE a.id = p_id AND a.status = 'calling'
  RETURNING a.status INTO v_status;
  RETURN v_status;   -- NULL when the row was not in 'calling' (already marked, or lease taken over)
END
$fn$;

-- Function privilege hazard (migration-author danger pattern 9): Supabase default privileges grant EXECUTE to anon AND authenticated on every new public function.
REVOKE ALL ON FUNCTION public.owner_alert_is_internal(uuid)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.owner_alert_claim_batch(integer, interval, interval, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.owner_alert_mark(uuid, boolean, text, text, integer)       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.owner_alert_is_internal(uuid)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.owner_alert_claim_batch(integer, interval, interval, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.owner_alert_mark(uuid, boolean, text, text, integer)       TO service_role;

-- Baseline: every event that qualifies RIGHT NOW (no lookback) is recorded as baseline so installing the sweep rings for nothing that already happened.
INSERT INTO public.owner_alerts (event_kind, source_id, claim_id, state, status)
SELECT 'measurement_paid', h.id, h.claim_id, c.property_state, 'baseline'
  FROM public.hover_orders h
  JOIN public.claims c ON c.id = h.claim_id
 WHERE h.homeowner_stripe_payment_intent_id IS NOT NULL
   AND h.requested_by_contractor_id IS NULL
   AND COALESCE(h.requested_by_role, 'homeowner') = 'homeowner'
   AND h.product_code IS DISTINCT FROM 'roof_upgrade_detailed'
ON CONFLICT (event_kind, source_id) DO NOTHING;

INSERT INTO public.owner_alerts (event_kind, source_id, claim_id, state, status)
SELECT 'claim_bidding', c.id, c.id, c.property_state, 'baseline'
  FROM public.claims c
 WHERE c.ready_for_bids IS TRUE AND c.status IN ('active', 'bidding')
ON CONFLICT (event_kind, source_id) DO NOTHING;

COMMIT;
