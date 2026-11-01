-- gh-3229 PRODUCTION-SAFE proof (P18): $5 measurement referral fee, monthly batch ($25 minimum), partner dashboard stats.
-- Tests only. NOT RUN IN PRODUCTION by its author; Marty runs it. Refs #3229, #3236 (the draft migration under test lives on PR #3236, head 11943b7a68f9).
--
-- WHAT IT IS
--   supabase/tests/gh3229_partner_measurement_fee_proof.sql (PR #3236) was written against a throwaway LOCAL database (gh3229_local_stub_extras.sql) that lacks several
--   production constraints, triggers and column semantics. This file applies the SAME forward migration inline and runs the SAME cases, with fixtures rebuilt to satisfy
--   PRODUCTION's real catalog (read 2026-11-01, project yeszghaspzwwstvsrioa). The list of differences is in the PR body that adds this file.
--
-- HOW TO RUN  (one request = one session = one transaction; run as the postgres role)
--   Management API : POST https://api.supabase.com/v1/projects/yeszghaspzwwstvsrioa/database/query   body {"query": "<this whole file>"}
--   or psql        : psql -X -v ON_ERROR_STOP=1 -f supabase/tests/gh3229_partner_measurement_fee_prod_proof.sql
--   or SQL editor  : paste the whole file, run once.
--   RUN THE WHOLE FILE AS ONE SCRIPT IN A SINGLE SESSION (SQL editor "Run" on the full text, or the Mgmt API /database/query with the full file).
--   NEVER "run selected" and NEVER statement-by-statement (a runner that sends each statement on its own autocommit connection): the migration DDL would then commit piecemeal.
--   BEFORE-APPLY PROOF ONLY: once #3236's migration is applied, the pre-flight guards below raise P0U04 and nothing runs. The post-apply paid-measurement artifact that #3229 requires is separate.
--   Run it in a quiet window. Locks held until the abort (SET LOCAL lock_timeout = '5s' makes it give up instead of queueing behind a long transaction):
--     payout_approvals  ACCESS EXCLUSIVE  (DROP/ADD CHECK; includes a CHECK re-validation scan)
--     hover_orders      ACCESS EXCLUSIVE  (DROP TRIGGER IF EXISTS takes it even when the trigger is absent, so reads block too)
--     claims, referrals, referral_agents  SHARE ROW EXCLUSIVE  (from the new table's foreign keys, so writes block)
--     partner_fee_events (new, uncommitted) and platform_settings (row inserts) are not visible to other sessions.
--
-- EXPECTED RESULT  (the run ALWAYS ends in an error; that is the design, it is what keeps the file from committing)
--   PASS : ERROR P0U01  'GH3229 PROD PROOF PASSED (forced rollback, nothing was committed)' + one line per assertion ending OK, last line 'TALLY: 75 OK, 0 DIFF'
--   FAIL : ERROR P0U03  'GH3229 PROD PROOF FAILED (forced rollback): n DIFF' + the failing rows first, then all rows.
--   A fixture or migration statement that production refuses aborts earlier with that statement's own error (constraint / trigger name in the message). Paste it into #3229.
--   Anything other than P0U01 / P0U03 is NOT a pass. Verify afterwards that nothing persisted (all three must be 0):
--     SELECT to_regclass('public.partner_fee_events') IS NOT NULL;   SELECT count(*) FROM public.referral_agents WHERE unique_code LIKE 'GH3229%';   SELECT count(*) FROM auth.users WHERE email LIKE 'gh3229-%';
--
-- WHY IT CANNOT COMMIT
--   1. There is no COMMIT statement in this file (grep -n -i '^[[:space:]]*commit' on it returns nothing; the draft's own BEGIN;/COMMIT; lines were removed from the inlined block).
--   2. The last executable statement before the trailing ROLLBACK is a DO block that ALWAYS raises (P0U01 / P0U03), which aborts the transaction.
--   3. Every temp object is ON COMMIT DROP / pg_temp. Even a hypothetical COMMIT would leave only test-flagged rows (below), but it is not possible by construction.
--
-- SIDE EFFECTS CONSIDERED (production triggers that call net.http_post / email), and how this file avoids or contains each
--   * claims AFTER INSERT notify_admin_new_claim / ga4 trigger : skip claims with is_test = true. Claims are INSERTED is_test = true; the single real-flagged claim (F7a) is flipped to false
--       by an UPDATE afterwards (no AFTER UPDATE net trigger fires: only after_claim_completed*, which need completion_date, and notify_admin_out_of_state_claim, which needs property_state).
--   * claims_advance_referral (net.http_post send-partner-status-email) : only after it advances a 'clicked'/'registered' referral. Every fixture referral is 'claim_submitted' or untouched,
--       and referrals are attached to claims by UPDATE after insert, so it advances nothing (v_rows_updated = 0, no request).
--   * referral_agents AFTER INSERT notify_admin_new_partner : calls net.http_post UNCONDITIONALLY (no is_test skip, an email to the admin inbox). It cannot be avoided without disabling a trigger
--       (DDL on a live table) or session_replication_role (not used). It is contained: pg_net 0.20.0 net.http_post() does an INSERT into net.http_request_queue inside the caller's
--       transaction (read from pg_get_functiondef), so the queued rows are discarded by the forced rollback and the pg_net worker never sees them. If this file were ever committed, 20 admin
--       notification requests would go out; see 'WHY IT CANNOT COMMIT'.
--   * no email is addressed to a real mailbox: every address is @otterquote-internal.test (an internal test domain in public.is_internal_test_email()).
--   * apply_referral_commission / notify_hover_rebate fire on claims.completion_date, which no fixture sets.
--
-- FIXTURES: fixed UUIDs '3229a000-...' (users 2xx/3xx, agents 1xx), '3229c000-...' (claims), '3229e000-...' (referrals), '3229f000-...' (orders); agent emails gh3229-agent-N@otterquote-internal.test,
--   claimants gh3229-claimant-N@otterquote-internal.test. Everything is is_test = true EXCEPT the minimum needed to test the is_test comparisons: agent 19 (real-flagged), claim 'm' (F7a, flipped
--   to test again by NC1), referral 'm3' (F7b), and the D10/D11 cross-flag rows (referrals 3229e000-...001/002/003 and 3 fee events).
--   The admin used for the admin-gated cases is read from public.admin_emails at run time (is_admin_email() reads that table in production); only a JWT claim is simulated, nothing is written for it.
--
-- THE INLINED MIGRATION  (verify it is unchanged)
--   Source : supabase/migrations_drafts/gh3229_partner_measurement_fee.sql at PR #3236 head 11943b7a68f9 (git blob f61394cb435d).
--   sha256 of that whole draft file                                   : b0363712f53670e0a96d8b4fa915d54ea7fec1bd782027d4d5f2988fb74f3355
--   sha256 of the inlined block (the draft minus its two lines 'BEGIN;' and 'COMMIT;') : eb46100c3b13921ee7a74a1b38ad58012af8a4facee1cc24b161b33c74134751
--   Check the block :  sed -n '/^-- >>> BEGIN INLINED MIGRATION/,/^-- <<< END INLINED MIGRATION/p' <this file> | sed '1d;$d' | sha256sum
--   Check the draft :  git show 11943b7a68f9:supabase/migrations_drafts/gh3229_partner_measurement_fee.sql | grep -v -E '^(BEGIN|COMMIT);$' | sha256sum   (same value)
--
-- CASES (key prefix = case id; same ids as the local proof, plus F0*, S9, S10, X0, D11b and the negative controls NC1-NC3)
--   F0 fixture integrity under production guards.  F1-F4 credited paid order -> one 500 row; setting 700 -> next row 700; no credited partner -> none; duplicate update -> no second row.
--   F4b/F4c one fee per PaymentIntent; UPDATE accrues nothing.  F5-F9 inspector, click outside window, is_test mismatch (a/b/c), contractor-role order / no Stripe id, all-test chain.
--   F10 customer agent.  F11-F12 (D-402) window runs click -> order.  F13-F15 (#3242) v4 gate.  S1-S10 isolation, no client writes, anon nothing, privileges, function ACLs, RLS.
--   D1-D11b dashboard stats.  B1-B9 monthly batch (Eastern month boundary).  P1-P4 paid flip.  R1 rejected batch releases events.  V1-V2 rebate does not void.  N8 deleting a batch payout releases events.
--   NEGATIVE CONTROLS (the case is shown to fail when its precondition is broken):  NC1 is_test mismatch removed -> fee accrues;  NC2 inspector removed -> fee accrues;  NC3 v4 acceptance moved
--   before the order -> fee accrues.  F11/F12 are a paired control for the window;  F13 vs F14/F15 for the v4 gate.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

-- pre-flight: refuse to run against a database where this proof would be meaningless or could collide with real rows
DO $pre$
BEGIN
  IF to_regclass('public.partner_fee_events') IS NOT NULL THEN
    RAISE EXCEPTION 'gh3229 prod proof: public.partner_fee_events already exists (migration already applied?); this proof is for the BEFORE-apply state' USING ERRCODE = 'P0U04';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_settings WHERE key IN ('partner_measurement_fee_cents', 'partner_payout_minimum_cents')) THEN
    RAISE EXCEPTION 'gh3229 prod proof: a fee/minimum platform_settings key already exists; the migration would keep it (ON CONFLICT DO NOTHING) and the 500/2500 expectations would not hold' USING ERRCODE = 'P0U04';
  END IF;
  IF to_regprocedure('public.partner_v4_accepted_at(uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh3229 prod proof: partner_v4_accepted_at(uuid) missing; apply #3242 first (the migration refuses to run without it)' USING ERRCODE = 'P0U04';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email LIKE 'gh3229-%' OR id::text LIKE '3229%')
     OR EXISTS (SELECT 1 FROM public.referral_agents WHERE email LIKE 'gh3229-%' OR unique_code LIKE 'GH3229%' OR id::text LIKE '3229%')
     OR EXISTS (SELECT 1 FROM public.claims WHERE id::text LIKE '3229%')
     OR EXISTS (SELECT 1 FROM public.referrals WHERE id::text LIKE '3229%')
     OR EXISTS (SELECT 1 FROM public.hover_orders WHERE id::text LIKE '3229%') THEN
    RAISE EXCEPTION 'gh3229 prod proof: fixture ids/emails already present (a previous run committed?)' USING ERRCODE = 'P0U04';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_emails) THEN
    RAISE EXCEPTION 'gh3229 prod proof: public.admin_emails is empty; the admin-gated cases need one address to simulate' USING ERRCODE = 'P0U04';
  END IF;
  IF NOT ('public' = ANY (current_schemas(false))) THEN
    RAISE EXCEPTION 'gh3229 prod proof: search_path does not contain public' USING ERRCODE = 'P0U04';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'gh3229 prod proof: run as postgres (current_user = %)', current_user USING ERRCODE = 'P0U04';
  END IF;
END
$pre$;

CREATE TEMP TABLE _r(k text, got text, want text) ON COMMIT DROP;
CREATE TEMP TABLE adm ON COMMIT DROP AS SELECT email FROM public.admin_emails ORDER BY email LIMIT 1;

-- >>> BEGIN INLINED MIGRATION (verbatim; its BEGIN; and COMMIT; lines removed)
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
--  10. Agreement gate (v4, #3242): the accrual trigger credits a partner only if partner_v4_accepted_at(agent) is set and not later than the order's created_at.
--      REFUSES to run unless public.partner_v4_accepted_at(uuid) exists (apply #3242's gh3239_partner_agreement_v4.sql first).


SET LOCAL lock_timeout = '5s';

-- 0. prerequisite: Partner Agreement v4 (#3242, gh3239_partner_agreement_v4.sql) must already be applied -------------------------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public.partner_v4_accepted_at(uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh3229: public.partner_v4_accepted_at(uuid) does not exist; apply #3242 (gh3239_partner_agreement_v4.sql) first' USING ERRCODE = '55000';
  END IF;
END
$guard$;

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
  v_v4_at         timestamptz;
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

  -- Partner Agreement v4 Section 1 (#3242): a partner who had not accepted v4 when the measurement order was created earns no Measurement Referral Fee, now or later
  v_v4_at := public.partner_v4_accepted_at(v_agent_id);
  IF v_v4_at IS NULL OR v_v4_at > COALESCE(NEW.created_at, now()) THEN
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

-- <<< END INLINED MIGRATION

-- run a scalar query; 'ERR <sqlstate>' if it fails
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, '<NULL>');
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE;
END $f$;

-- run a scalar query as a simulated session
CREATE FUNCTION pg_temp.as_sess(p_role text, p_uid uuid, p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL AND p_email IS NULL THEN json_build_object('role', p_role)::text
         ELSE json_build_object('sub', p_uid, 'role', p_role, 'email', p_email)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN coalesce(v, '<NULL>');
END $f$;

-- run a statement; 'ok' or 'ERR <sqlstate>' (so the BEFORE run, with no table, reports DIFF instead of aborting)
CREATE FUNCTION pg_temp.x(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERR ' || SQLSTATE;
END $f$;

-- as_sess, then undo whatever the statement did (a refusal check that must not change data if the refusal is missing)
CREATE FUNCTION pg_temp.as_sess_undo(p_role text, p_uid uuid, p_email text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  BEGIN
    v := pg_temp.as_sess(p_role, p_uid, p_email, p_sql);
    RAISE EXCEPTION 'UNDO:%', v USING ERRCODE = 'P0U02';
  EXCEPTION WHEN SQLSTATE 'P0U02' THEN
    RETURN substr(SQLERRM, 6);
  END;
END $f$;

-- record one assertion; PASS is a NOTICE, a mismatch is a WARNING now and the final gate below RAISEs EXCEPTION listing every DIFF
CREATE FUNCTION pg_temp.chk(p_k text, p_got text, p_want text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO _r VALUES (p_k, p_got, p_want);
  IF p_got = p_want THEN
    RAISE NOTICE 'PASS | % | %', p_k, p_got;
  ELSE
    RAISE WARNING 'FAIL | % | got % | want %', p_k, p_got, p_want;
  END IF;
END $f$;

-- run one statement with a service_role claim (the production guard triggers on referral_agents / claims test auth.role()); claim reset afterwards
CREATE FUNCTION pg_temp.svc(p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  EXECUTE p_sql;
  PERFORM set_config('request.jwt.claims', coalesce(v_prev, ''), true);
END $f$;

CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $f$ SELECT ('3229a000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;

-- partner n: agent id u(100+n), agent user u(200+n), claimant user u(300+n); every row is is_test = true on the internal test domain.
-- p_test = false flips the AGENT to is_test = false after the insert (only agent 19 does; a mismatch case and the real-partner stats case need one real-flagged row).
-- p_v4: Partner Agreement v4 acceptance relative to now() (default 300 days ago); NULL = never accepted. Written to the REAL columns partner_agreement_version /
-- partner_agreement_accepted_at, which the production partner_v4_accepted_at(uuid) reads (the local proof used a stub table).
-- Production guards this respects: referral_agents_guard_payout_columns forces payments_blocked = true on INSERT unless auth.role() = 'service_role', so the insert runs
-- with a transaction-local service_role claim; the AFTER INSERT trigger notify_admin_new_partner queues a pg_net request (see the header: the queue insert is transactional).
CREATE FUNCTION pg_temp.mk_agent(n int, p_type text, p_test boolean DEFAULT true, p_blocked boolean DEFAULT false, p_recruiter int DEFAULT NULL, p_v4 interval DEFAULT interval '-300 days') RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_prev text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  INSERT INTO auth.users(id, email) VALUES
    (pg_temp.u(200 + n), 'gh3229-agent-' || n || '@otterquote-internal.test'),
    (pg_temp.u(300 + n), 'gh3229-claimant-' || n || '@otterquote-internal.test');
  INSERT INTO public.referral_agents(id, agent_type, first_name, last_name, email, unique_code, user_id, is_test, payments_blocked, recruited_by_id, recruited_at,
                                     partner_agreement_version, partner_agreement_accepted_at)
  VALUES (pg_temp.u(100 + n), p_type, 'Proof', 'P' || n, 'gh3229-agent-' || n || '@otterquote-internal.test', 'GH3229' || n, pg_temp.u(200 + n), true, p_blocked,
          CASE WHEN p_recruiter IS NULL THEN NULL ELSE pg_temp.u(100 + p_recruiter) END,
          CASE WHEN p_recruiter IS NULL THEN NULL ELSE now() - interval '400 days' END,
          CASE WHEN p_v4 IS NULL THEN NULL ELSE 'v4-2026-10' END,
          CASE WHEN p_v4 IS NULL THEN NULL ELSE now() + p_v4 END);
  IF NOT p_test THEN
    UPDATE public.referral_agents SET is_test = false WHERE id = pg_temp.u(100 + n);
  END IF;
  PERFORM set_config('request.jwt.claims', coalesce(v_prev, ''), true);
END $f$;

-- a claim credited to partner n through a referral clicked p_age before now; returns the claim id. Defaults: claim and referral both is_test = true.
-- Production order of operations (differs from the local proof): the claim is inserted with NO referral and the referral is attached by an UPDATE, because the production
-- BEFORE INSERT trigger claims_apply_locked_referral CLEARS a sent referral that is not 'clicked'/'registered' (ours is 'claim_submitted', so nothing advances and no
-- send-partner-status-email request is queued by claims_advance_referral). The claim is inserted is_test = true (notify_admin_new_claim / ga4 skip test claims);
-- p_claim_test = false flips it afterwards (claims_freeze_is_test only restrains anon/authenticated).
CREATE FUNCTION pg_temp.mk_claim(n int, p_claim_test boolean DEFAULT true, p_ref_test boolean DEFAULT true, p_age interval DEFAULT interval '1 day', p_claim_age interval DEFAULT interval '0') RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_ref uuid := gen_random_uuid(); v_claim uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.referrals(id, referral_agent_id, status, created_at, is_test) VALUES (v_ref, pg_temp.u(100 + n), 'claim_submitted', now() - p_age, p_ref_test);
  INSERT INTO public.claims(id, user_id, is_test, created_at) VALUES (v_claim, pg_temp.u(300 + n), true, now() - p_claim_age);
  UPDATE public.claims SET referral_id = v_ref, referral_agent_id = pg_temp.u(100 + n) WHERE id = v_claim;
  IF NOT p_claim_test THEN
    UPDATE public.claims SET is_test = false WHERE id = v_claim;
  END IF;
  RETURN v_claim;
END $f$;

CREATE FUNCTION pg_temp.mk_order(p_claim uuid, p_role text DEFAULT 'homeowner', p_pi text DEFAULT NULL, p_amount int DEFAULT 1500, p_created timestamptz DEFAULT now()) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_stripe_payment_intent_id, homeowner_charge_amount, created_at)
  VALUES (v_id, p_claim, pg_temp.u(399), p_role, coalesce(p_pi, 'pi_' || v_id::text), p_amount, p_created);
  RETURN v_id;
END $f$;

-- fixtures ------------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.mk_agent(1, 're_agent');
SELECT pg_temp.mk_agent(2, 'insurance_agent');
SELECT pg_temp.mk_agent(3, 'home_inspector');
SELECT pg_temp.mk_agent(4, 'other', true, false, 1);           -- K, recruited by A
SELECT pg_temp.mk_agent(5, 'other');                           -- P
SELECT pg_temp.mk_agent(6, 'other');                           -- Q
SELECT pg_temp.mk_agent(7, 'other');                           -- R
SELECT pg_temp.mk_agent(8, 'other', true, true);               -- W, payments_blocked
SELECT pg_temp.mk_agent(9, 'other');                           -- T, test partner that also holds hidden real-flagged rows (D10)
SELECT pg_temp.mk_agent(10, 'other');                          -- M, is_test mismatch case (real-flagged claim)
SELECT pg_temp.mk_agent(11, 'other');                          -- X
SELECT pg_temp.mk_agent(12, 'customer');                       -- C, refer-a-friend customer
INSERT INTO auth.users(id, email) VALUES (pg_temp.u(299), 'gh3229-nonpartner@otterquote-internal.test'), (pg_temp.u(398), 'gh3229-claimant-398@otterquote-internal.test');

-- Eastern month boundaries (the batch counts a month in America/New_York): m0 = start of the current Eastern month, lm = the previous month, fm = two months ahead
CREATE TEMP TABLE mm ON COMMIT DROP AS SELECT
  (date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York') AS m0,
  (date_trunc('month', now() AT TIME ZONE 'America/New_York') - interval '1 month')::date AS lm,
  (date_trunc('month', now() AT TIME ZONE 'America/New_York'))::date AS cm,
  (date_trunc('month', now() AT TIME ZONE 'America/New_York') + interval '2 months')::date AS fm,
  (date_trunc('month', now() AT TIME ZONE 'America/New_York') + interval '1 month')::date AS nm;
SELECT pg_temp.mk_agent(13, 'other');                          -- N, orders this month only
SELECT pg_temp.mk_agent(14, 'other');                          -- Z, payment reuse / update cases
SELECT pg_temp.mk_agent(15, 'other');                          -- G, window cases (D-402)
SELECT pg_temp.mk_agent(16, 'other', true, false, NULL, NULL); -- never accepted v4
SELECT pg_temp.mk_agent(17, 'other', true, false, NULL, interval '1 hour');   -- accepts v4 after the order
SELECT pg_temp.mk_agent(18, 'other', true, false, NULL, interval '-1 hour');  -- accepted v4 an hour before the order
SELECT pg_temp.mk_agent(19, 'other', false);                   -- the ONE real-flagged (is_test = false) partner: F7c mismatch and the D11 real-caller stats case
SELECT pg_temp.mk_agent(20, 'other');                          -- F7b mismatch (real-flagged referral)
CREATE TEMP TABLE o(k text PRIMARY KEY, id uuid) ON COMMIT DROP;
CREATE TEMP TABLE c(k text PRIMARY KEY, id uuid) ON COMMIT DROP;

-- F0 fixtures behaved as the production guards allow (a silently-forced column would invalidate every later row)
SELECT pg_temp.chk('F0 migration seeded the settings: fee cents / minimum cents', pg_temp.q($$ SELECT (SELECT value #>> '{}' FROM platform_settings WHERE key = 'partner_measurement_fee_cents') || '/' || (SELECT value #>> '{}' FROM platform_settings WHERE key = 'partner_payout_minimum_cents') $$), '500/2500');
SELECT pg_temp.chk('F0b fixture agents: total / is_test true / is_test false / payments_blocked (service_role claim bypassed the INSERT guard)', pg_temp.q($$ SELECT count(*) || '/' || count(*) FILTER (WHERE is_test) || '/' || count(*) FILTER (WHERE NOT is_test) || '/' || count(*) FILTER (WHERE payments_blocked) FROM referral_agents WHERE unique_code LIKE 'GH3229%' $$), '20/19/1/1');
SELECT pg_temp.chk('F0c production partner_v4_accepted_at reads the real columns: accepted agent set / never-accepted agent NULL / future-accepted agent set', pg_temp.q(format($$ SELECT (public.partner_v4_accepted_at(%L) IS NOT NULL) || '/' || (public.partner_v4_accepted_at(%L) IS NULL) || '/' || (public.partner_v4_accepted_at(%L) > now()) $$, pg_temp.u(118), pg_temp.u(116), pg_temp.u(117))), 'true/true/true');

-- F1 credited paid order
INSERT INTO c VALUES ('a1', pg_temp.mk_claim(1));
SELECT pg_temp.chk('F0d the claim kept its referral and agent (claims_apply_locked_referral did not clear them)', pg_temp.q(format($$ SELECT (referral_id IS NOT NULL) || '/' || (referral_agent_id = %L) || '/' || is_test FROM claims WHERE id = %L $$, pg_temp.u(101), (SELECT id FROM c WHERE k = 'a1'))), 'true/true/true');
INSERT INTO o SELECT 'a1', pg_temp.mk_order((SELECT id FROM c WHERE k = 'a1'));
SELECT pg_temp.chk('F1 credited paid order: rows / amount / status / is_test', pg_temp.q(format(
  $$ SELECT count(*) || '/' || max(amount_cents) || '/' || max(status) || '/' || bool_or(is_test) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'a1'))), '1/500/accrued/true');
-- F2 setting 700 -> the next row is 700 (read at insert time); the first row keeps 500
UPDATE platform_settings SET value = to_jsonb(700) WHERE key = 'partner_measurement_fee_cents';
INSERT INTO c VALUES ('a2', pg_temp.mk_claim(1));
INSERT INTO o SELECT 'a2', pg_temp.mk_order((SELECT id FROM c WHERE k = 'a2'));
UPDATE platform_settings SET value = to_jsonb(500) WHERE key = 'partner_measurement_fee_cents';
SELECT pg_temp.chk('F2 setting 700: next row amount', pg_temp.q(format($$ SELECT amount_cents FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'a2'))), '700');
SELECT pg_temp.chk('F2 first row still 500', pg_temp.q(format($$ SELECT amount_cents FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'a1'))), '500');
-- F3 no credited partner
INSERT INTO claims(id, user_id, is_test) VALUES ('3229c000-0000-4000-8000-000000000001', pg_temp.u(398), true);
INSERT INTO o SELECT 'none', pg_temp.mk_order('3229c000-0000-4000-8000-000000000001');
SELECT pg_temp.chk('F3 claim with no referral: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'none'))), '0');
-- F4 duplicate order update: no second row
UPDATE hover_orders SET stripe_payment_id = 'ch_dup', homeowner_charge_amount = 1500, requested_by_role = 'homeowner' WHERE id = (SELECT id FROM o WHERE k = 'a1');
UPDATE hover_orders SET claim_id = claim_id WHERE id = (SELECT id FROM o WHERE k = 'a1');
SELECT pg_temp.chk('F4 duplicate update: rows for the order / for A', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L) $$,
  (SELECT id FROM o WHERE k = 'a1'), pg_temp.u(101))), '1/2');
-- F4b two orders, one PaymentIntent (a retry that made a second order row): one fee
INSERT INTO c VALUES ('z', pg_temp.mk_claim(14));
INSERT INTO o SELECT 'z1', pg_temp.mk_order((SELECT id FROM c WHERE k = 'z'), 'homeowner', 'pi_gh3229_reused');
INSERT INTO o SELECT 'z2', pg_temp.mk_order((SELECT id FROM c WHERE k = 'z'), 'homeowner', 'pi_gh3229_reused');
SELECT pg_temp.chk('F4b two orders sharing one PaymentIntent: fee rows for Z', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(114))), '1');
-- F4c a pre-existing order with no payment id, edited later (admin edit / backfill): accrues nothing
INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_charge_amount) VALUES ('3229f000-0000-4000-8000-000000000001', (SELECT id FROM c WHERE k = 'z'), pg_temp.u(399), 'homeowner', 1500);
UPDATE hover_orders SET stripe_payment_id = 'ch_gh3229_late', homeowner_stripe_payment_intent_id = 'pi_gh3229_late' WHERE id = '3229f000-0000-4000-8000-000000000001';
SELECT pg_temp.chk('F4c UPDATE on a pre-existing order: rows for that order / for Z', pg_temp.q(
  $$ SELECT (SELECT count(*) FROM partner_fee_events WHERE hover_order_id = '3229f000-0000-4000-8000-000000000001') || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = '3229a000-0000-4000-8000-000000000114') $$), '0/1');
-- F11/F12 (D-402) the window runs from the partner CLICK to the MEASUREMENT ORDER, length from referral_attribution_window() (w).
-- Click at day 0; the claim is filed at day w-10 (inside the window); one order at day w-1 (credited), one at day w+1 (not credited, though the claim was inside).
INSERT INTO c VALUES ('g', pg_temp.mk_claim(15, true, true, public.referral_attribution_window() + interval '30 days', interval '40 days'));
INSERT INTO o SELECT 'g1', pg_temp.mk_order((SELECT id FROM c WHERE k = 'g'), 'homeowner', NULL, 1500, now() - interval '31 days');
INSERT INTO o SELECT 'g2', pg_temp.mk_order((SELECT id FROM c WHERE k = 'g'), 'homeowner', NULL, 1500, now() - interval '29 days');
SELECT pg_temp.chk('F11 order at click + (w - 1 day): accrues', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'g1'))), '1');
SELECT pg_temp.chk('F12 order at click + (w + 1 day), claim filed inside the window: no fee', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'g2'))), '0');
-- F13-F15 v4 gate (#3242): accepted before the order accrues; accepted after the order does not; never accepted does not
INSERT INTO c VALUES ('v18', pg_temp.mk_claim(18)); INSERT INTO o SELECT 'v18', pg_temp.mk_order((SELECT id FROM c WHERE k = 'v18'));
INSERT INTO c VALUES ('v17', pg_temp.mk_claim(17)); INSERT INTO o SELECT 'v17', pg_temp.mk_order((SELECT id FROM c WHERE k = 'v17'));
INSERT INTO c VALUES ('v16', pg_temp.mk_claim(16)); INSERT INTO o SELECT 'v16', pg_temp.mk_order((SELECT id FROM c WHERE k = 'v16'));
SELECT pg_temp.chk('F13 v4 accepted before the order: accrues', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'v18'))), '1');
SELECT pg_temp.chk('F14 v4 accepted after the order: no fee (and none later)', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'v17'))), '0');
SELECT pg_temp.chk('F15 never accepted v4: no fee', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'v16'))), '0');
-- NC3 negative control for F14: move the acceptance to an hour BEFORE a new order -> that order accrues, the earlier order (accepted-after) still has none
SELECT pg_temp.svc(format($$ UPDATE public.referral_agents SET partner_agreement_accepted_at = now() - interval '1 hour' WHERE id = %L $$, pg_temp.u(117)));
INSERT INTO o SELECT 'v17b', pg_temp.mk_order((SELECT id FROM c WHERE k = 'v17'));
SELECT pg_temp.chk('NC3 control: v4 now accepted before a NEW order -> that order accrues (1), the earlier order stays 0', pg_temp.q(format($$ SELECT (SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE hover_order_id = %L) $$, (SELECT id FROM o WHERE k = 'v17b'), (SELECT id FROM o WHERE k = 'v17'))), '1/0');
-- F5 inspector (D-333)
INSERT INTO c VALUES ('i', pg_temp.mk_claim(3));
INSERT INTO o SELECT 'i', pg_temp.mk_order((SELECT id FROM c WHERE k = 'i'));
SELECT pg_temp.chk('F5 home inspector: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(103))), '0');
-- NC2 negative control for F5 (D-333): the same claim and partner with the inspector precondition removed (agent_type -> other) accrues on a NEW order
SELECT pg_temp.svc(format($$ UPDATE public.referral_agents SET agent_type = 'other' WHERE id = %L $$, pg_temp.u(103)));
INSERT INTO o SELECT 'i2', pg_temp.mk_order((SELECT id FROM c WHERE k = 'i'));
SELECT pg_temp.chk('NC2 control: same partner no longer an inspector -> a new order accrues', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(103))), '1');
-- F6 click outside the window (window + 10 days before the claim and the order)
INSERT INTO c VALUES ('x', pg_temp.mk_claim(11, true, true, public.referral_attribution_window() + interval '10 days'));
INSERT INTO o SELECT 'x', pg_temp.mk_order((SELECT id FROM c WHERE k = 'x'));
SELECT pg_temp.chk('F6 click outside window: rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(111))), '0');
-- F7a is_test mismatch: REAL-flagged claim, test referral, test agent -> no fee.  NC1 negative control: flip that claim to test, a NEW order on it accrues
INSERT INTO c VALUES ('m', pg_temp.mk_claim(10, false, true));
INSERT INTO o SELECT 'm', pg_temp.mk_order((SELECT id FROM c WHERE k = 'm'));
SELECT pg_temp.chk('F7a is_test mismatch (claim real, referral+agent test): rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(110))), '0');
UPDATE claims SET is_test = true WHERE id = (SELECT id FROM c WHERE k = 'm');
INSERT INTO o SELECT 'm2', pg_temp.mk_order((SELECT id FROM c WHERE k = 'm'));
SELECT pg_temp.chk('NC1 control: claim flag now agrees -> a new order accrues', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(110))), '1');
-- F7b test claim, REAL-flagged referral, test agent -> no fee
INSERT INTO c VALUES ('m3', pg_temp.mk_claim(20, true, false));
INSERT INTO o SELECT 'm3', pg_temp.mk_order((SELECT id FROM c WHERE k = 'm3'));
SELECT pg_temp.chk('F7b is_test mismatch (referral real, claim+agent test): rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(120))), '0');
-- F7c test claim, test referral, REAL-flagged agent -> no fee
INSERT INTO c VALUES ('m4', pg_temp.mk_claim(19, true, true));
INSERT INTO o SELECT 'm4', pg_temp.mk_order((SELECT id FROM c WHERE k = 'm4'));
SELECT pg_temp.chk('F7c is_test mismatch (agent real, claim+referral test): rows', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(119))), '0');
-- F8 contractor-role order, and a homeowner order with no Stripe payment id
INSERT INTO c VALUES ('p0', pg_temp.mk_claim(5));
INSERT INTO o SELECT 'p0c', pg_temp.mk_order((SELECT id FROM c WHERE k = 'p0'), 'contractor');
INSERT INTO hover_orders(id, claim_id, user_id, requested_by_role, homeowner_charge_amount) VALUES (gen_random_uuid(), (SELECT id FROM c WHERE k = 'p0'), pg_temp.u(399), 'homeowner', 1500);
SELECT pg_temp.chk('F8 contractor order / homeowner order without a Stripe id: rows for P', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(105))), '0');
-- F9 all-test chain (T) accrues an is_test row (every other chain in this file is all-test too)
INSERT INTO c VALUES ('t', pg_temp.mk_claim(9, true, true));
INSERT INTO o SELECT 't', pg_temp.mk_order((SELECT id FROM c WHERE k = 't'));
SELECT pg_temp.chk('F9 all-test chain: rows / is_test / amount', pg_temp.q(format($$ SELECT count(*) || '/' || bool_and(is_test) || '/' || max(amount_cents) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(109))), '1/true/500');

