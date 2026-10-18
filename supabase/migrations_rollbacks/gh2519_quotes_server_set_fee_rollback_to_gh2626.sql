-- Rollback for supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql (gh-2519) WHEN gh2626_claims_award_columns_guard.sql IS APPLIED (#2519 comment 6156383757).
-- Same as gh2519_quotes_server_set_fee_rollback.sql except that quotes_guard_homeowner_columns() and accept_bid() are restored to the bodies of
-- gh2626_claims_award_columns_guard.sql (byte for byte), which carry the gh-2626 lines, instead of the pre-gh-2626 live bodies. REFUSES if gh2626 is not applied.
-- WARNING: this RE-OPENS #2519's residuals: the bidding contractor can again store any fee rate, basis and fee
-- amount on a bid, the claim owner can again write payment_status, is_test and the other columns, a second
-- bid can again be set to selected, and the referral commission again reads the newest selected bid.
-- ORDER: run gh2564_quotes_selected_price_lock_rollback.sql FIRST if gh2564_quotes_selected_price_lock.sql was applied (it re-creates this guard).
-- This file REFUSES (RAISE EXCEPTION, nothing changes) while the live guard still carries the gh-2564 lock (review 6051777895 finding 7), and refuses
-- when gh2626_claims_award_columns_guard.sql is NOT applied (then use gh2519_quotes_server_set_fee_rollback.sql, which restores the pre-gh-2626 bodies).
-- It restores quotes_guard_homeowner_columns() and accept_bid() to the bodies of gh2626_claims_award_columns_guard.sql (the bodies that were
-- live after that set and before gh2519; the claims trigger of gh2626 is untouched) and apply_referral_commission() to the body of
-- 20261005151842_gh2479_referral_guard_and_commission_checks.sql (prosrc md5 5cd19c8b…), byte for byte, with
-- their comments, and drops the one function and the one index the migration added. The trigger is untouched. No data is lost:
-- the migration changed no table. Fee values the server wrote while it was live stay as stored.
-- If the migration was applied, also delete its supabase_migrations.schema_migrations row.
-- COMMENT TEXTS (re-review 6051423781 finding 9): the COMMENT on quotes_guard_homeowner_columns() below is the text of
-- gh2626_claims_award_columns_guard.sql. The COMMENT on apply_referral_commission() below matches NO file under
-- supabase/migrations/ (the last repo COMMENT on that function is 20260819225113_gh1050, a different text); it was written
-- from production's pg_description by the author of the first draft and cannot be verified from the repo (md5 of this text
-- 4f8b242d). Before the apply, compare it with production: SELECT left(md5(obj_description('public.apply_referral_commission()'::regprocedure,'pg_proc')),8)
-- must read 4f8b242d; if not, correct the text in this file to production's before relying on this rollback.
BEGIN;

