-- STATUS (gh-1438, as of 2026-10-30T16:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3245_customer_fee_v4_gate (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3245 (refs #3243); production read-only SELECTs the same day (project yeszghaspzwwstvsrioa). No database was written.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and
--   pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Evidence detail (production read-only 2026-10-30): apply_referral_commission() is SECURITY DEFINER, search_path public, pg_temp, fired by
--   after_claim_completed (AFTER UPDATE OF completion_date ON claims); md5(prosrc) = 7f7d0419c59b9853d4082a713258ddd6, byte-identical to
--   supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql lines 399-658 (the newest definition in the repo). platform_settings
--   (key text PK, value jsonb NOT NULL, updated_at) has no partner_agreement_v4_published_at key. 2 customer referral_agents, 5 customer referrals.
--
-- Migration: gh3245_customer_fee_v4_gate
-- GitHub: #3245, refs #3243 (Dustin "YES", chat 2026-10-30 10:45 ET). Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097.
-- DEPENDS ON gh3239_partner_agreement_v4 (PR #3242): partner_v4_accepted_at(). Apply gh3239 first; this file refuses to run without it.
-- Rollback: gh3245_customer_fee_v4_gate_rollback.sql   Pre-flight: gh3245_customer_fee_v4_gate_pre-flight.md
-- Proof: supabase/tests/gh3245_customer_fee_v4_gate_proof.sql   Runner: supabase/tests/gh3245_customer_fee_v4_gate_proof_run.sh
--
-- What this file does
--   1. platform_settings 'partner_agreement_v4_published_at' = the moment this file is applied (to_jsonb(now())), ON CONFLICT DO NOTHING.
--      Apply it in the #3242 publish window; if it is applied later, set the key to the v4 publish time first (pre-flight step 2), or every
--      customer referral between publication and apply is honoured under the old program.
--   2. apply_referral_commission(): for agent_type 'customer' only, a referral created on or after that cutoff accrues the $200 only when
--      partner_v4_accepted_at(customer) IS NOT NULL AND <= claims.created_at of the claim carrying it (Ben, reading (b), Agreement Section 9.3). Otherwise the referral is ledgered as job_completed with no
--      fee, no recruit bonus and no fee email (the D-333 branch). A missing/unreadable cutoff gates customer referrals (fails closed) and logs it.
--      Non-customer referrers and the rest of the body are unchanged (the full body is restated below; the diff is the gh-3245 lines).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.partner_v4_accepted_at(uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh3245 guard: partner_v4_accepted_at(uuid) is missing; apply gh3239_partner_agreement_v4 first';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.apply_referral_commission()');
  IF v_md5 IS NULL OR v_md5 NOT IN ('7f7d0419c59b9853d4082a713258ddd6',    -- audited body (production 2026-10-30)
                                    '2eba9b9601c731cb20f45ef5a18c742b') THEN -- this file's body (re-run)
    RAISE EXCEPTION 'gh3245 guard: apply_referral_commission() body drifted (md5 %); re-audit before applying', v_md5;
  END IF;
END
$guard$;

INSERT INTO public.platform_settings (key, value)
VALUES ('partner_agreement_v4_published_at', to_jsonb(now()))
ON CONFLICT (key) DO NOTHING;

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

  -- ── D-333 guard 1: no referral fee to a home_inspector referrer. ──
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' AND NOT v_v4_gated THEN

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
     AND NOT v_v4_gated THEN                                   -- gh-3245: no Job Referral Fee, no Recruit Bonus (Section 4, A4.3)

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
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' AND NOT v_v4_gated THEN   -- gh-3245: no fee, no fee email
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

COMMIT;