-- F10 customer agent accrues
INSERT INTO c VALUES ('cu', pg_temp.mk_claim(12));
INSERT INTO o SELECT 'cu', pg_temp.mk_order((SELECT id FROM c WHERE k = 'cu'));
SELECT pg_temp.chk('F10 customer agent: rows / amount', pg_temp.q(format($$ SELECT count(*) || '/' || max(amount_cents) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(112))), '1/500');

-- B's own order, K's order (K is recruited by A)
INSERT INTO c VALUES ('b', pg_temp.mk_claim(2));
INSERT INTO o SELECT 'b', pg_temp.mk_order((SELECT id FROM c WHERE k = 'b'));
INSERT INTO c VALUES ('k', pg_temp.mk_claim(4));
INSERT INTO o SELECT 'k', pg_temp.mk_order((SELECT id FROM c WHERE k = 'k'));

-- security -------------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('S1 B reads A''s rows', pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-agent-2@otterquote-internal.test',
  format($$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L $$, pg_temp.u(101))), '0');
SELECT pg_temp.chk('S2 B reads own rows', pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-agent-2@otterquote-internal.test', $$ SELECT count(*) FROM partner_fee_events $$), '1');
SELECT pg_temp.chk('S3 A reads own rows', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test', $$ SELECT count(*) FROM partner_fee_events $$), '2');
SELECT pg_temp.chk('S4 admin reads all rows (fixture count)', pg_temp.as_sess('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  $$ SELECT count(*) FROM partner_fee_events WHERE claim_id IS NOT NULL $$), pg_temp.q($$ SELECT count(*) FROM partner_fee_events $$));
SELECT pg_temp.chk('S5 partner INSERT refused', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  format($$ WITH i AS (INSERT INTO partner_fee_events(referral_agent_id, amount_cents) VALUES (%L, 500) RETURNING 1) SELECT count(*) FROM i $$, pg_temp.u(101))), 'ERR 42501');
SELECT pg_temp.chk('S6 partner UPDATE refused', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ WITH u AS (UPDATE partner_fee_events SET amount_cents = 99999 RETURNING 1) SELECT count(*) FROM u $$), 'ERR 42501');
SELECT pg_temp.chk('S7 anon SELECT refused', pg_temp.as_sess('anon', NULL, NULL, $$ SELECT count(*) FROM partner_fee_events $$), 'ERR 42501');
SELECT pg_temp.chk('S8 table privileges authenticated S,I,U,D / anon S (want true,false,false,false / false)', pg_temp.q(
  $$ SELECT has_table_privilege('authenticated','public.partner_fee_events','SELECT') || ',' || has_table_privilege('authenticated','public.partner_fee_events','INSERT')
     || ',' || has_table_privilege('authenticated','public.partner_fee_events','UPDATE') || ',' || has_table_privilege('authenticated','public.partner_fee_events','DELETE')
     || ' / ' || has_table_privilege('anon','public.partner_fee_events','SELECT') $$), 'true,false,false,false / false');

SELECT pg_temp.chk('S9 function EXECUTE for anon/authenticated (production default ACLs grant these explicitly; the migration must have revoked them)', pg_temp.q(
  $$ SELECT string_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'EXECUTE') || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE'), ', ' ORDER BY p.proname)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('create_monthly_fee_batch', 'get_partner_dashboard_stats', 'partner_fee_accrue_on_order', 'partner_fee_events_follow_payout', 'partner_fee_events_mark_paid') $$),
  'create_monthly_fee_batch:false/true, get_partner_dashboard_stats:false/true, partner_fee_accrue_on_order:false/false, partner_fee_events_follow_payout:false/false, partner_fee_events_mark_paid:false/false');
SELECT pg_temp.chk('S10 partner_fee_events: RLS enabled, not forced; policies', pg_temp.q(
  $$ SELECT c.relrowsecurity || '/' || c.relforcerowsecurity || '/' || (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_fee_events') FROM pg_class c WHERE c.oid = 'public.partner_fee_events'::regclass $$),
  'true/false/Admin reads all fee events,Partners read own fee events');

-- orders for the batch cases: P 6, R 6 ($30 each), Q 4 ($20), W 6 (blocked)
INSERT INTO o SELECT 'p' || g, pg_temp.mk_order(pg_temp.mk_claim(5)) FROM generate_series(1, 6) g;
INSERT INTO o SELECT 'r' || g, pg_temp.mk_order(pg_temp.mk_claim(7)) FROM generate_series(1, 6) g;
INSERT INTO o SELECT 'q' || g, pg_temp.mk_order(pg_temp.mk_claim(6)) FROM generate_series(1, 4) g;
INSERT INTO o SELECT 'w' || g, pg_temp.mk_order(pg_temp.mk_claim(8)) FROM generate_series(1, 6) g;
INSERT INTO o SELECT 'n' || g, pg_temp.mk_order(pg_temp.mk_claim(13)) FROM generate_series(1, 6) g;
-- P, R, Q, W accrued last month (10 days before the Eastern month start), except: R's order r6 landed 30 min BEFORE Eastern midnight (still last month),
-- P's order p6 landed 30 min AFTER it (this month, so P's batch is 5 x $5 = $25). N's six stay in the current month.
SELECT pg_temp.x(format($$ UPDATE partner_fee_events SET created_at = %L::timestamptz - interval '10 days' WHERE referral_agent_id IN (%L, %L, %L, %L) $$,
  (SELECT m0 FROM mm), pg_temp.u(105), pg_temp.u(106), pg_temp.u(107), pg_temp.u(108)));
SELECT pg_temp.x(format($$ UPDATE partner_fee_events SET created_at = %L::timestamptz - interval '30 minutes' WHERE hover_order_id = %L $$, (SELECT m0 FROM mm), (SELECT id FROM o WHERE k = 'r6')));
SELECT pg_temp.x(format($$ UPDATE partner_fee_events SET created_at = %L::timestamptz + interval '30 minutes' WHERE hover_order_id = %L $$, (SELECT m0 FROM mm), (SELECT id FROM o WHERE k = 'p6')));

-- partner A: a pending and a paid $200 fee, and a recruit bonus on K's job
INSERT INTO payout_approvals(referral_id, payout_type, partner_id, partner_name, amount, status, is_test) VALUES
  (NULL, 'commission_referral', pg_temp.u(101), 'Proof P1', 200, 'pending_approval', true),
  (NULL, 'commission_referral', pg_temp.u(101), 'Proof P1', 200, 'paid', true),
  (NULL, 'commission_referral', pg_temp.u(101), 'Proof P1', 200, 'rejected', true);
UPDATE referrals SET recruit_commission_amount = 50, status = 'job_completed' WHERE id = (SELECT referral_id FROM claims WHERE id = (SELECT id FROM c WHERE k = 'k'));

-- cross-flag fixtures for D10/D11 (inserted directly). Real caller = agent 19 (the only is_test = false partner): it holds one REAL-flagged referral + event (visible to it) and one
-- TEST-flagged referral + event (hidden from it). Test partner T holds a REAL-flagged referral + event (hidden from it).
INSERT INTO referrals(id, referral_agent_id, status, created_at, is_test) VALUES
  ('3229e000-0000-4000-8000-000000000001', pg_temp.u(119), 'clicked', now(), false),
  ('3229e000-0000-4000-8000-000000000002', pg_temp.u(109), 'clicked', now(), false),
  ('3229e000-0000-4000-8000-000000000003', pg_temp.u(119), 'clicked', now(), true);
SELECT pg_temp.x(format($$ INSERT INTO partner_fee_events(referral_agent_id, payment_ref, amount_cents, status, is_test) VALUES (%L, 'pi_gh3229_xflag_r', 500, 'accrued', false), (%L, 'pi_gh3229_xflag_rt', 500, 'accrued', true), (%L, 'pi_gh3229_xflag_t', 500, 'accrued', false) $$,
  pg_temp.u(119), pg_temp.u(119), pg_temp.u(109)));
SELECT pg_temp.chk('X0 cross-flag event fixtures inserted (3 rows)', pg_temp.q($$ SELECT count(*) FROM partner_fee_events WHERE payment_ref LIKE 'pi_gh3229_xflag_%' $$), '3');

-- dashboard stats, before any batch ---------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('D1 A stats: clicks/signed up/measurements/jobs', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ SELECT clicks || '/' || homeowners_signed_up || '/' || measurements_purchased || '/' || jobs_completed FROM get_partner_dashboard_stats() $$), '2/2/2/0');
SELECT pg_temp.chk('D2 A stats: $200 accrued/paid, $5 accrued/paid, earnings accrued/paid (cents)', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ SELECT referral_fees_accrued_cents || '/' || referral_fees_paid_cents || '/' || measurement_fees_accrued_cents || '/' || measurement_fees_paid_cents || '/' || earnings_accrued_cents || '/' || earnings_paid_cents FROM get_partner_dashboard_stats() $$),
  '20000/20000/1200/0/21200/20000');
SELECT pg_temp.chk('D3 A stats: next payout 0 under the minimum, minimum 2500, accrued 1200', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ SELECT next_payout_cents || '/' || payout_minimum_cents || '/' || accrued_toward_minimum_cents FROM get_partner_dashboard_stats() $$), '0/2500/1200');
SELECT pg_temp.chk('D3b next_payout_month is the month after the current Eastern month', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ SELECT next_payout_month::text FROM get_partner_dashboard_stats() $$), (SELECT nm::text FROM mm));
SELECT pg_temp.chk('D4 P stats: next payout = $30 (accrued, at the minimum), payments_blocked false', pg_temp.as_sess('authenticated', pg_temp.u(205), 'gh3229-agent-5@otterquote-internal.test',
  $$ SELECT next_payout_cents || '/' || accrued_toward_minimum_cents || '/' || payments_blocked FROM get_partner_dashboard_stats() $$), '3000/3000/false');
