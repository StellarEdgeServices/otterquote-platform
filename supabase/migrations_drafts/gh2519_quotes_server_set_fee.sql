-- gh-2519: the server sets the bid fee; column allow-list; one selected bid per claim; commission bound to the claim's contractor.
-- STATUS (gh-1438, as of 2026-10-08T00:01:23Z): NOT APPLIED
-- EVIDENCE: drafted by the cto62-fee worker under ruling 6049007305 on #2519; production read-only at 2026-10-08T00:01:23Z: quotes_guard_homeowner_columns() prosrc md5 f6102d1c…, apply_referral_commission() prosrc md5 5cd19c8b…, no function quotes_platform_fee_for
-- REPO COPY: none in supabase/migrations/ (not applied). Rollback and pre-flight: supabase/migrations_rollbacks/gh2519_quotes_server_set_fee_rollback.sql and gh2519_quotes_server_set_fee_pre-flight.md
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177, R-097 24-hour notice, recorded apply).
-- Proof (throwaway Postgres, beside failing controls on today's schema): supabase/tests/gh2519_gh2564_fee_lock_proof.sql
--
-- Tier 3B, NOT the R-134 fast path: it rewrites what a live bid path stores (ruling 6049007305).
-- What changes, for client callers only (current_user anon/authenticated, JWT role not service_role, not an
-- admin). service_role (every Edge Function), admins and owner-level SECURITY DEFINER functions are untouched, exactly as today, except accept_bid(), which gains one refusal (item 4).
--   1. INSERT: platform_fee_pct, fee_percentage and platform_fee_basis are written from the
--      platform_fee_config row for the bid's contractor and claim, and fee_amount is computed from
--      total_price. Whatever the browser sent in those four fields is overwritten, not refused, so both live
--      bid forms keep working unchanged. With no config row the bid is refused (P0001): no rate is invented.
--   2. UPDATE by the bid's own contractor: the three rate fields keep their stored values and fee_amount is
--      recomputed from the new total_price. `UPDATE quotes SET platform_fee_pct = 4` leaves the stored rate.
--   3. Column allow-list on UPDATE (residual 3). The claim owner may change status (selected / declined) and
--      homeowner_signed_at; the bid's contractor the columns the two bid forms send on a change-bid save and
--      contractor_signed_at; both updated_at. Anything else (payment_status, payment_intent_id, is_test,
--      bid_status, ...) is refused 42501. On INSERT the test, payment, envelope, cancellation, expiry and
--      warranty-upload columns must be born at their defaults.
--   4. Residual 4: a client may set a bid to selected only when no other bid on that claim is selected, and
--      apply_referral_commission() reads the bid of claims.selected_contractor_id, not the newest selected bid.
--      The same rule holds through rpc accept_bid() (review 6050036561 B1, CEO ruling 6050104316): it is
--      SECURITY DEFINER, so the guard cannot see the caller, and it now refuses itself (42501) when another bid
--      on the claim is already selected. switch-contractor is the one re-award path.
-- NOT here: the price-and-fee lock on a selected bid (D-369). That is gh2564_quotes_selected_price_lock.sql, its own change.
--
-- TIER C POINT LEFT OPEN BY THE RULING (which rate a REVISED bid carries if the configured rate changed after
-- the bid was submitted): the constant c_revised_bid_takes_current_config_rate at the top of the guard
-- function. false (built) = the stored rate stays; true = the revised bid takes the configured rate. One line.
-- RULED by the CEO (6050104316): the stored rate stays; the constant stays false (D-214: the displayed fee is
-- what the contractor accepted). Standing condition: platform_fee_config is not edited until both bid forms read
-- and display the server's rate.
--
-- No fee, rate, basis or price rule is chosen in this file. Every number comes from public.platform_fee_config
-- (one row on production: fee_pct 5.00, fee_basis bid_amount, effective 2026-05-06).
--
-- One function is ADDED (quotes_platform_fee_for, a read of the fee config; needed because the config table
-- is readable by admins only and the guard runs as the caller). No trigger is added: the rules live inside
-- the existing quotes_guard_homeowner_columns(), and every earlier rule is kept verbatim.
-- Three functions are replaced (guard, commission, accept_bid). Idempotent: CREATE OR REPLACE FUNCTION. No table, policy, trigger or data change.

BEGIN;

CREATE OR REPLACE FUNCTION public.quotes_platform_fee_for(p_contractor_id uuid, p_claim_id uuid)
RETURNS TABLE (fee_pct numeric, fee_basis text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fee$
  -- The lookup both bid forms and process-auto-bids are written to make (D-214): the row for the
  -- contractor's state and the claim's first trade, a NULL state or trade meaning "any", the more specific
  -- row first. No rate is written here: every number comes from public.platform_fee_config.
  SELECT f.fee_pct, f.fee_basis
    FROM public.platform_fee_config f
   WHERE (f.state IS NULL OR f.state = upper(COALESCE(
            (SELECT k.address_state FROM public.contractors k WHERE k.id = p_contractor_id), '')))
     AND (f.trade IS NULL OR f.trade = lower(COALESCE(NULLIF(
            (SELECT c.trades[1] FROM public.claims c WHERE c.id = p_claim_id), ''), 'roofing')))
   ORDER BY f.state DESC NULLS LAST, f.trade DESC NULLS LAST
   LIMIT 1;
$fee$;

COMMENT ON FUNCTION public.quotes_platform_fee_for(uuid, uuid) IS
  'gh-2519: the platform fee rate and basis for a bid by this contractor on this claim, read from public.platform_fee_config (state = contractors.address_state, trade = the claim''s first trade, NULL = any, most specific first). SECURITY DEFINER because platform_fee_config is readable by admins only and the quotes guard runs as the caller. Holds no rate of its own. Called by quotes_guard_homeowner_columns().';

REVOKE ALL ON FUNCTION public.quotes_platform_fee_for(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quotes_platform_fee_for(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.quotes_platform_fee_for(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
  -- gh-2519 TIER C SWITCH (ruling 6049007305, "NOT DECIDED"): which rate does a REVISED bid carry if the
  -- configured rate changed after the bid was first submitted?
  --   false = the rate stored on the bid when it was submitted stays (what happens today; the build default,
  --           and the CTO's recommended answer under D-214 / D-215);
  --   true  = the revised bid takes the rate configured at the time of the revision.
  -- Either answer is this ONE line. Nothing else in the function changes.
  c_revised_bid_takes_current_config_rate CONSTANT boolean := false;
  v_is_contractor boolean;
  v_is_owner      boolean;
  v_fee_pct       numeric;
  v_fee_basis     text;
  v_allowed       text[];
  v_refused       text;
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN

    IF TG_OP = 'INSERT' THEN
      -- gh-2479 born state: a client-created quote is the caller's own new bid and nothing later
      IF NOT COALESCE(EXISTS (
               SELECT 1 FROM public.contractors k
                WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
        RAISE EXCEPTION 'quotes: a bid can only be created by the contractor it names (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      IF COALESCE(NEW.status <> 'submitted', true)
         OR COALESCE(NEW.bid_status <> 'active', true)
         OR NEW.is_auto_bid IS TRUE
         OR NEW.renewed_from_quote_id IS NOT NULL
         OR NEW.homeowner_signed_at IS NOT NULL
         OR NEW.contractor_signed_at IS NOT NULL
         OR NEW.payment_status IS NOT NULL THEN
        RAISE EXCEPTION 'quotes: a new bid must start as a submitted, active bid; selection, renewal, signing and payment state are set later by the platform (gh-2479)'
          USING ERRCODE = '42501';
      END IF;

      -- gh-2519 residual 3, on INSERT: the columns neither bid form sends, which carry test, payment,
      -- signing-envelope, cancellation, expiry or warranty-upload state, must be born at their defaults.
      IF COALESCE(NEW.is_test, true)
         OR NEW.payment_intent_id IS NOT NULL
         OR NEW.payment_method_id IS NOT NULL
         OR NEW.payment_method_type IS NOT NULL
         OR NEW.card_fee_cents IS NOT NULL
         OR NEW.docusign_envelope_id IS NOT NULL
         OR NEW.cancelled_at IS NOT NULL
         OR NEW.cancellation_reason IS NOT NULL
         OR NEW.expires_at IS NOT NULL
         OR NEW.expired_at IS NOT NULL
         OR NEW.warranty_document_url IS NOT NULL
         OR NEW.warranty_uploaded_at IS NOT NULL THEN
        RAISE EXCEPTION 'quotes: a new bid cannot carry test, payment, envelope, cancellation, expiry or warranty-upload state; those are set later by the platform (gh-2519)'
          USING ERRCODE = '42501';
      END IF;

      -- gh-2519: the server sets the fee on every browser-written bid. Whatever the browser sent in
      -- platform_fee_pct, fee_percentage, platform_fee_basis and fee_amount is OVERWRITTEN (not refused, so
      -- both live bid forms keep working unchanged) from the fee config row for this contractor and claim.
      SELECT f.fee_pct, f.fee_basis INTO v_fee_pct, v_fee_basis
        FROM public.quotes_platform_fee_for(NEW.contractor_id, NEW.claim_id) f;
      IF v_fee_pct IS NULL OR v_fee_basis IS NULL THEN
        -- no rate is invented here: with no config row the bid is not saved
        RAISE EXCEPTION 'quotes: no platform fee is configured for this bid, so it cannot be saved (gh-2519)'
          USING ERRCODE = 'P0001';
      END IF;
      NEW.platform_fee_pct   := v_fee_pct;
      NEW.fee_percentage     := v_fee_pct;
      NEW.platform_fee_basis := v_fee_basis;
      NEW.fee_amount         := round((v_fee_pct / 100.0) * NEW.total_price, 2);
      RETURN NEW;
    END IF;

    IF COALESCE(
         (NEW.claim_id IS DISTINCT FROM OLD.claim_id)
         OR (NEW.contractor_id IS DISTINCT FROM OLD.contractor_id),
         true) THEN
      RAISE EXCEPTION 'quotes: claim_id and contractor_id can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    v_is_contractor := COALESCE(EXISTS (
        SELECT 1 FROM public.contractors k
         WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false);
    v_is_owner := COALESCE(EXISTS (
        SELECT 1 FROM public.claims c
         WHERE c.id = OLD.claim_id AND c.user_id = auth.uid()), false);

    -- gh-2519: on the bid's own contractor's UPDATE the server sets the fee. The three rate fields keep
    -- their stored values (or take the configured rate, per the Tier C switch above) and fee_amount is
    -- recomputed from the new total_price. Whatever the browser sent in the four fields is OVERWRITTEN.
    -- A legacy row with no platform_fee_pct keeps it NULL; its fee_amount is computed from fee_percentage.
    IF v_is_contractor THEN
      IF c_revised_bid_takes_current_config_rate THEN
        SELECT f.fee_pct, f.fee_basis INTO v_fee_pct, v_fee_basis
          FROM public.quotes_platform_fee_for(OLD.contractor_id, OLD.claim_id) f;
        IF v_fee_pct IS NULL OR v_fee_basis IS NULL THEN
          RAISE EXCEPTION 'quotes: no platform fee is configured for this bid, so it cannot be saved (gh-2519)'
            USING ERRCODE = 'P0001';
        END IF;
        NEW.platform_fee_pct   := v_fee_pct;
        NEW.fee_percentage     := v_fee_pct;
        NEW.platform_fee_basis := v_fee_basis;
      ELSE
        NEW.platform_fee_pct   := OLD.platform_fee_pct;
        NEW.fee_percentage     := OLD.fee_percentage;
        NEW.platform_fee_basis := OLD.platform_fee_basis;
      END IF;
      NEW.fee_amount := round((COALESCE(NEW.platform_fee_pct, NEW.fee_percentage) / 100.0) * NEW.total_price, 2);
    END IF;

    IF COALESCE(NEW.total_price IS DISTINCT FROM OLD.total_price, true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: total_price can only be changed by the bidding contractor, service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;

    IF COALESCE(NEW.status IS DISTINCT FROM OLD.status, true)
       AND NOT COALESCE(
             NEW.status IN ('selected', 'declined')
             AND EXISTS (
               SELECT 1 FROM public.claims c
                WHERE c.id = OLD.claim_id AND c.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: status can only be set to selected or declined by the claim owner; other changes need service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2519: the fee columns. Only the bid's own contractor may change them (the bid forms send all four on
    -- a change-bid save), and for that contractor the server has already set them above. The claim owner,
    -- who holds UPDATE on every column through the policy "Homeowners can update quotes for their claims",
    -- never writes them: no client page does.
    IF COALESCE(
         (NEW.fee_amount IS DISTINCT FROM OLD.fee_amount)
         OR (NEW.fee_percentage IS DISTINCT FROM OLD.fee_percentage)
         OR (NEW.platform_fee_pct IS DISTINCT FROM OLD.platform_fee_pct)
         OR (NEW.platform_fee_basis IS DISTINCT FROM OLD.platform_fee_basis),
         true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis can only be changed by the bidding contractor, service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2519 residual 4: a client may set a bid to selected only when no other bid on that claim is selected.
    IF COALESCE(NEW.status IN ('selected', 'awarded'), false)
       AND NOT COALESCE(OLD.status IN ('selected', 'awarded'), false)
       AND EXISTS (
             SELECT 1 FROM public.quotes q2
              WHERE q2.claim_id = OLD.claim_id AND q2.id <> OLD.id
                AND q2.status IN ('selected', 'awarded')) THEN
      RAISE EXCEPTION 'quotes: another bid on this claim is already selected; a second bid cannot be selected beside it (gh-2519)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2519 residual 3: column allow-list. Whatever else changed must be a column this caller's pages
    -- write today. The claim owner: status (judged above) and homeowner_signed_at. The bid's own contractor:
    -- the columns the two bid forms send on a change-bid save, and contractor_signed_at. Everything else
    -- (payment_status, payment_intent_id, is_test, bid_status, fee_accepted_at for the owner, and the rest)
    -- is refused. A value re-sent unchanged is not a change.
    v_allowed := ARRAY['updated_at'];
    IF v_is_owner THEN
      v_allowed := v_allowed || ARRAY['status', 'homeowner_signed_at'];
    END IF;
    IF v_is_contractor THEN
      v_allowed := v_allowed || ARRAY[
        'total_price', 'fee_percentage', 'fee_amount', 'platform_fee_pct', 'platform_fee_basis', 'fee_accepted_at',
        'scope_summary', 'notes', 'decking_price_per_sheet', 'full_redeck_price', 'supplement_acknowledged',
        'trade_type', 'value_adds', 'per_trade_breakdown', 'auto_renew',
        'warranty_option_id', 'warranty_snapshot', 'workmanship_warranty_years',
        'contractor_signed_at'];
    END IF;
    SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO v_refused
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND NOT (n.key = ANY (v_allowed));
    IF v_refused IS NOT NULL THEN
      RAISE EXCEPTION 'quotes: % can only be changed by service_role or an admin (gh-2519)', v_refused
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing, payment, test, envelope, cancellation, expiry or warranty-upload state, and the server sets platform_fee_pct, fee_percentage, platform_fee_basis and fee_amount from quotes_platform_fee_for() whatever the browser sent; on UPDATE cannot change claim_id or contractor_id, can change total_price only as the quote''s own contractor (whose three rate fields then keep their stored values and whose fee_amount is recomputed from total_price), cannot change the fee columns as anyone else, can change status only as the claim owner, only to selected or declined, and to selected only when no other bid on the claim is selected, and can change no column outside the caller''s allow-list (owner: status, homeowner_signed_at; contractor: the bid-form columns and contractor_signed_at). Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

CREATE OR REPLACE FUNCTION public.apply_referral_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_referral            public.referrals%ROWTYPE;
  v_referrer            public.referral_agents%ROWTYPE;
  v_recruiter           public.referral_agents%ROWTYPE;
  v_referral_approval   UUID;
  v_recruit_approval    UUID;
  v_service_role_key    TEXT;
  v_quote_id            UUID;
  v_total_price         NUMERIC;
BEGIN
  IF NEW.referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = NEW.referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT id, total_price INTO v_quote_id, v_total_price
    FROM public.quotes
    WHERE claim_id = NEW.id
      AND status IN ('selected', 'awarded')
      -- gh-2519 (ruling 6049007305, residual 4): the commission reads the bid of the contractor the claim
      -- was awarded to (claims.selected_contractor_id), never "the newest selected bid". A second bid that
      -- reached status selected by any route cannot lift the job over the $10,000 floor. A claim with no
      -- selected contractor matches no bid and accrues nothing.
      AND contractor_id = NEW.selected_contractor_id
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1;

  IF v_quote_id IS NULL OR COALESCE(v_total_price, 0) < 10000 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- ── gh-2479 (ruling #2403 comment 5972625589): three precondition checks,
  -- all before any write. Each one only removes capability: it can turn an
  -- accrual into a no-op, never the reverse.
  -- (a) is_test must agree on claim, referral and referrer. A test claim must
  --     not accrue against a live referral, nor a live claim against a test one.
  IF COALESCE(NEW.is_test, false) IS DISTINCT FROM COALESCE(v_referral.is_test, false)
     OR COALESCE(NEW.is_test, false) IS DISTINCT FROM COALESCE(v_referrer.is_test, false) THEN
    RAISE LOG 'apply_referral_commission: gh-2479 is_test mismatch (claim=% referral=% referrer=%), no accrual for claim_id=% referral_id=%',
      NEW.is_test, v_referral.is_test, v_referrer.is_test, NEW.id, v_referral.id;
    RETURN NEW;
  END IF;

  -- (b) status: only a referral that has been attributed to a claim
  --     (claims_advance_referral moves clicked/registered -> claim_submitted,
  --     and only inside the 30-day window) may accrue. A bare clicked or
  --     registered referral never advanced, so it is expired or unattributed.
  IF v_referral.status IS NULL
     OR v_referral.status NOT IN ('claim_submitted', 'bid_received', 'contract_signed') THEN
    RAISE LOG 'apply_referral_commission: gh-2479 referral status % is not an attributed status, no accrual for claim_id=% referral_id=%',
      v_referral.status, NEW.id, v_referral.id;
    RETURN NEW;
  END IF;

  -- (c) attribution window, measured when the id was stamped on the claim
  --     (claims.created_at, frozen for client callers by the guard), never now() - 30 days at completion: a job that
  --     takes longer than 30 days keeps its commission. A NULL date accrues
  --     nothing (#2403 closes-on item 3).
  IF v_referral.created_at IS NULL
     OR NEW.created_at IS NULL
     OR v_referral.created_at < NEW.created_at - public.referral_attribution_window() THEN
    RAISE LOG 'apply_referral_commission: gh-2479 referral outside attribution window (referral.created_at=% claim.created_at=%), no accrual for claim_id=% referral_id=%',
      v_referral.created_at, NEW.created_at, NEW.id, v_referral.id;
    RETURN NEW;
  END IF;

  -- ── D-333 guard 1: no referral fee to a home_inspector referrer. ──
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' THEN

    UPDATE public.referrals
       SET commission_amount = 200,
           job_value         = v_total_price,
           status            = CASE
                                 WHEN status = 'commission_paid'
                                   THEN status
                                 ELSE 'job_completed'
                               END
     WHERE id = v_referral.id;

    INSERT INTO public.payout_approvals (
      referral_id, payout_type, partner_id, partner_name,
      amount, trigger_event, status, auto_approve_at, is_test
    )
    VALUES (
      v_referral.id,
      'commission_referral',
      v_referrer.id,
      TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')),
      200,
      'Job completed — referral ' || v_referral.id::TEXT || ' (claim ' || NEW.id::TEXT || ')',
      'pending_approval',
      NOW() + INTERVAL '7 days',
      COALESCE(NEW.is_test, false)
    )
    RETURNING id INTO v_referral_approval;

  ELSE
    -- D-333: home_inspector referrer — mark the job completed with no
    -- commission so the referral ledger still reflects reality, but accrue
    -- and pay nothing.
    UPDATE public.referrals
       SET job_value = v_total_price,
           status     = CASE
                          WHEN status = 'commission_paid'
                            THEN status
                          ELSE 'job_completed'
                        END
     WHERE id = v_referral.id;

    RAISE LOG 'apply_referral_commission: D-333 no-fee — referrer % is agent_type=home_inspector, no referral fee accrued for referral_id=%',
      v_referrer.id, v_referral.id;
  END IF;

  -- Recruit bonus: gated on the RECRUITER's own agent_type (D-333), not the
  -- referrer's. A non-inspector who recruited a home_inspector still earns
  -- the $50 bonus on that inspector's completed referral — unchanged.
  --
  -- FIXUP (review 5817579721): the inspector-referrer branch above never
  -- sets commission_amount, so the function's only other idempotency check
  -- never trips for it. `recruit_commission_amount = 0` is an independent
  -- idempotency check on the recruit bonus itself, so a second completion
  -- on the same referral cannot pay the $50 bonus twice, no matter what
  -- commission_amount is doing.
  IF v_referrer.recruited_by_id IS NOT NULL
     AND v_referrer.recruited_at IS NOT NULL
     AND v_referral.created_at   >= v_referrer.recruited_at
     AND COALESCE(v_referral.recruit_commission_amount, 0) = 0 THEN

    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    -- ── D-333 guard 2: no recruit bonus to a home_inspector recruiter. ──
    IF FOUND AND v_recruiter.agent_type IS DISTINCT FROM 'home_inspector' THEN

      UPDATE public.referrals
         SET recruit_commission_amount = 50
       WHERE id = v_referral.id;

      UPDATE public.referral_agents
         SET recruit_earnings = COALESCE(recruit_earnings, 0) + 50
       WHERE id = v_referrer.recruited_by_id;

      INSERT INTO public.payout_approvals (
        referral_id, payout_type, partner_id, partner_name,
        amount, trigger_event, status, auto_approve_at, is_test
      )
      VALUES (
        v_referral.id,
        'commission_recruit',
        v_referrer.recruited_by_id,
        TRIM(COALESCE(v_recruiter.first_name, '') || ' ' || COALESCE(v_recruiter.last_name, '')),
        50,
        'Recruit bonus — referral ' || v_referral.id::TEXT || ' (referrer: ' || TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')) || ')',
        'pending_approval',
        NOW() + INTERVAL '7 days',
        COALESCE(NEW.is_test, false)
      )
      RETURNING id INTO v_recruit_approval;

    ELSIF FOUND THEN
      RAISE LOG 'apply_referral_commission: D-333 no-fee — recruiter % is agent_type=home_inspector, no recruit bonus accrued for referral_id=%',
        v_recruiter.id, v_referral.id;
    END IF;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_role_key
      FROM vault.decrypted_secrets
     WHERE name = 'cron_service_role_key';

    IF v_service_role_key IS NULL THEN
      RAISE LOG 'apply_referral_commission: vault secret cron_service_role_key not found — skipping notify-payout-pending for approval_id=%', v_referral_approval;
    ELSIF v_referral_approval IS NOT NULL THEN
      PERFORM net.http_post(
        url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-payout-pending',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_service_role_key
        ),
        body    := jsonb_build_object(
          'payout_approval_id', v_referral_approval
        )
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE LOG 'apply_referral_commission: pg_net call to notify-payout-pending failed (non-fatal). approval_id=% sqlstate=% sqlerrm=%',
        v_referral_approval, SQLSTATE, SQLERRM;
  END;

  -- FIXUP (review 5817579721 item 2, D-333): a home_inspector referrer must
  -- not trigger send-partner-status-email, which tells the partner "your
  -- referral fee/payment is on its way" — an inspector accrues no fee and
  -- gets no such message. A non-inspector referral is unaffected (control).
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' THEN
    BEGIN
      IF v_service_role_key IS NULL THEN
        SELECT decrypted_secret INTO v_service_role_key
          FROM vault.decrypted_secrets
         WHERE name = 'cron_service_role_key';
      END IF;

      IF v_service_role_key IS NULL THEN
        RAISE LOG 'apply_referral_commission: vault secret cron_service_role_key not found — skipping send-partner-status-email for referral_id=%', v_referral.id;
      ELSE
        PERFORM net.http_post(
          url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-status-email',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_role_key
          ),
          body    := jsonb_build_object('referral_id', v_referral.id)
        );
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE LOG 'apply_referral_commission: pg_net call to send-partner-status-email failed (non-fatal) for referral_id=% sqlstate=% sqlerrm=%',
          v_referral.id, SQLSTATE, SQLERRM;
    END;
  ELSE
    RAISE LOG 'apply_referral_commission: D-333 no-fee — referrer % is agent_type=home_inspector, skipping send-partner-status-email for referral_id=%',
      v_referrer.id, v_referral.id;
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for claim_id=% referral_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.referral_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.apply_referral_commission() IS
  'Trigger function attached to claims AFTER UPDATE OF completion_date (after_claim_completed). On completion, when the selected/awarded quote of the claim''s selected contractor (claims.selected_contractor_id; gh-2519) is >= $10,000, inserts a pending_approval payout_approvals row for $200 to the referrer and, when forward-only recruit criteria pass, $50 to the recruiter. D-333 (gh-2155): a home_inspector referrer accrues NO referral fee and triggers no send-partner-status-email; a home_inspector recruiter accrues NO recruit bonus (the referrer''s own type does not gate the recruit bonus). Idempotent via commission_amount > 0 (referral fee) and recruit_commission_amount > 0 (recruit bonus), independently. SECURITY DEFINER; all commission-side errors are swallowed and logged.';

-- gh-2519, CEO ruling 6050104316 on PR #2612 (review 6050036561 finding B1): accept_bid() is the second award route.
-- Live body (prosrc md5 07ae60dd…) plus the claim-row lock and ONE refusal, marked gh-2519. Owner, signature, grants and
-- the rest of the body are unchanged; CREATE OR REPLACE keeps EXECUTE for authenticated.
CREATE OR REPLACE FUNCTION public.accept_bid(p_claim_id uuid, p_quote_id uuid)
 RETURNS TABLE(out_claim_id uuid, out_quote_id uuid, out_contractor_id uuid, out_amount numeric, out_declined_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_contractor uuid; v_amount numeric; v_declined integer; v_has_pm boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'accept_bid: no authenticated user' USING ERRCODE='28000';
  END IF;

  -- Ownership check + row lock: only the claim's own homeowner may accept a bid on it,
  -- and FOR UPDATE OF q takes the lock in the same statement that authorizes the caller,
  -- so two simultaneous accepts on one claim serialize instead of racing.
  SELECT q.contractor_id, q.total_price INTO v_contractor, v_amount
    FROM quotes q JOIN claims c ON c.id = q.claim_id
   WHERE q.id = p_quote_id AND q.claim_id = p_claim_id AND c.user_id = v_uid
   FOR UPDATE OF q;

  IF v_contractor IS NULL THEN
    RAISE EXCEPTION 'accept_bid: quote % is not a bid on claim % owned by the caller',
      p_quote_id, p_claim_id USING ERRCODE='42501';
  END IF;

  -- gh-2519 (CEO ruling 6050104316 on PR #2612): one selected bid per claim holds through this route too.
  -- This function is SECURITY DEFINER, so quotes_guard_homeowner_columns() does not see the caller as a client
  -- and cannot refuse here. When another bid on the claim is already selected, refuse; the one re-award path is
  -- switch-contractor. The claim row is locked first so two simultaneous accepts of different bids serialize.
  PERFORM 1 FROM claims WHERE id = p_claim_id AND user_id = v_uid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM quotes q3
              WHERE q3.claim_id = p_claim_id AND q3.id <> p_quote_id
                AND q3.status IN ('selected', 'awarded')) THEN
    RAISE EXCEPTION 'accept_bid: another bid on this claim is already selected; a second bid cannot be selected beside it (gh-2519)'
      USING ERRCODE='42501';
  END IF;

  -- gh-1532: guard the money path -- a bid cannot be accepted for a contractor
  -- with no payment method on file. The BEFORE UPDATE trigger above is the
  -- enforcement point of record (it also covers the React direct-update path
  -- this RPC's HTML callers do not use); this check exists so bids.html and
  -- contractor-about.html get the same readable, ERRCODE-matchable refusal
  -- before the UPDATE below rather than depending on how the trigger's
  -- exception text surfaces back through this SECURITY DEFINER call.
  SELECT has_payment_method INTO v_has_pm FROM contractors WHERE id = v_contractor;
  IF v_has_pm IS NOT TRUE THEN
    RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE claims SET selected_contractor_id = v_contractor,
                    selected_bid_amount    = v_amount,
                    status                 = 'awarded',
                    updated_at             = now()
   WHERE id = p_claim_id AND user_id = v_uid;

  UPDATE quotes SET status = 'selected', updated_at = now() WHERE id = p_quote_id;

  WITH d AS (UPDATE quotes q2 SET status = 'declined', updated_at = now()
              WHERE q2.claim_id = p_claim_id AND q2.id <> p_quote_id
                AND q2.status IN ('submitted','draft') RETURNING 1)
  SELECT count(*)::int INTO v_declined FROM d;

  RETURN QUERY SELECT p_claim_id, p_quote_id, v_contractor, v_amount, v_declined;
END $function$;

COMMIT;
