-- gh-1438 reconciliation (cto61, 2026-10-06T19:47:53Z): renamed from 20261003193000_gh2479_referral_guard_and_commission_checks.sql to the REAL applied ledger version.
-- Ledger row: supabase_migrations.schema_migrations version=20261005151842 (SELECT-only read 2026-10-06). Content check: live prosrc md5 5cd19c8b (apply_referral_commission) = file body; claims_guard_referral_columns later replaced by 20261005203540.
-- Executable SQL body unchanged; only the filename version prefix and this banner changed.
-- Migration: 20261003193000_gh2479_referral_guard_and_commission_checks
-- GitHub: #2479 (MONEY, SECURITY), ruling on #2403 comment 5972625589 (Dustin, 2026-10-03: "a: section 9 covers it").
-- Tier: 3B (new trigger on claims + replaces a money-path trigger function). Protective only (R-134): it only removes capability.
-- NOT APPLIED by the authoring session or by CI. R-097 notice applies. Needs LEGAL-READ and the CEO's `R-177 SIGNED:` before merge.
-- Rollback: supabase/migrations_rollbacks/20261003193000_gh2479_referral_guard_and_commission_checks_rollback.sql
-- Proof (rolled-back, is_test rows only): supabase/tests/gh2479_referral_guard_proof.sql
--
-- Problem (proven on production by CTO RUN 57, #2479 comment 5969752407): a signed-in claim owner can
-- UPDATE claims.referral_id (any referral, any age) and claims.completion_date through the public API
-- ("Users can update own claims", UPDATE held by anon/authenticated on both columns). That fires
-- after_claim_completed -> apply_referral_commission(), which accrued $200 with no window, status or
-- is_test check; the same claim accrued a second $200 after swapping to another referral.
--
-- APPLY ORDER (read this first): apply #2476 (migration 20261003141000, issue #2472, the `referrals` INSERT
--    policy lockdown; merged, NOT yet applied as of 2026-10-03) FIRST, or in the same sitting immediately
--    before this file. Until #2476 is applied the live `referrals` INSERT policy is WITH CHECK (true) and
--    anon/authenticated hold INSERT, so a client can insert a referral row that is already `claim_submitted`
--    with any created_at: checks (b) status and (c) window below are then forgeable through a client-inserted
--    referral row. #2476's timestamp sorts before this file's, so a normal ordered apply is already correct;
--    a hand apply must keep that order. This migration does not depend on #2476 to run, only to be effective.
--
-- 1. BEFORE INSERT OR UPDATE guard on public.claims (invoker; client roles anon/authenticated that are not
--    admins and not service_role):
--    - UPDATE: referral_id, completion_date and created_at cannot CHANGE (NEW.x IS DISTINCT FROM OLD.x).
--      Re-sending the stored value is not a change and succeeds, so a client save whose payload carries an
--      unchanged referral_id still lands (proof N1). A real change is rejected 42501 (loud, unlike the silent
--      reset in gh-2421's guard, so a probe sees the rejection). service_role, admins and owner-level
--      sessions are untouched.
--    - INSERT: created_at is forced to now() (server time). trade-selector sends created_at from the browser
--      clock on INSERT (trade-selector.html ~L1468); that value is discarded for client roles.
--    ANCHOR: the attribution window is anchored on claims.created_at. For client callers it is now written
--    only by the server (DEFAULT now() / forced to now() on INSERT) and is frozen on UPDATE, so the client
--    cannot move it. It is the moment the claim row (and, via the claim INSERT or the guarded referral_id
--    stamp, its attribution) came into existence, which is what Dustin's ruling on #2403 means by "measured
--    at attribution" (the window is never now() - 30d at completion). Residual: for a claim created WITHOUT a
--    referral_id and attributed later, the later stamp is a referral_id change; see QUESTIONS on PR #2502.
--    OPEN QUESTION (not decided here): the existing-claim UPDATE branch of trade-selector.html (~L1446-1451)
--    and react-app/app/trade-selector/page.tsx (~L999-1004) sends referral_id from the cookie on an UPDATE of
--    the latest claim. When that value differs from the stored one (NULL -> id, or id -> newer id) it is a
--    real CHANGE, so this guard rejects the whole row write for the signed-in user. That path is the very
--    hole the guard closes (a client re-pointing its own claim at any referral), so it is NOT allowed here.
--    Recommended design (separate PR, needs Dustin/CEO as an attribution rule): server-side attribution, e.g.
--    a SECURITY DEFINER RPC that stamps referral_id once (only when NULL, only for a referral still inside
--    the window at that moment) and the clients drop referral_id from the UPDATE payload.
--    The legitimate writers: completion_date is written by the mark-job-complete Edge Function with the
--    service-role client (supabase/functions/mark-job-complete/index.ts ~L377); referral_id is stamped by the
--    claim INSERT in trade-selector (INSERT is not rejected). No SQL function in the live public schema
--    updates claims.referral_id or claims.completion_date (pg_proc scan, 2026-10-03).
--    SECURITY INVOKER on purpose: current_user must be the caller.
--    A column REVOKE was not used: claims carries table-level UPDATE for anon/authenticated, so a column
--    REVOKE would mean revoking the table grant and re-granting every other column.
--
-- 2. apply_referral_commission(): three checks before any write (is_test agreement, referral status in
--    claim_submitted/bid_received/contract_signed, and the 30-day attribution window measured at claim
--    creation (claims.created_at, client-frozen by the guard above): referral.created_at >= claims.created_at - referral_attribution_window(), never
--    now() - 30d at completion). The payout_approvals rows now carry the claim's is_test (they took the
--    column default false before). The rest of the function is the live body, byte for byte
--    (pg_get_functiondef read from production 2026-10-03).
--
-- Recovery path (review finding 4 on PR #2502). Check (b) means a referral still `clicked`/`registered` (a
--    swallowed claims_advance_referral failure, which logs and never breaks the claim write) or already
--    `job_completed` accrues nothing. This is accepted, not widened, because the failure direction is "no
--    money moves" (a missed payout is recoverable, a wrong payout is not), every skip writes a RAISE LOG
--    line `apply_referral_commission: gh-2479 referral status ...` for a human to see, and a repair needs no
--    new code: service_role or an admin (a) confirms in the DB that referral.created_at >= claims.created_at -
--    referral_attribution_window(), (b) sets that referral's status to 'claim_submitted', then (c) sets the
--    claim's completion_date to NULL and back to a timestamp (after_claim_completed fires on NULL -> NOT NULL;
--    the guard exempts both callers), and the function accrues once through the normal path with all three
--    checks. Eligibility is not widened: the status list and window are unchanged.
--
-- Not in this migration (named in #2479 comment 5969752407, not in the ruling): referrals.claim_id
-- binding, the swallowed recruit-bonus guard failure, and revoking anon UPDATE/DELETE/TRUNCATE on claims.
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP TRIGGER IF EXISTS before CREATE TRIGGER. No GRANT or
-- REVOKE: no new grant to any role.

BEGIN;

CREATE OR REPLACE FUNCTION public.claims_guard_referral_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    IF TG_OP = 'INSERT' THEN
      -- the window anchor is server time, never a browser-supplied value
      NEW.created_at := now();
    ELSIF COALESCE(
         (NEW.referral_id IS DISTINCT FROM OLD.referral_id)
         OR (NEW.completion_date IS DISTINCT FROM OLD.completion_date)
         OR (NEW.created_at IS DISTINCT FROM OLD.created_at),
         true) THEN
      RAISE EXCEPTION 'claims: referral_id, completion_date and created_at can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION public.claims_guard_referral_columns() IS
  'gh-2479: BEFORE INSERT OR UPDATE guard on public.claims. Client roles (anon, authenticated) that are not admins cannot change referral_id, completion_date or created_at on UPDATE (rejected 42501; an unchanged value is not a change) and get created_at = now() on INSERT. service_role, admins and owner-level sessions are untouched.';

DROP TRIGGER IF EXISTS claims_guard_referral_columns ON public.claims;

CREATE TRIGGER claims_guard_referral_columns
  BEFORE INSERT OR UPDATE ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.claims_guard_referral_columns();

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

-- Post-conditions: fail the migration loudly instead of shipping a half-applied guard.
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.claims'::regclass AND tgname = 'claims_guard_referral_columns' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'gh2479: trigger claims_guard_referral_columns is missing after migration';
  END IF;
  IF pg_get_functiondef('public.apply_referral_commission'::regproc) NOT LIKE '%gh-2479%' THEN
    RAISE EXCEPTION 'gh2479: apply_referral_commission does not carry the gh-2479 checks after migration';
  END IF;
END
$post$;

COMMIT;