SELECT pg_temp.chk('D5 W stats: payments_blocked -> next payout 0, payments_blocked true (the card shows the on-hold line)', pg_temp.as_sess('authenticated', pg_temp.u(208), 'gh3229-agent-8@otterquote-internal.test',
  $$ SELECT next_payout_cents || '/' || accrued_toward_minimum_cents || '/' || payments_blocked FROM get_partner_dashboard_stats() $$), '0/3000/true');
SELECT pg_temp.chk('D6 T stats (test partner) sees its own test rows: measurements / $5 accrued / clicks', pg_temp.as_sess('authenticated', pg_temp.u(209), 'gh3229-agent-9@otterquote-internal.test',
  $$ SELECT measurements_purchased || '/' || measurement_fees_accrued_cents || '/' || clicks FROM get_partner_dashboard_stats() $$), '1/500/1');
SELECT pg_temp.chk('D10 ... and not T''s real-flagged event or referral (test caller sees only test rows)', pg_temp.as_sess('authenticated', pg_temp.u(209), 'gh3229-agent-9@otterquote-internal.test',
  $$ SELECT accrued_toward_minimum_cents || '/' || homeowners_signed_up FROM get_partner_dashboard_stats() $$), '500/1');
SELECT pg_temp.chk('D11 REAL partner 19 sees only its real-flagged rows (not its test-flagged referral/event, not the F7c chain): $5 accrued / measurements / clicks', pg_temp.as_sess('authenticated', pg_temp.u(219), 'gh3229-agent-19@otterquote-internal.test',
  $$ SELECT measurement_fees_accrued_cents || '/' || measurements_purchased || '/' || clicks FROM get_partner_dashboard_stats() $$), '500/1/1');
