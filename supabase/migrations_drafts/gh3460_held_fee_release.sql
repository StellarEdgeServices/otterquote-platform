-- STATUS (gh-1438, as of 2026-11-05T20:30:30Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3460_held_fee_release (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-05 under #3460 (P18, parent #3447). Reads only the repo: supabase/migrations_drafts/gh3229_partner_measurement_fee.sql (the accrual trigger function, unchanged here)
--   and supabase/migrations/20260825113857_gh1245_admin_measurements_rls.sql (hover_orders: admin all, owner SELECT only). No database was written or read to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3460_held_fee_release
-- GitHub: #3460 (PROJECT P18), parent #3447, owed by PR #3455. Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097.
-- Rollback: gh3460_held_fee_release_rollback.sql   Pre-flight: gh3460_held_fee_release_pre-flight.md
-- Proof: supabase/tests/gh3460_held_fee_release_proof.sql   Local run: supabase/tests/gh3460_held_fee_release_local_run.sh   Runbook: runbooks/held-partner-fee-release.md
--
-- Problem. After #3455 a paid measurement order whose buyer role cannot be shown is stored with requested_by_role = 'unspecified'. partner_fee_accrue_on_order is
-- AFTER INSERT and fires only WHEN NEW.requested_by_role = 'homeowner', so such an order accrues no $5 (held for review, Partner Agreement v4 A4.1: earned when a Referred
-- Homeowner buys). Correcting the role later accrues nothing, and a hand-written fee_events INSERT would skip the attribution, state, inspector and v4 checks.
--
-- What this file does (no copy of the checks anywhere)
--   1. A second trigger on hover_orders that runs the SAME function, partner_fee_accrue_on_order(), AFTER UPDATE OF requested_by_role, and only when the role
--      moves from 'unspecified' to 'homeowner'. Every check (credited referral, D-402 window, is_test agreement, D-333 inspector, excluded states, v4 acceptance,
--      fee setting, one fee per order and per payment) therefore stays in ONE place; changing the function changes both paths. Any other role edit still accrues nothing:
--      a 'contractor' order edited to 'homeowner' does not backfill, and editing an older homeowner order does not backfill.
--   2. public.admin_settle_order_buyer_role(order, role, contractor, note, require_fee): admin or service role only. Moves one 'unspecified' order to 'homeowner' or
--      'contractor', appends an audit line to hover_orders.admin_notes, and for 'homeowner' reports the fee event the trigger created. With p_require_fee (default true)
--      a 'homeowner' settlement that does not accrue a fee is REFUSED (the whole call rolls back, the order stays 'unspecified', the fee stays held). p_require_fee = false
--      removes that refusal only: the role is recorded, and a qualifying order still accrues through the trigger. It cannot withhold an earned fee. It exists so the ready email can be sent when the buyer is a homeowner and the checks refuse.
--      Idempotent: a repeat call on an order already settled to the same role changes nothing and returns already_settled; the table's UNIQUE(hover_order_id) and
--      UNIQUE(payment_ref) keys stop a second fee even under a race.
--   NULL handling: the admin guard and p_require_fee are forced to non-NULL booleans (a JWT with no email claim, no claims at all, or an explicit NULL p_require_fee all fail closed).
--   The ready email is NOT sent by SQL. After settling, re-save the order in admin-measurements.html (this PR makes a re-save of an already delivered order send it).
--   Nothing is backfilled and no fee is created at apply time.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 0. prerequisites ----------------------------------------------------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public.partner_fee_accrue_on_order()') IS NULL
     OR to_regclass('public.partner_fee_events') IS NULL THEN
    RAISE EXCEPTION 'gh3460: public.partner_fee_accrue_on_order() / partner_fee_events do not exist; apply gh3229_partner_measurement_fee.sql first' USING ERRCODE = '55000';
  END IF;
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh3460: public.is_admin_email() does not exist' USING ERRCODE = '55000';
  END IF;
END
$guard$;

-- 1. the same accrual function, fired when a held order's role is settled to 'homeowner' --------------------------------------------------
DROP TRIGGER IF EXISTS partner_fee_accrue_on_role_settled ON public.hover_orders;
CREATE TRIGGER partner_fee_accrue_on_role_settled
  AFTER UPDATE OF requested_by_role
  ON public.hover_orders
  FOR EACH ROW
  WHEN (OLD.requested_by_role = 'unspecified' AND NEW.requested_by_role = 'homeowner' AND NEW.product_code IS DISTINCT FROM 'roof_upgrade_detailed')
  EXECUTE FUNCTION public.partner_fee_accrue_on_order();

-- 2. admin function --------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_settle_order_buyer_role(
  p_order_id      uuid,
  p_role          text,
  p_contractor_id uuid    DEFAULT NULL,
  p_note          text    DEFAULT NULL,
  p_require_fee   boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order   public.hover_orders%ROWTYPE;
  v_fee     public.partner_fee_events%ROWTYPE;
  v_who     text;
  v_note    text;
BEGIN
  -- NULL-safe: is_admin_email() is NULL (not false) when the JWT has no email claim, and `NOT (false OR NULL)` is NULL, which IF treats as false (the guard would be skipped).
  -- So this is a positive match with every operand forced to a non-NULL boolean; anything that is not a clear yes is refused.
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR COALESCE(public.is_admin_email(), false)) THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: admin or service role only' USING ERRCODE = '42501';
  END IF;
  IF p_order_id IS NULL OR p_role IS NULL OR p_role NOT IN ('homeowner', 'contractor') THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: p_order_id is required and p_role must be homeowner or contractor' USING ERRCODE = '22023';
  END IF;
  IF p_role = 'contractor' AND p_contractor_id IS NULL THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: a contractor order needs p_contractor_id' USING ERRCODE = '22023';
  END IF;
  IF p_role = 'homeowner' AND p_contractor_id IS NOT NULL THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: a homeowner order takes no p_contractor_id' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.hover_orders WHERE id = p_order_id FOR UPDATE;   -- two clicks serialize here
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: order % not found', p_order_id USING ERRCODE = 'P0002';
  END IF;

  -- idempotent: already settled to this role -> nothing changes, report what exists
  IF v_order.requested_by_role IS NOT DISTINCT FROM p_role THEN
    SELECT * INTO v_fee FROM public.partner_fee_events WHERE hover_order_id = p_order_id;
    RETURN jsonb_build_object('order_id', p_order_id, 'role', p_role, 'already_settled', true,
      'fee_event_id', v_fee.id, 'fee_cents', v_fee.amount_cents, 'fee_status', v_fee.status);
  END IF;
  IF v_order.requested_by_role IS DISTINCT FROM 'unspecified' THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: order % has role %, only an unspecified order can be settled', p_order_id, COALESCE(v_order.requested_by_role, '<NULL>')
      USING ERRCODE = '55000';
  END IF;

  -- D-317: the upgrade is contractor-only and is not a Paid Measurement (Partner Agreement v4 definitions), so it can never be settled to a homeowner.
  IF p_role = 'homeowner' AND v_order.product_code IS NOT DISTINCT FROM 'roof_upgrade_detailed' THEN
    RAISE EXCEPTION 'admin_settle_order_buyer_role: order % is a contractor upgrade (D-317); it cannot be settled to homeowner', p_order_id USING ERRCODE = '22023';
  END IF;

  v_who := COALESCE(NULLIF(auth.jwt() ->> 'email', ''), COALESCE(auth.role(), 'unknown'));
  v_note := 'role settled unspecified -> ' || p_role || ' by ' || v_who || ' at ' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            || ' (gh-3460)' || CASE WHEN NULLIF(btrim(p_note), '') IS NOT NULL THEN ': ' || left(btrim(p_note), 500) ELSE '' END;

  -- the update fires partner_fee_accrue_on_role_settled for 'homeowner': the SAME checks as the insert trigger run here
  UPDATE public.hover_orders
     SET requested_by_role = p_role,
         requested_by_contractor_id = CASE WHEN p_role = 'contractor' THEN p_contractor_id ELSE NULL END,
         admin_notes = CASE WHEN admin_notes IS NULL OR btrim(admin_notes) = '' THEN v_note ELSE admin_notes || E'\n' || v_note END
   WHERE id = p_order_id;

  IF p_role = 'homeowner' THEN
    SELECT * INTO v_fee FROM public.partner_fee_events WHERE hover_order_id = p_order_id;
    IF NOT FOUND AND COALESCE(p_require_fee, true) THEN     -- an explicit NULL means 'require' (NULL would otherwise skip the refusal)
      -- the trigger's checks refused it (no credited partner, outside the window, excluded state, inspector, v4, test mismatch, payment already paid a fee...).
      -- Undo the role change: the order stays 'unspecified' and the $5 stays held.
      RAISE EXCEPTION 'admin_settle_order_buyer_role: order % does not qualify for the partner fee under the accrual checks; role not changed (p_require_fee => false removes only this refusal: a qualifying order still accrues, and the role can then never be re-settled)', p_order_id
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN jsonb_build_object('order_id', p_order_id, 'role', p_role, 'already_settled', false,
    'fee_event_id', v_fee.id, 'fee_cents', v_fee.amount_cents, 'fee_status', v_fee.status);
END;
$function$;

COMMENT ON FUNCTION public.admin_settle_order_buyer_role(uuid, text, uuid, text, boolean) IS
  'gh-3460 (P18): admin or service role only. Settles one unspecified hover_orders row to homeowner or contractor. For homeowner the update fires partner_fee_accrue_on_role_settled, which runs partner_fee_accrue_on_order() (the single copy of the attribution, window, is_test, inspector, excluded-state and v4 checks); with p_require_fee (default true) a settlement that accrues no fee is refused and rolled back; p_require_fee false removes only that refusal, and a qualifying order still accrues. Idempotent. Does not send the ready email: re-save the order in admin-measurements.html.';

REVOKE ALL ON FUNCTION public.admin_settle_order_buyer_role(uuid, text, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_settle_order_buyer_role(uuid, text, uuid, text, boolean) TO authenticated, service_role;

COMMIT;
