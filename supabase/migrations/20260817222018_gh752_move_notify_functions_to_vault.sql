-- gh-752: move notify_admin_new_contractor() and apply_referral_commission()
-- off the unset app.* GUCs onto the Vault pattern (matches
-- gh720_move_hardcoded_secret_to_vault and the 10 live cron jobs).
-- D-182 Tier 3 -- Dustin approved 2026-08-17 (issue #752 comment history).
--
-- Applied to production via apply_migration 2026-08-17T22:20:18Z. This file is
-- the repo-tracked record per AC6 (gh-720 was applied with no repo file --
-- do not repeat that).
--
-- Bodies below are byte-identical to the migration-author package posted on
-- issue #752 (comment 2026-08-17T21:06:47Z), which itself matches
-- pg_get_functiondef captured live from production the same session.

-- 1 of 2: notify_admin_new_contractor
CREATE OR REPLACE FUNCTION public.notify_admin_new_contractor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net'
AS $function$
DECLARE
  v_service_key  TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status != 'pending_approval' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status != 'pending_approval' THEN
      RETURN NEW;
    END IF;
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.email ILIKE '%otterquote-internal.test%'
     OR NEW.email ILIKE '%pfw-%'
     OR NEW.email ILIKE '%authdoctor%' THEN
    RAISE LOG 'notify_admin_new_contractor: skipping test account id=% email=%', NEW.id, NEW.email;
    RETURN NEW;
  END IF;

  -- gh-752: resolve the service-role key from Vault (proven live by 10 cron
  -- jobs) instead of the app.* GUCs, which are not set on this database.
  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_contractor: vault secret cron_service_role_key not found — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  -- NOTE (found during gh-752 post-apply verification, NOT fixed by this
  -- migration): the `::text::bytea` cast below does not match the installed
  -- net.http_post(url text, body jsonb, params jsonb, headers jsonb,
  -- timeout_milliseconds int) signature -- there is no bytea->jsonb cast, so
  -- this call throws 42883 every time, silently caught by the EXCEPTION
  -- handler below. This bug pre-dates gh-752 (present identically in the
  -- prior GUC-reading body) and is out of scope here. Fast-follow needed:
  -- drop the ::text::bytea cast (pass the jsonb value directly), matching how
  -- apply_referral_commission's notify-payout-pending call already does it.
  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-contractor',
    body    := jsonb_build_object('contractor_id', NEW.id)::text::bytea,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_contractor: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

-- 2 of 2: apply_referral_commission
-- Sections 1-7 (referral lookup, lock, idempotency check, referrer load,
-- commission apply, payout_approval insert, recruit bonus) are byte-identical
-- to the live definition captured 2026-08-17. Only the DECLARE list (drops
-- v_supabase_url) and section 8 (key resolution) change.
CREATE OR REPLACE FUNCTION public.apply_referral_commission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claim_referral_id   UUID;
  v_referral            public.referrals%ROWTYPE;
  v_referrer            public.referral_agents%ROWTYPE;
  v_recruiter           public.referral_agents%ROWTYPE;
  v_referral_approval   UUID;
  v_recruit_approval    UUID;
  v_service_role_key    TEXT;
BEGIN
  -- 1. Locate the referral via the quote's claim.
  SELECT referral_id INTO v_claim_referral_id
    FROM public.claims
    WHERE id = NEW.claim_id;

  IF v_claim_referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 2. Load and lock the referral row.
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = v_claim_referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 3. Idempotency: if commission was already applied, do not re-apply.
  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  -- 4. Load the referrer.
  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 5. Apply the $200 referrer bonus and advance status to 'contract_signed'.
  UPDATE public.referrals
     SET commission_amount = 200,
         job_value         = NEW.total_price,
         status            = CASE
                               WHEN status IN ('job_completed', 'commission_paid')
                                 THEN status
                               ELSE 'contract_signed'
                             END
   WHERE id = v_referral.id;

  -- 6. Insert payout_approval for the referral commission.
  INSERT INTO public.payout_approvals (
    referral_id, payout_type, partner_id, partner_name,
    amount, trigger_event, status, auto_approve_at
  )
  VALUES (
    v_referral.id,
    'commission_referral',
    v_referrer.id,
    TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')),
    200,
    'Fee charged — referral ' || v_referral.id::TEXT || ' (quote ' || NEW.id::TEXT || ')',
    'pending_approval',
    NOW() + INTERVAL '7 days'
  )
  RETURNING id INTO v_referral_approval;

  -- 7. Forward-only recruit bonus per D-142.
  IF v_referrer.recruited_by_id IS NOT NULL
     AND v_referrer.recruited_at IS NOT NULL
     AND v_referral.created_at >= v_referrer.recruited_at THEN

    UPDATE public.referrals
       SET recruit_commission_amount = 50
     WHERE id = v_referral.id;

    UPDATE public.referral_agents
       SET recruit_earnings = COALESCE(recruit_earnings, 0) + 50
     WHERE id = v_referrer.recruited_by_id;

    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    INSERT INTO public.payout_approvals (
      referral_id, payout_type, partner_id, partner_name,
      amount, trigger_event, status, auto_approve_at
    )
    VALUES (
      v_referral.id,
      'commission_recruit',
      v_referrer.recruited_by_id,
      TRIM(COALESCE(v_recruiter.first_name, '') || ' ' || COALESCE(v_recruiter.last_name, '')),
      50,
      'Recruit bonus — referral ' || v_referral.id::TEXT || ' (referrer: ' || TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')) || ')',
      'pending_approval',
      NOW() + INTERVAL '7 days'
    )
    RETURNING id INTO v_recruit_approval;
  END IF;

  -- 8. Fire notify-payout-pending via pg_net (async, fire-and-forget).
  -- gh-752: service-role key now resolved from Vault; the app.* GUCs this
  -- block used to read are not set on this database, which silently skipped
  -- the call. A missing Vault secret is now RAISE LOGged instead of skipped
  -- silently. EXCEPTION handler below still swallows any pg_net failure —
  -- payment integrity is never at risk. Verified live post-apply: the Vault
  -- key is accepted by notify-payout-pending (404 "Approval not found" for a
  -- synthetic ID, not 401).
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

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;