SELECT pg_temp.chk('D11b test partner A still sees only test rows (totals unchanged by the cross-flag rows): $5 accrued / clicks', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ SELECT measurement_fees_accrued_cents || '/' || clicks FROM get_partner_dashboard_stats() $$), '1200/2');
SELECT pg_temp.chk('D7 A recruit earnings: total cents and K''s entry (A sees the bonus ...)', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  format($$ SELECT recruit_earnings_cents || '/' || (SELECT e->>'earnings_cents' FROM jsonb_array_elements(recruits) e WHERE e->>'recruit_id' = %L) FROM get_partner_dashboard_stats() $$, pg_temp.u(104))), '5000/5000');
SELECT pg_temp.chk('D8 ... but nothing of K''s own fees: A''s $5 count excludes K''s order, recruits[] holds only recruit_id and earnings_cents', pg_temp.as_sess('authenticated', pg_temp.u(201), 'gh3229-agent-1@otterquote-internal.test',
  $$ SELECT measurements_purchased || '/' || (SELECT string_agg(DISTINCT k, ',' ORDER BY k) FROM jsonb_array_elements(recruits) e, jsonb_object_keys(e) k) FROM get_partner_dashboard_stats() $$), '2/earnings_cents,recruit_id');
SELECT pg_temp.chk('D9 K sees own fee, no recruit earnings; B sees no recruits; non-partner and anon get nothing',
  pg_temp.as_sess('authenticated', pg_temp.u(204), 'gh3229-agent-4@otterquote-internal.test', $$ SELECT measurements_purchased || '/' || recruit_earnings_cents FROM get_partner_dashboard_stats() $$) || ' ; ' ||
  pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-agent-2@otterquote-internal.test', $$ SELECT recruit_earnings_cents || '/' || recruits::text FROM get_partner_dashboard_stats() $$) || ' ; ' ||
  pg_temp.as_sess('authenticated', pg_temp.u(299), 'gh3229-nonpartner@otterquote-internal.test', $$ SELECT count(*) FROM get_partner_dashboard_stats() $$) || ' ; ' ||
  pg_temp.as_sess('anon', NULL, NULL, $$ SELECT count(*) FROM get_partner_dashboard_stats() $$),
  '1/0 ; 0/[] ; 0 ; ERR 42501');