-- gh-2564 order guard: the gh2564 lock lives inside quotes_guard_homeowner_columns(), the same function this rollback restores.
-- With the lock applied, this rollback would silently remove it (D-369). It refuses; run gh2564_quotes_selected_price_lock_rollback.sql first.
DO $order$
BEGIN
  IF COALESCE((SELECT position('gh-2564' IN prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.quotes_guard_homeowner_columns()')), 0) > 0 THEN
    RAISE EXCEPTION '%: gh-2564 (the selected-bid price lock, D-369) is applied; this rollback would silently remove it. Run gh2564_quotes_selected_price_lock_rollback.sql first', 'gh2519 rollback';
  END IF;
END
$order$;

-- gh-2626 order guard: this file restores the gh-2626 bodies and needs gh2626_claims_award_columns_guard.sql applied (its trigger function claims_guard_award_columns()).
-- If it is not applied, use gh2519_quotes_server_set_fee_rollback.sql instead.
DO $order26$
BEGIN
  IF to_regprocedure('public.claims_guard_award_columns()') IS NULL THEN
    RAISE EXCEPTION '%: gh2626_claims_award_columns_guard is not applied; use gh2519_quotes_server_set_fee_rollback.sql instead', 'gh2519 rollback to gh2626';
  END IF;
END
$order26$;

CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
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
      RETURN NEW;
    END IF;

    IF COALESCE(
         (NEW.claim_id IS DISTINCT FROM OLD.claim_id)
         OR (NEW.contractor_id IS DISTINCT FROM OLD.contractor_id),
         true) THEN
      RAISE EXCEPTION 'quotes: claim_id and contractor_id can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
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
    -- a change-bid save). The claim owner, who holds UPDATE on every column through the policy "Homeowners can
    -- update quotes for their claims", never writes them: no client page does. fee_amount is derived from
    -- platform_fee_pct by quotes_normalize_fee_amount(), which fires after this guard and sees what this
    -- guard let through.
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

    -- gh-2626: the owner may not revive a quote. bid_status (active / expired / superseded / cancelled) is the
    -- bidding contractor's own state and the platform's (process-bid-expirations, rescind-bid: service_role);
    -- no owner-side page writes it (grep in the PR body). Only the quote's own contractor, service_role or an
    -- admin may change it.
    IF COALESCE(NEW.bid_status IS DISTINCT FROM OLD.bid_status, true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: bid_status can only be changed by the bidding contractor, service_role or an admin (gh-2626)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2626: the owner selects a bid only from a submitted bid whose bid_status is active. An expired,
    -- withdrawn (cancelled), superseded or declined bid cannot be moved back to selected by the owner.
    IF NEW.status = 'selected' AND OLD.status IS DISTINCT FROM 'selected'
       AND (OLD.status IS DISTINCT FROM 'submitted' OR COALESCE(OLD.bid_status, 'active') <> 'active') THEN
      RAISE EXCEPTION 'quotes: only a submitted, active bid can be selected by the claim owner (gh-2626)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2626 (review 6155821752 B2, review 6157765833 B1b): the owner may mark a bid declined only from submitted.
    -- A draft (never submitted) or expired quote cannot be relabelled declined and then accepted through accept_bid(),
    -- and neither can a switched-away, refunded quote that stays selected (accept_bid() admits declined, so
    -- selected -> declined -> accept_bid() would re-award it). No app path moves a quote from selected to declined.
    IF NEW.status = 'declined' AND OLD.status IS DISTINCT FROM 'declined'
       AND COALESCE(OLD.status <> 'submitted', true) THEN
      RAISE EXCEPTION 'quotes: only a submitted bid can be declined by the claim owner (gh-2626)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.quotes_guard_homeowner_columns() IS
  'gh-2479 / gh-2519: BEFORE INSERT OR UPDATE guard on public.quotes. Client roles (anon, authenticated) that are not admins: on INSERT can create only their own bid (contractor_id is a contractor row of the caller) born status submitted, bid_status active, not an auto-bid, not a renewal, with no signing or payment state; on UPDATE cannot change claim_id or contractor_id, can change total_price, fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis only as the quote''s own contractor, and can change status only as the claim owner and only to selected (and to selected only from a submitted bid whose bid_status is active) or declined (to declined only from a submitted bid), and can change bid_status only as the quote''s own contractor (gh-2626). Rejected 42501; an unchanged value is not a change. service_role, admins and owner-level (SECURITY DEFINER) sessions such as accept_bid() are untouched.';

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
  'Trigger function attached to claims AFTER UPDATE OF completion_date (after_claim_completed). On completion with a selected/awarded quote >= $10,000, inserts a pending_approval payout_approvals row for $200 to the referrer and, when forward-only recruit criteria pass, $50 to the recruiter. D-333 (gh-2155): a home_inspector referrer accrues NO referral fee and triggers no send-partner-status-email; a home_inspector recruiter accrues NO recruit bonus (the referrer''s own type does not gate the recruit bonus). Idempotent via commission_amount > 0 (referral fee) and recruit_commission_amount > 0 (recruit bonus), independently. SECURITY DEFINER; all commission-side errors are swallowed and logged.';

-- accept_bid(): back to the body of gh2626_claims_award_columns_guard.sql, byte for byte.
CREATE OR REPLACE FUNCTION public.accept_bid(p_claim_id uuid, p_quote_id uuid)
RETURNS TABLE (out_claim_id uuid, out_quote_id uuid, out_contractor_id uuid,
               out_amount numeric, out_declined_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_uid uuid := auth.uid(); v_contractor uuid; v_amount numeric; v_declined integer; v_has_pm boolean;
        v_q_status text; v_q_bid_status text; v_rows integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'accept_bid: no authenticated user' USING ERRCODE='28000';
  END IF;

  -- Ownership check + row lock: only the claim's own homeowner may accept a bid on it,
  -- and FOR UPDATE OF q takes the lock in the same statement that authorizes the caller,
  -- so two simultaneous accepts on one claim serialize instead of racing.
  SELECT q.contractor_id, q.total_price, q.status, q.bid_status
    INTO v_contractor, v_amount, v_q_status, v_q_bid_status
    FROM quotes q JOIN claims c ON c.id = q.claim_id
   WHERE q.id = p_quote_id AND q.claim_id = p_claim_id AND c.user_id = v_uid
   FOR UPDATE OF q;

  IF v_contractor IS NULL THEN
    RAISE EXCEPTION 'accept_bid: quote % is not a bid on claim % owned by the caller',
      p_quote_id, p_claim_id USING ERRCODE='42501';
  END IF;

  -- gh-2626 (Ben, DECIDED 1): an expired, withdrawn (cancelled), superseded or otherwise not-active bid is not
  -- awardable by anyone. A bid is awardable only while its bid_status is active (or NULL) and its status is
  -- submitted or declined (declined = the losers of an earlier award in a switched claim). A selected quote is
  -- refused (review 6155821752 B1: a switched-away, refunded contractor stays selected because switch-contractor's
  -- 'cancelled' write fails quotes_status_check, and must not be re-awarded). An expired quote and a draft are refused.
  IF COALESCE(v_q_status, '') NOT IN ('submitted', 'declined')
     OR COALESCE(v_q_bid_status, 'active') <> 'active' THEN
    RAISE EXCEPTION 'bid_not_awardable: this bid is expired, withdrawn or no longer active, so it cannot be accepted'
      USING ERRCODE = 'P0001';
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

  -- gh-2626 (Ben, DECIDED 2): only a claim that is open for bids (status active or bidding, the names in
  -- claims_status_check) can be awarded, and a claim is never moved out of contract_signed (or draft, awarded,
  -- waitlisted, ...) by this function. The status test is part of the UPDATE, so it cannot race with a
  -- service_role write (docusign-webhook sets contract_signed) between a read and the write.
  UPDATE claims SET selected_contractor_id = v_contractor,
                    selected_bid_amount    = v_amount,
                    status                 = 'awarded',
                    updated_at             = now()
   WHERE id = p_claim_id AND user_id = v_uid AND status IN ('active', 'bidding');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'claim_not_awardable: this claim is not open for bids, so a bid cannot be accepted on it'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE quotes SET status = 'selected', updated_at = now() WHERE id = p_quote_id;

  WITH d AS (UPDATE quotes q2 SET status = 'declined', updated_at = now()
              WHERE q2.claim_id = p_claim_id AND q2.id <> p_quote_id
                AND q2.status IN ('submitted','draft') RETURNING 1)
  SELECT count(*)::int INTO v_declined FROM d;

  RETURN QUERY SELECT p_claim_id, p_quote_id, v_contractor, v_amount, v_declined;
END $fn$;

-- gh-2519 re-review 6051423781 finding 3: the partial unique index the migration added.
DROP INDEX IF EXISTS public.quotes_one_selected_bid_per_claim;

DROP FUNCTION IF EXISTS public.quotes_platform_fee_for(uuid, uuid);

COMMIT;
