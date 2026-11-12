-- STATUS (gh-1438, as of 2026-11-09): NOT APPLIED
-- FILE ROLE: forward file of set gh3560_renew_quote_rpc (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-09 under #3560 (CTO ruling, comment 6740503022; Dustin: "burn it on code" on the bid/money path). Production was read by SELECT only on 2026-11-09 (project yeszghaspzwwstvsrioa): quotes_guard_homeowner_columns() prosrc md5 d2aeffb8 (first 8 hex), whose client branch opens with current_user IN ('anon','authenticated') (position 756) and carries the gh-2564 lock (position 6817); quotes_bid_status_check admits active, expired, superseded, cancelled; quotes_status_check admits draft, submitted, selected, declined, expired; contractors.user_id uuid and quotes.expired_at / expires_at / updated_at timestamptz exist; quotes.renewals_count does not exist; public.renew_quote does not exist; contractor_can_bid(uuid) is SECURITY DEFINER, returns boolean (status active, coi_file_url set, coi_expires_at > CURRENT_DATE, attestation_accepted_at set); rescind-bid (a contractor's own withdrawal) does not set quotes.cancelled_at, while switch-contractor (index.ts L367) and the v48 backfill do. Proof: supabase/tests/gh3560_renew_quote_proof.sql (run on production inside BEGIN ... ROLLBACK only; output in the PR body).
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3560_renew_quote_rpc
-- GitHub: #3560. Tier: 3B (new SECURITY DEFINER function reachable by authenticated users that writes public.quotes.bid_status). R-097 24-hour notice before apply.
-- Rollback: supabase/migrations_drafts/gh3560_renew_quote_rpc_rollback.sql
--
-- Why. Renew Bid (an expired bid, D-150) and Change Bid on a bid the contractor withdrew (bid_status 'cancelled', the
-- gh-2564 rescind-and-re-bid path) both have to set bid_status, expired_at and expires_at. quotes_guard_homeowner_columns()
-- (gh-2519 residual 3 allow-list) refuses those three columns to a signed-in contractor with 42501, so the whole bid-form
-- save fails. supabase/migrations_rollbacks/gh2519_quotes_server_set_fee_pre-flight.md (finding 2) already says renewal
-- "should go through service_role"; supabase/tests/gh2519_gh2564_fee_lock_proof.sql C5 tests the refusal. This function is
-- that server-side path. The allow-list is NOT widened: the guard still refuses a direct client write of the three columns.
--
-- What it does. renew_quote(p_quote_id, p_mode) sets EXACTLY bid_status = 'active', expired_at = NULL,
-- expires_at = now() + 14 days (D-150 window) and updated_at = now(), on one quote, and nothing else:
--   p_mode 'renew'  requires bid_status = 'expired'    (Renew Bid)
--   p_mode 'reopen' requires bid_status = 'cancelled'  (Change Bid on a withdrawn bid)
-- Gates, each reproduced from existing code rather than invented:
--   * caller = auth.uid(); NULL (anon, no JWT) is refused 42501.
--   * the quote's contractor row has user_id = auth.uid() (the guard's v_is_contractor test); a missing quote and another
--     contractor's quote give the same 42501, so the function does not say which quote ids exist.
--   * D-170 eligibility: public.contractor_can_bid(contractor_id) must be true (status active, current COI, attestation accepted),
--     the same test the INSERT policy "Contractors can insert quotes" applies to a new bid. Reviving a bid is re-submitting it, and
--     every page gate runs in the browser, so the function enforces it. Refused 42501 (gh3560 review B2).
--   * reopen only a bid the contractor withdrew: cancelled_at must be NULL. rescind-bid (the contractor's own withdrawal) writes
--     bid_status only; switch-contractor and the v48 backfill (admin or homeowner-side removal) also stamp cancelled_at, and
--     sql/v48-bid-expiration.sql defines 'cancelled' as covering both. A removed bid stays dead. Refused 55000 (review N2).
--   * not after selection or award: quote status selected or awarded, or claim status awarded or contract_signed, is
--     refused 55000 (the rescind-bid refusal, supabase/functions/rescind-bid/status.ts isBidSelectedOrAwarded, and
--     process-bid-expirations EXEMPT_CLAIM_STATUSES; D-369 / D-381 freeze a selected bid and the way out is rescind and re-bid).
--   * the quote's status must be 'submitted' (a declined, expired-status or draft quote is not a bid that can go live; accept_bid()
--     admits declined, so reviving one would make it awardable). Refused 55000.
--   * the quote row is locked FOR UPDATE, so a concurrent accept_bid() / selection cannot interleave between the checks and the write.
-- Refusals: 42501 not signed in / not your quote; 22023 unknown p_mode; 55000 wrong state for the mode, or selected / awarded, or status not submitted.
--
-- Why the trigger lets it through. quotes_guard_homeowner_columns() and the other client-facing quote triggers run their checks only
-- when current_user IN ('anon','authenticated'). Inside this SECURITY DEFINER function current_user is the function owner
-- (postgres), so the guard falls through, as it does for accept_bid(). Because the guard is then not the barrier, every rule above
-- is enforced in this function. Triggers that still run: quotes_normalize_fee_amount (recomputes fee_amount from platform_fee_pct and
-- total_price; a no-op on a consistent row) and set_updated_at_quotes.
--
-- What does not change: no price, fee, consent or customer-visible wording; no table, column, policy or trigger; the guard function is untouched.
-- Idempotent: CREATE OR REPLACE FUNCTION and re-runnable grants.
BEGIN;