-- monthly batch ----------------------------------------------------------------------------------------------------------------------------------
SELECT pg_temp.chk('B1 non-admin refused', pg_temp.as_sess('authenticated', pg_temp.u(202), 'gh3229-agent-2@otterquote-internal.test', format($$ SELECT create_monthly_fee_batch(%L::date)::text $$, (SELECT lm FROM mm))), 'ERR 42501');
SELECT pg_temp.chk('B2 anon refused', pg_temp.as_sess('anon', NULL, NULL, format($$ SELECT create_monthly_fee_batch(%L::date)::text $$, (SELECT lm FROM mm))), 'ERR 42501');
SELECT pg_temp.chk('B3 future month refused (nothing changes)', pg_temp.as_sess_undo('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  format($$ SELECT create_monthly_fee_batch(%L::date)::text $$, (SELECT fm FROM mm))), 'ERR 22023');
SELECT pg_temp.chk('B3 current (Eastern) month refused too (nothing changes)', pg_temp.as_sess_undo('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  format($$ SELECT create_monthly_fee_batch(%L::date)::text $$, (SELECT cm FROM mm))), 'ERR 22023');
SELECT pg_temp.chk('B4 admin run: payouts created / events batched / total cents', pg_temp.as_sess('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  format($$ SELECT (r->>'payouts_created') || '/' || (r->>'events_batched') || '/' || (r->>'total_cents') FROM (SELECT create_monthly_fee_batch(%L::date) r) x $$, (SELECT lm FROM mm))), '2/11/5500');
SELECT pg_temp.chk('B4b this month''s accruals are not batched: N payouts / N accrued / P accrued (p6, after Eastern midnight)', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM payout_approvals WHERE partner_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$,
  pg_temp.u(113), pg_temp.u(113), pg_temp.u(105))), '0/6/1');
SELECT pg_temp.chk('B5 P ($25, 5 events): one payout, amount, type, referral_id null, status', pg_temp.q(format(
  $$ SELECT count(*) || '/' || max(amount) || '/' || max(payout_type) || '/' || bool_and(referral_id IS NULL) || '/' || max(status) FROM payout_approvals WHERE partner_id = %L AND payout_type = 'measurement_fees_monthly' $$, pg_temp.u(105))),
  '1/25.00/measurement_fees_monthly/true/pending_approval');
SELECT pg_temp.chk('B5 P events batched and linked', pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events e WHERE e.referral_agent_id = %L AND e.status = 'batched' AND e.payout_approval_id IN (SELECT id FROM payout_approvals WHERE partner_id = %L AND payout_type = 'measurement_fees_monthly') $$, pg_temp.u(105), pg_temp.u(105))), '5');
SELECT pg_temp.chk('B6 rerun creates nothing', pg_temp.as_sess('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  format($$ SELECT (r->>'payouts_created') || '/' || (r->>'events_batched') FROM (SELECT create_monthly_fee_batch(%L::date) r) x $$, (SELECT lm FROM mm))), '0/0');
SELECT pg_temp.chk('B6 payout rows after rerun (P and R only)', pg_temp.q($$ SELECT count(*) FROM payout_approvals WHERE payout_type = 'measurement_fees_monthly' $$), '2');
SELECT pg_temp.chk('B7 Q ($20): no payout, 4 events still accrued', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM payout_approvals WHERE partner_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$, pg_temp.u(106), pg_temp.u(106))), '0/4');
SELECT pg_temp.chk('B8 W (payments_blocked, $30): no payout, 6 events still accrued', pg_temp.q(format(
  $$ SELECT (SELECT count(*) FROM payout_approvals WHERE partner_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$, pg_temp.u(108), pg_temp.u(108))), '0/6');
SELECT pg_temp.chk('B9 A ($12), B, K, T, N rolled over: no payout rows for them', pg_temp.q(format(
  $$ SELECT count(*) FROM payout_approvals WHERE payout_type = 'measurement_fees_monthly' AND partner_id IN (%L, %L, %L, %L) $$, pg_temp.u(101), pg_temp.u(102), pg_temp.u(104), pg_temp.u(109))), '0');

-- mark paid ----------------------------------------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE pp(k text PRIMARY KEY, id uuid) ON COMMIT DROP;
INSERT INTO pp SELECT 'p', id FROM payout_approvals WHERE partner_id = pg_temp.u(105) AND payout_type = 'measurement_fees_monthly';
INSERT INTO pp SELECT 'r', id FROM payout_approvals WHERE partner_id = pg_temp.u(107) AND payout_type = 'measurement_fees_monthly';
SELECT pg_temp.chk('P1 payout not yet paid: flip returns 0, events stay batched (5)', pg_temp.as_sess('service_role', NULL, NULL,
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))) || '/' || pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'batched' $$, (SELECT id FROM pp WHERE k = 'p'))), '0/5');
SELECT pg_temp.chk('P2 non-service caller refused', pg_temp.as_sess('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))), 'ERR 42501');
UPDATE payout_approvals SET status = 'approved' WHERE id = (SELECT id FROM pp WHERE k = 'p');
UPDATE payout_approvals SET status = 'paid', paid_at = now() WHERE id = (SELECT id FROM pp WHERE k = 'p');
SELECT pg_temp.chk('P3 payout became paid: its 5 events are paid with paid_at by the trigger alone, the RPC then flips 0', pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'paid' AND paid_at IS NOT NULL $$, (SELECT id FROM pp WHERE k = 'p'))) || '/' || pg_temp.as_sess('service_role', NULL, NULL,
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))), '5/0');
SELECT pg_temp.x(format($$ UPDATE partner_fee_events SET status = 'batched', paid_at = NULL WHERE id = (SELECT id FROM partner_fee_events WHERE payout_approval_id = %L LIMIT 1) $$, (SELECT id FROM pp WHERE k = 'p')));
SELECT pg_temp.chk('P3b repair: an event reverted to batched by hand is flipped back by the RPC (returns 1), 5 paid again', pg_temp.as_sess('service_role', NULL, NULL,
  format($$ SELECT public.partner_fee_events_mark_paid(%L)::text $$, (SELECT id FROM pp WHERE k = 'p'))) || '/' || pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'paid' $$, (SELECT id FROM pp WHERE k = 'p'))), '1/5');
