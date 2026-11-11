-- STATUS (gh-1438, as of 2026-11-09T13:40:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3490_fee_acceptance_duplicate_same_fee (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-09 under #3490. Restores the production body read 2026-11-09 (gh3409, ledger 20261106215945, prosrc md5 prefix 1142fe98), byte for byte. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3490_fee_acceptance_duplicate_same_fee: puts back the gh3409 duplicate rule (ANY existing row for the bid_id makes a new client row a duplicate_bid diversion).
-- Rows recorded while the forward was live (a second row for a bid at a different fee) are KEPT; this file changes no row. After rollback, a changed or renewed bid's acceptance is quarantined again.
-- Refuses unless the live body is the gh3490 body (3ff983cb) or already the gh3409 body (1142fe98, idempotent). Run ALONE: `psql -v ON_ERROR_STOP=1 -f`.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE live text;
BEGIN
  SELECT p.prosrc INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.fee_acceptances_guard_client_insert()');
  IF live IS NULL OR left(md5(live), 8) NOT IN ('3ff983cb', '1142fe98') THEN
    RAISE EXCEPTION 'gh3490 rollback: the live guard body (md5 prefix %) is neither the gh3490 body nor the gh3409 body; re-diff before rolling back', coalesce(left(md5(live), 8), 'absent');
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fee_acceptances_guard_client_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
  q record;
  v_pct numeric;
  v_amt numeric;
  v_chk text;
  v_reasons text[] := '{}';
BEGIN
  -- Only client callers are bound. service_role (Edge Functions, e2e teardown), postgres and owner-level SECURITY DEFINER code are not.
  IF NOT (current_user IN ('anon', 'authenticated') AND COALESCE(auth.role(), '') <> 'service_role') THEN
    RETURN NEW;
  END IF;

  -- A. refuse what no genuine form insert can be
  IF NOT COALESCE(EXISTS (SELECT 1 FROM public.contractors k WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
    RAISE EXCEPTION 'fee_acceptances: an acceptance can only be recorded by the contractor it names (gh-3409)' USING ERRCODE = '42501';
  END IF;
  SELECT x.id, x.total_price, x.platform_fee_pct, x.fee_percentage, x.platform_fee_basis, x.fee_amount INTO q
    FROM public.quotes x WHERE x.id = NEW.bid_id AND x.contractor_id = NEW.contractor_id AND x.claim_id = NEW.claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fee_acceptances: bid_id must be this contractor''s own bid on claim_id (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- B / C. decide whether this is a true record of this bid
  v_pct := COALESCE(q.platform_fee_pct, q.fee_percentage);
  v_amt := q.fee_amount;
  IF v_pct IS NULL OR v_amt IS NULL THEN
    v_reasons := array_append(v_reasons, 'bid_has_no_fee');
  ELSE
    v_chk := public.fee_acceptance_text_check(NEW.fee_text_displayed, v_pct, v_amt, q.total_price);
    IF v_chk <> 'ok' THEN v_reasons := array_append(v_reasons, v_chk); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fee_acceptances d WHERE d.bid_id = NEW.bid_id) THEN
    v_reasons := array_append(v_reasons, 'duplicate_bid');
  END IF;

  IF cardinality(v_reasons) > 0 THEN
    -- the row exactly as the browser sent it (before any server-side change below). The log line is a second copy that survives even if the caller's request is rolled back afterwards.
    PERFORM public.fee_acceptance_quarantine_add(NEW, v_reasons, v_pct, v_amt);
    RAISE WARNING 'gh-3409 fee acceptance quarantined: bid % reasons % server fee % shown %', NEW.bid_id, v_reasons, v_amt, left(format('%L', NEW.fee_text_displayed), 700);
    RETURN NULL;
  END IF;

  NEW.created_at        := now();
  NEW.invoice_url       := NULL;
  NEW.rescinded_at      := NULL;
  NEW.rescission_reason := NULL;
  IF NEW.accepted_at IS NULL OR NEW.accepted_at < now() - interval '15 minutes' OR NEW.accepted_at > now() + interval '5 minutes' THEN
    NEW.accepted_at := now();
  END IF;

  NEW.fee_pct    := v_pct;
  NEW.fee_basis  := COALESCE(q.platform_fee_basis, 'bid_amount');
  NEW.fee_amount := v_amt;
  RETURN NEW;
END
$guard$;

DO $post$
DECLARE live text;
BEGIN
  SELECT p.prosrc INTO live FROM pg_proc p WHERE p.oid = 'public.fee_acceptances_guard_client_insert()'::regprocedure;
  IF left(md5(live), 8) <> '1142fe98' OR md5(live) IS DISTINCT FROM md5($old$
DECLARE
  q record;
  v_pct numeric;
  v_amt numeric;
  v_chk text;
  v_reasons text[] := '{}';
BEGIN
  -- Only client callers are bound. service_role (Edge Functions, e2e teardown), postgres and owner-level SECURITY DEFINER code are not.
  IF NOT (current_user IN ('anon', 'authenticated') AND COALESCE(auth.role(), '') <> 'service_role') THEN
    RETURN NEW;
  END IF;

  -- A. refuse what no genuine form insert can be
  IF NOT COALESCE(EXISTS (SELECT 1 FROM public.contractors k WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
    RAISE EXCEPTION 'fee_acceptances: an acceptance can only be recorded by the contractor it names (gh-3409)' USING ERRCODE = '42501';
  END IF;
  SELECT x.id, x.total_price, x.platform_fee_pct, x.fee_percentage, x.platform_fee_basis, x.fee_amount INTO q
    FROM public.quotes x WHERE x.id = NEW.bid_id AND x.contractor_id = NEW.contractor_id AND x.claim_id = NEW.claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fee_acceptances: bid_id must be this contractor''s own bid on claim_id (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- B / C. decide whether this is a true record of this bid
  v_pct := COALESCE(q.platform_fee_pct, q.fee_percentage);
  v_amt := q.fee_amount;
  IF v_pct IS NULL OR v_amt IS NULL THEN
    v_reasons := array_append(v_reasons, 'bid_has_no_fee');
  ELSE
    v_chk := public.fee_acceptance_text_check(NEW.fee_text_displayed, v_pct, v_amt, q.total_price);
    IF v_chk <> 'ok' THEN v_reasons := array_append(v_reasons, v_chk); END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.fee_acceptances d WHERE d.bid_id = NEW.bid_id) THEN
    v_reasons := array_append(v_reasons, 'duplicate_bid');
  END IF;

  IF cardinality(v_reasons) > 0 THEN
    -- the row exactly as the browser sent it (before any server-side change below). The log line is a second copy that survives even if the caller's request is rolled back afterwards.
    PERFORM public.fee_acceptance_quarantine_add(NEW, v_reasons, v_pct, v_amt);
    RAISE WARNING 'gh-3409 fee acceptance quarantined: bid % reasons % server fee % shown %', NEW.bid_id, v_reasons, v_amt, left(format('%L', NEW.fee_text_displayed), 700);
    RETURN NULL;
  END IF;

  NEW.created_at        := now();
  NEW.invoice_url       := NULL;
  NEW.rescinded_at      := NULL;
  NEW.rescission_reason := NULL;
  IF NEW.accepted_at IS NULL OR NEW.accepted_at < now() - interval '15 minutes' OR NEW.accepted_at > now() + interval '5 minutes' THEN
    NEW.accepted_at := now();
  END IF;

  NEW.fee_pct    := v_pct;
  NEW.fee_basis  := COALESCE(q.platform_fee_basis, 'bid_amount');
  NEW.fee_amount := v_amt;
  RETURN NEW;
END
$old$) THEN
    RAISE EXCEPTION 'gh3490 rollback: restored body is not the gh3409 body; nothing is applied';
  END IF;
END
$post$;

COMMIT;