CREATE OR REPLACE FUNCTION public.renew_quote(p_quote_id uuid, p_mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_uid          uuid := auth.uid();
  v_contractor   uuid;
  v_status       text;
  v_bid_status   text;
  v_claim_id     uuid;
  v_claim_status text;
  v_need         text;
  v_cancelled_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'renew_quote: sign in to renew a bid' USING ERRCODE = '42501';
  END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('renew', 'reopen') THEN
    RAISE EXCEPTION 'renew_quote: p_mode must be renew or reopen' USING ERRCODE = '22023';
  END IF;
  v_need := CASE p_mode WHEN 'renew' THEN 'expired' ELSE 'cancelled' END;

  SELECT q.contractor_id, q.status, q.bid_status, q.claim_id, q.cancelled_at
    INTO v_contractor, v_status, v_bid_status, v_claim_id, v_cancelled_at
    FROM public.quotes q
   WHERE q.id = p_quote_id
     AND EXISTS (SELECT 1 FROM public.contractors k
                  WHERE k.id = q.contractor_id AND k.user_id = v_uid)
   FOR UPDATE OF q;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'renew_quote: this bid is not yours or does not exist' USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(public.contractor_can_bid(v_contractor), false) THEN
    RAISE EXCEPTION 'renew_quote: your account is not eligible to bid (status, insurance certificate or attestation); a bid cannot be renewed (D-170)' USING ERRCODE = '42501';
  END IF;

  SELECT c.status INTO v_claim_status FROM public.claims c WHERE c.id = v_claim_id;

  IF v_status IN ('selected', 'awarded') OR v_claim_status IN ('awarded', 'contract_signed') THEN
    RAISE EXCEPTION 'renew_quote: a bid the homeowner has chosen, or on an awarded claim, cannot be renewed (gh-2564)' USING ERRCODE = '55000';
  END IF;

  IF v_status IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'renew_quote: only a submitted bid can be renewed' USING ERRCODE = '55000';
  END IF;

  IF v_bid_status IS DISTINCT FROM v_need THEN
    RAISE EXCEPTION 'renew_quote: mode % needs a % bid', p_mode, v_need USING ERRCODE = '55000';
  END IF;

  IF p_mode = 'reopen' AND v_cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'renew_quote: a bid removed by the platform or by a contractor switch cannot be reopened' USING ERRCODE = '55000';
  END IF;

  UPDATE public.quotes
     SET bid_status = 'active',
         expired_at = NULL,
         expires_at = now() + interval '14 days',
         updated_at = now()
   WHERE id = p_quote_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.renew_quote(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.renew_quote(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.renew_quote(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.renew_quote(uuid, text) IS
  'gh-3560: the only browser path that sets bid_status active again. A contractor renews an expired bid (p_mode renew) or reopens a withdrawn one (p_mode reopen): bid_status active, expired_at null, expires_at now()+14 days, updated_at now(), nothing else. Refused 42501 (not signed in, not the quote''s contractor, contractor not eligible to bid per contractor_can_bid), 22023 (mode), 55000 (wrong bid_status for the mode, quote selected or awarded, claim awarded or contract_signed, quote status not submitted, reopen of a bid with cancelled_at set).';

COMMIT;