SELECT pg_temp.chk('P3 R''s events untouched by P''s flip', pg_temp.q(format($$ SELECT count(*) FROM partner_fee_events WHERE payout_approval_id = %L AND status = 'batched' $$, (SELECT id FROM pp WHERE k = 'r'))), '6');
SELECT pg_temp.chk('P4 P stats after paid: $5 paid 2500, accrued 500 (p6, this month), earnings paid 2500', pg_temp.as_sess('authenticated', pg_temp.u(205), 'gh3229-agent-5@otterquote-internal.test',
  $$ SELECT measurement_fees_paid_cents || '/' || measurement_fees_accrued_cents || '/' || earnings_paid_cents FROM get_partner_dashboard_stats() $$), '2500/500/2500');

-- rejected batch payout releases its events, the next run re-batches them ------------------------------------------------------------------------------
UPDATE payout_approvals SET status = 'rejected', rejected_at = now() WHERE id = (SELECT id FROM pp WHERE k = 'r');
SELECT pg_temp.chk('R1 rejected payout: 6 events back to accrued, link cleared', pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued' AND payout_approval_id IS NULL $$, pg_temp.u(107))), '6');
SELECT pg_temp.chk('R1 next run re-batches them: payouts created', pg_temp.as_sess('authenticated', pg_temp.u(299), (SELECT email FROM adm),
  format($$ SELECT (r->>'payouts_created') || '/' || (r->>'events_batched') FROM (SELECT create_monthly_fee_batch(%L::date) r) x $$, (SELECT lm FROM mm))), '1/6');

-- the job-completion rebate (refund) does not touch the fee ------------------------------------------------------------------------------------------------
UPDATE hover_orders SET rebate_paid_at = now(), rebate_due = false WHERE id = (SELECT id FROM o WHERE k = 'q1');
UPDATE hover_orders SET rebate_paid_at = now(), rebate_due = false WHERE id = (SELECT id FROM o WHERE k = 'p1');
SELECT pg_temp.chk('V1 rebate_paid_at set on an accrued event: stays accrued, no voided_at; Q accrued still 4', pg_temp.q(format(
  $$ SELECT (SELECT status || '/' || (voided_at IS NULL) FROM partner_fee_events WHERE hover_order_id = %L) || '/' || (SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued') $$,
  (SELECT id FROM o WHERE k = 'q1'), pg_temp.u(106))), 'accrued/true/4');
SELECT pg_temp.chk('V2 rebate_paid_at set on a paid event: stays paid', pg_temp.q(format($$ SELECT status FROM partner_fee_events WHERE hover_order_id = %L $$, (SELECT id FROM o WHERE k = 'p1'))), 'paid');

-- deleting a batch payout releases its events (they are not stranded as batched with no payout)
SELECT pg_temp.x(format($$ DELETE FROM payout_approvals WHERE partner_id = %L AND payout_type = 'measurement_fees_monthly' $$, pg_temp.u(107)));
SELECT pg_temp.chk('N8 payout deleted: R''s 6 events back to accrued, link cleared', pg_temp.q(format(
  $$ SELECT count(*) FROM partner_fee_events WHERE referral_agent_id = %L AND status = 'accrued' AND payout_approval_id IS NULL $$, pg_temp.u(107))), '6');

-- FINAL GATE: always raises, so the transaction can never commit.  P0U01 = every row OK, P0U03 = at least one DIFF.
DO $f$
DECLARE s text; bad text; n_ok int; n_diff int;
BEGIN
  SELECT string_agg(rpad(k, 100) || ' | got ' || got || ' | want ' || want || ' | ' || CASE WHEN got = want THEN 'OK' ELSE 'DIFF' END, E'\n' ORDER BY k),
         string_agg(CASE WHEN got <> want THEN rpad(k, 100) || ' | got ' || got || ' | want ' || want END, E'\n' ORDER BY k),
         count(*) FILTER (WHERE got = want), count(*) FILTER (WHERE got <> want)
    INTO s, bad, n_ok, n_diff FROM _r;
  IF n_diff > 0 THEN
    RAISE EXCEPTION E'GH3229 PROD PROOF FAILED (forced rollback): % DIFF\nFAILING ROWS\n%\nALL ROWS\n%\nTALLY: % OK, % DIFF', n_diff, bad, s, n_ok, n_diff USING ERRCODE = 'P0U03';
  END IF;
  RAISE EXCEPTION E'GH3229 PROD PROOF PASSED (forced rollback, nothing was committed)\n%\nTALLY: % OK, % DIFF', s, n_ok, n_diff USING ERRCODE = 'P0U01';
END $f$;

-- never reached (the DO above always raises); present so that an editor that swallows the error still ends the transaction without committing
ROLLBACK;
