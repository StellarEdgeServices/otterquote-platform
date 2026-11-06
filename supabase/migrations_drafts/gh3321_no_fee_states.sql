-- STATUS (gh-1438, as of 2026-11-05): NOT APPLIED
-- FILE ROLE: forward file of set gh3321_no_fee_states (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-11-05 under #3321 on top of PR #3337 (gh3330). No production read was needed to write it: the body it restates is the gh3330 draft's, whose pre-image
--   (production md5 2eba9b9601c731cb20f45ef5a18c742b) was read on 2026-11-02. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3321_no_fee_states
-- GitHub: #3321. Money + legal: Tier 3B (CREATE OR REPLACE of a SECURITY DEFINER money trigger function). Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097.
-- Ruled: Dustin, via Ben (CEO RUN 145), #3321 comment 6664032518, verbatim "Blank accrues; $50 withheld too (Recommended)"; D-401 item 7, D-387, D-392 and v4 A4.4 are the rule.
-- DEPENDS ON gh3330 (PR #3337, the body this restates; apply it first, with #3326's set per Ben's ruling 6667102434). Refuses to run on any other body.
-- Rollback: gh3321_no_fee_states_rollback.sql   Pre-flight: gh3321_no_fee_states_pre-flight.md
-- Proof: supabase/tests/gh3321_no_fee_states_proof.sql   Runner: supabase/tests/gh3321_no_fee_states_proof_run.sh
--
-- What this file does
--   apply_referral_commission(): a claim whose property_state (upper, btrim) is OK, AR, KS, NE or MS earns neither the $200 Job Referral Fee nor the $50 Recruit Bonus,
--   and the referrer gets no fee email. A NULL or blank property_state is not excluded and accrues as before. The five states are a constant in the function body (no new
--   setting, no new object, no new grant): changing the list is a migration with a re-audit, which fits a published legal promise. Everything else is unchanged:
--   the gh3330 recruiter-v4 gate, the gh3245 customer gate, the home_inspector rules, the is_test/status/window checks. The diff against the gh3330 body is the gh-3321 lines.
--   Not done, and not invented: any surface for the monthly batch review of blank-state rows. See the pre-flight, "Batch review of blank-state rows".

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.apply_referral_commission()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('7b9bc6957cb15534514f1e1ab9e32bbf',    -- the gh3330 body (PR #3337) this file restates
                                    'fed947cd0851aa492e9217c1f9855597') THEN                         -- this file's body (re-run)
    RAISE EXCEPTION 'gh3321 guard: apply_referral_commission() body drifted (md5 %); apply gh3330 first, or re-audit', v_md5;
  END IF;
END
$guard$;

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
  v_v4_gated            BOOLEAN := false;  -- gh-3245 (#3243)
  v_state_excluded      BOOLEAN := false;  -- gh-3321 (#3321)
  v_v4_cutoff           TIMESTAMPTZ;       -- gh-3245
  v_v4_at               TIMESTAMPTZ;       -- gh-3245
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

  -- ── gh-3245 (#3243, Dustin "YES" 2026-10-30; Ben ruling on PR #3249, reading (b)): a refer-a-friend customer earns the
  -- $200 on a referral created on or after the Partner Agreement v4 publication cutoff only if the customer had accepted v4
  -- at or before the claim carrying the referral was filed (NEW.created_at: Agreement Section 9.3, "A project starts when the
  -- homeowner's claim is filed on Otter Quotes"). A referral created before the
  -- cutoff is honoured under the old program. Every other agent_type is untouched. A missing or unreadable cutoff gates
  -- (fails closed) and says so in the log. A gated referral is ledgered like the D-333 branch: job_completed, no fee,
  -- no recruit bonus, no "your fee is on its way" email.
  IF v_referrer.agent_type = 'customer' THEN
    BEGIN
      SELECT (s.value #>> '{}')::timestamptz INTO v_v4_cutoff
        FROM public.platform_settings s
       WHERE s.key = 'partner_agreement_v4_published_at';
    EXCEPTION WHEN OTHERS THEN
      v_v4_cutoff := NULL;
    END;
    IF v_v4_cutoff IS NULL THEN
      v_v4_gated := true;
      RAISE LOG 'apply_referral_commission: gh-3245 partner_agreement_v4_published_at missing or invalid, customer referral gated for referral_id=%', v_referral.id;
    ELSIF v_referral.created_at >= v_v4_cutoff THEN
      v_v4_at := public.partner_v4_accepted_at(v_referrer.id);
      IF v_v4_at IS NULL OR v_v4_at > NEW.created_at THEN
        v_v4_gated := true;
        RAISE LOG 'apply_referral_commission: gh-3245 customer % had not accepted Partner Agreement v4 when claim % (referral %) was filed (accepted_at=% claim.created_at=%), no referral fee accrued',
          v_referrer.id, NEW.id, v_referral.id, v_v4_at, NEW.created_at;
      END IF;
    END IF;
  END IF;

  -- ── gh-3321 (#3321; D-401 item 7, D-387, D-392, Partner Agreement v4 A4.4): no partner fee on a claim whose property is in OK, AR, KS, NE or MS. ──
  -- Dustin (CEO RUN 145, answering Marty's Q, recorded on #3321 comment 6664032518), verbatim: "Blank accrues; $50 withheld too (Recommended)".
  -- Option text shown to him: "A blank state accrues and gets checked at monthly batch review before anyone is paid. The $50 is treated as a partner fee and
  -- withheld in those five states." So in the five states NEITHER the $200 Job Referral Fee NOR the $50 Recruit Bonus accrues, and no "your fee is on its
  -- way" email is sent; a NULL or blank property_state is NOT excluded and accrues as before (the monthly batch review checks those rows before anyone is paid).
  -- upper(btrim()) is how the D-344 gate and the $5 measurement-fee path (gh-3229) read claims.property_state; a spelled-out state name is not matched.
  -- NEW is the claims row being completed. The excluded referral is ledgered like the D-333 / gh-3245 branch: job_value set, status job_completed, no fee,
  -- no recruit bonus. This is an exclusion by the agreement, not a withhold: it is not a candidate for release (pre-flight query W2).
  -- COALESCE is load-bearing: IN over a NULL state is NULL, and NOT NULL is NULL, so without it a NULL state would fall out of the fee test and accrue nothing (fail closed).
  v_state_excluded := COALESCE(upper(btrim(NEW.property_state)) IN ('OK', 'AR', 'KS', 'NE', 'MS'), false);   -- NULL or blank: false, accrues
  IF v_state_excluded THEN
    RAISE LOG 'apply_referral_commission: gh-3321 property_state % is a no-partner-fee state (A4.4), no referral fee and no recruit bonus for referral_id=% claim_id=%',
      NEW.property_state, v_referral.id, NEW.id;
  END IF;

  -- ── D-333 guard 1: no referral fee to a home_inspector referrer. ──
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' AND NOT v_v4_gated AND NOT v_state_excluded THEN   -- gh-3321: and not a no-fee state

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
    -- and pay nothing. gh-3245: also a customer referral gated on Partner Agreement v4.
    UPDATE public.referrals
       SET job_value = v_total_price,
           status     = CASE
                          WHEN status = 'commission_paid'
                            THEN status
                          ELSE 'job_completed'
                        END
     WHERE id = v_referral.id;

    RAISE LOG 'apply_referral_commission: D-333/gh-3245 no-fee — referrer % (agent_type=%, v4 gate=%), no referral fee accrued for referral_id=%',
      v_referrer.id, v_referrer.agent_type, v_v4_gated, v_referral.id;
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
     AND COALESCE(v_referral.recruit_commission_amount, 0) = 0
     AND NOT v_v4_gated                                        -- gh-3245: no Job Referral Fee, no Recruit Bonus (Section 4, A4.3)
     AND NOT v_state_excluded THEN                             -- gh-3321: no partner fee in OK, AR, KS, NE, MS (A4.4)

    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    -- ── gh-3330 (#3330; Dustin, 2026-11-02 13:17 ET, asked "should a recruiter who hasn't accepted the v4 agreement earn the $50
    -- bonus?": "No."): a recruiter earns the $50 only if the RECRUITER holds Partner Agreement v4
    -- (partner_v4_accepted_at(recruiter) IS NOT NULL). The Recruit Bonus predates v4 (v3 Section 4, D-139; D-401 item 7 keeps it);
    -- this condition is Dustin's ruling, not a v3 term. No cutoff and no timing test: the recruiter must hold v4 when the referral
    -- completes. A recruiter without it is WITHHELD, not dropped:
    -- nothing is accrued or paid now (recruit_commission_amount stays 0, no recruit_earnings, no payout row), the referral still
    -- completes and the referrer still gets the $200, and the case is logged here. It stays recoverable by query (pre-flight
    -- query W). There is NO release path yet: a recruiter who accepts v4 later is not paid automatically (see pre-flight).
    IF FOUND AND v_recruiter.agent_type IS DISTINCT FROM 'home_inspector'
       AND public.partner_v4_accepted_at(v_recruiter.id) IS NULL THEN
      RAISE LOG 'apply_referral_commission: gh-3330 recruiter % has not accepted Partner Agreement v4, $50 recruit bonus WITHHELD (not accrued) for referral_id=% (referrer %)',
        v_recruiter.id, v_referral.id, v_referrer.id;

    -- ── D-333 guard 2: no recruit bonus to a home_inspector recruiter. ──
    ELSIF FOUND AND v_recruiter.agent_type IS DISTINCT FROM 'home_inspector' THEN

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
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' AND NOT v_v4_gated AND NOT v_state_excluded THEN   -- gh-3245 / gh-3321: no fee, no fee email
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
    RAISE LOG 'apply_referral_commission: D-333/gh-3245 no-fee — referrer % (agent_type=%, v4 gate=%), skipping send-partner-status-email for referral_id=%',
      v_referrer.id, v_referrer.agent_type, v_v4_gated, v_referral.id;
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for claim_id=% referral_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.referral_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure) <> 'fed947cd0851aa492e9217c1f9855597' THEN
    RAISE EXCEPTION 'gh3321 forward: body check failed after CREATE OR REPLACE';
  END IF;
END
$check$;

COMMIT;
