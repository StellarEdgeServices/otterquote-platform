-- gh-3409: a contractor session cannot insert a forged public.fee_acceptances row (UETA fee-acceptance evidence, D-214 / D-215).
-- STATUS (gh-1438, as of 2026-11-05): NOT APPLIED
-- EVIDENCE: drafted on main e39d091 under #3409 (CTO RUN 96, claim cto-2026-11-05T19:06:47Z, subagent cto96-b3409). Production read-only SELECTs 2026-11-05 (project yeszghaspzwwstvsrioa, nothing written):
--   fee_acceptances: RLS on, not forced; policies admin read / admin UPDATE / contractor INSERT own (WITH CHECK contractor_id only) / contractor read own; NO trigger; 8 rows; anon holds INSERT, SELECT, UPDATE;
--   authenticated holds INSERT, SELECT, UPDATE, DELETE. platform_fee_config: 1 row (fee_pct 5.00, bid_amount). quotes_platform_fee_for(uuid,uuid) exists (gh-2519 applied, ledger 20261015205902), so quotes.platform_fee_pct /
--   fee_percentage / fee_amount are server-set on a client bid. All 8 existing rows pass every rule below (pre-flight check 3): same contractor and claim as their bid, rate and fee equal the bid's, fee text equals the
--   form's text, inserted 0.16 to 1.10 s after the bid, one row per bid.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177 pair or Ben's ruling that none is owed, R-097 24-hour notice, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh3409_fee_acceptances_client_insert_guard_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3409_fee_acceptances_client_insert_guard_pre-flight.md
-- Proof (throwaway Postgres, forged insert refused, real acceptance still works, mutants fail): supabase/tests/gh3409_fee_acceptances_client_insert_guard_proof_run.sh
-- TRANSACTION: this file carries its own BEGIN ... COMMIT and is meant to be run ALONE (`psql -v ON_ERROR_STOP=1 -f`). Never dry-run it by wrapping it in BEGIN ... ROLLBACK: the file's COMMIT ends the wrapper
--   (same hazard, proven for gh-3320 in PR #3406). A plain `psql -f` exits 0 even if the guard below fires (nothing is committed); read pre-flight checks 1 and 2 afterwards.
--
-- THE REAL ACCEPTANCE PATH (read before this file was written). There is NO server-side function that writes fee_acceptances. The only writers are the two bid forms inserting straight from the contractor's
-- browser session (role authenticated, PostgREST): contractor-bid-form.html (~line 5436, new bids only, `if (!changeBidMode)`) and react-app/app/contractor/bid/[claimId]/bid-form.tsx (~line 366, new bids only).
-- Each inserts the contractor's bid (quotes) first, then, a fraction of a second later, one fee_acceptances row naming that bid. The two forms send DIFFERENT disclosure wording (the HTML form "Platform fee for
-- this job: ..."; the React form "By submitting this bid, you agree ... I understand and agree ..."), so both wordings are accepted. service_role (stripe-webhook and get-business-lines-dashboard read it, e2e teardown
-- deletes) and owner-level SECURITY DEFINER code are not client callers and are untouched.
--
-- What this adds: ONE trigger function and ONE BEFORE INSERT trigger on public.fee_acceptances, plus one pure text-check function. It changes no policy, no grant, no column, no row. For a CLIENT caller only
-- (current_user anon or authenticated, JWT role not service_role), an INSERT is now accepted only if ALL hold, else it is refused 42501 and nothing is written:
--   1. contractor_id is the caller's own contractor row (the policy's own test, repeated because a BEFORE trigger runs first);
--   2. bid_id is one of the caller's own bids, on the claim named by claim_id (read through the caller's own quotes RLS, so another contractor's bid is invisible and refused);
--   3. that bid is still status 'submitted' and bid_status 'active' and was created within the last 15 minutes (the forms insert within seconds; a late or backdated acceptance for an old, selected or declined bid is refused);
--   4. that bid has no fee_acceptances row yet (one acceptance per bid: a second, newer forged row can no longer outrank the genuine one in stripe-webhook's `order by created_at desc limit 1`);
--   5. fee_text_displayed is exactly one of the two forms' disclosure texts, and the rate and dollar fee printed in it equal the bid's stored rate and fee (to a cent, because the browser formats a float and the
--      server rounds half up), and in the React wording the net amount equals the bid total minus the fee (to two cents).
-- And, rather than refusing, the server WRITES these columns on a client insert, so what the browser sent in them no longer matters and the real forms keep working unchanged:
--   fee_pct, fee_basis and fee_amount from the bid (quotes.platform_fee_pct else fee_percentage; platform_fee_basis else 'bid_amount'; fee_amount); created_at = now(); invoice_url, rescinded_at and
--   rescission_reason = NULL (nothing writes them today; a client-set rescinded_at would hide the genuine row from the webhook's `rescinded_at IS NULL`); accepted_at is kept if within 15 minutes before to 5 minutes
--   after now(), otherwise set to now() (a wrong device clock must not lose the evidence row).
-- NOT changed, stated plainly: ip_address and user_agent are what the browser reports and cannot be verified on the server; a contractor can still choose them. id is client-chosen (harmless). The bid's own
--   price and fee are the bid form's and gh-2519's business (gh-2519 sets them server-side on a client bid; this file RELIES ON gh-2519 being applied and refuses to run without it).
-- WORDING DRIFT, a deliberate coupling: the accepted texts are written into public.fee_acceptance_text_matches() from the two forms. If Legal changes either form's disclosure, that function must change in the same
--   release or a client insert of the new wording is refused (the forms treat a failed insert as non-fatal and report it to Sentry, so evidence capture would silently stop). The runner renders the texts FROM THE
--   FORM SOURCE FILES and inserts them, so a wording change in a form turns the proof red before it reaches production. No wording is changed here (Tier C stays with Legal).
-- ORDER WITH PR #3406 (gh-3320, UPDATE/DELETE revoke + admin UPDATE policy drop): independent. This file touches only the INSERT path (a trigger and two functions); #3406 touches only UPDATE/DELETE grants and one
--   UPDATE policy. Neither file reads or writes what the other changes. Recommended order: #3406 first (smaller, already reviewed), then this file; the runner proves both orders and independent rollback.

BEGIN;

-- Prerequisites: refuse rather than guess. gh-2519 must be applied (quotes fee columns are server-set); the columns this reads must exist.
DO $prereq$
BEGIN
  IF to_regclass('public.fee_acceptances') IS NULL OR to_regclass('public.quotes') IS NULL OR to_regclass('public.contractors') IS NULL THEN
    RAISE EXCEPTION 'gh3409: public.fee_acceptances, public.quotes and public.contractors must exist';
  END IF;
  IF to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh3409: gh-2519 (quotes_platform_fee_for) is not applied; a client bid''s fee would not be server-set, so it cannot anchor an acceptance';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'quotes'
        AND column_name IN ('contractor_id','claim_id','status','bid_status','created_at','platform_fee_pct','fee_percentage','platform_fee_basis','fee_amount','total_price')) <> 10 THEN
    RAISE EXCEPTION 'gh3409: public.quotes lacks a column this reads';
  END IF;
END
$prereq$;

-- Pure check of the two disclosure texts. Not SECURITY DEFINER, reads no table.
CREATE OR REPLACE FUNCTION public.fee_acceptance_text_matches(p_text text, p_pct numeric, p_fee numeric, p_total numeric)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $txt$
DECLARE
  a text[];
  b text[];
BEGIN
  IF p_text IS NULL OR p_pct IS NULL OR p_fee IS NULL THEN RETURN false; END IF;
  -- contractor-bid-form.html generateExactFeeText() (GC-approved verbatim, #547 item 1A)
  a := regexp_match(p_text, '^Platform fee for this job: \$([0-9,]+\.[0-9]{2}) \(([0-9]+\.[0-9]{2})% of your bid\)\. By submitting this bid, you agree to pay Otter Quotes this fee if the homeowner selects your bid and a contract is signed\. The fee is due upon contract execution and will be charged to your card on file\. Submitting this bid constitutes your acceptance of this fee\.$');
  IF a IS NOT NULL THEN
    RETURN abs(replace(a[1], ',', '')::numeric - p_fee) <= 0.01 AND a[2]::numeric = round(p_pct, 2);
  END IF;
  -- react-app contractor/bid/[claimId]/copy.ts buildFeeDisclosureText()
  b := regexp_match(p_text, '^By submitting this bid, you agree to pay Otter Quotes a platform fee of ([0-9]+\.[0-9]{2})% \(\$([0-9,]+\.[0-9]{2})\) upon contract execution\. This fee is deducted from your bid amount before disbursement\. You will receive \$([0-9,]+\.[0-9]{2}) upon completion\. I understand and agree to the platform fee of ([0-9]+\.[0-9]{2})% \(\$([0-9,]+\.[0-9]{2})\)$');
  IF b IS NOT NULL THEN
    RETURN b[1]::numeric = round(p_pct, 2) AND b[4]::numeric = round(p_pct, 2)
       AND b[2] = b[5]
       AND abs(replace(b[2], ',', '')::numeric - p_fee) <= 0.01
       AND (p_total IS NULL OR abs(replace(b[3], ',', '')::numeric - (p_total - p_fee)) <= 0.02);
  END IF;
  RETURN false;
END
$txt$;

COMMENT ON FUNCTION public.fee_acceptance_text_matches(text, numeric, numeric, numeric) IS
  'gh-3409: true only when p_text is exactly the HTML bid form''s or the React bid form''s fee disclosure and the rate and dollar fee printed in it equal p_pct and p_fee (one cent) and, in the React wording, the net equals p_total - p_fee (two cents). Update together with either form''s wording.';

CREATE OR REPLACE FUNCTION public.fee_acceptances_guard_client_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
  q public.quotes%ROWTYPE;
BEGIN
  -- Only client callers are bound. service_role (Edge Functions, e2e teardown), postgres and owner-level SECURITY DEFINER code are not.
  IF NOT (current_user IN ('anon', 'authenticated') AND COALESCE(auth.role(), '') <> 'service_role') THEN
    RETURN NEW;
  END IF;

  -- 1. the caller's own contractor row
  IF NOT COALESCE(EXISTS (SELECT 1 FROM public.contractors k WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
    RAISE EXCEPTION 'fee_acceptances: an acceptance can only be recorded by the contractor it names (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- 2. the caller's own bid, on the named claim (the quotes read policy shows the caller only its own bids)
  SELECT * INTO q FROM public.quotes WHERE id = NEW.bid_id AND contractor_id = NEW.contractor_id AND claim_id = NEW.claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fee_acceptances: bid_id must be this contractor''s own bid on claim_id (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- 3. a bid that has just been submitted and is still open
  IF q.status IS DISTINCT FROM 'submitted' OR q.bid_status IS DISTINCT FROM 'active'
     OR q.created_at IS NULL OR q.created_at < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'fee_acceptances: an acceptance is recorded when the bid is submitted, not later or for a bid that is no longer open (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- 4. one acceptance per bid
  IF EXISTS (SELECT 1 FROM public.fee_acceptances x WHERE x.bid_id = NEW.bid_id) THEN
    RAISE EXCEPTION 'fee_acceptances: this bid already has its acceptance record (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- server-written values from the bid (gh-2519 set them on the bid)
  NEW.fee_pct    := COALESCE(q.platform_fee_pct, q.fee_percentage);
  NEW.fee_basis  := COALESCE(q.platform_fee_basis, 'bid_amount');
  NEW.fee_amount := q.fee_amount;
  IF NEW.fee_pct IS NULL OR NEW.fee_amount IS NULL THEN
    RAISE EXCEPTION 'fee_acceptances: the bid carries no fee to accept (gh-3409)' USING ERRCODE = '42501';
  END IF;

  -- 5. the disclosure the contractor saw must be one of the two forms' texts, stating this fee
  IF NOT public.fee_acceptance_text_matches(NEW.fee_text_displayed, NEW.fee_pct, NEW.fee_amount, q.total_price) THEN
    RAISE EXCEPTION 'fee_acceptances: fee_text_displayed is not the bid form''s disclosure for this bid''s fee (gh-3409)' USING ERRCODE = '42501';
  END IF;

  NEW.created_at       := now();
  NEW.invoice_url      := NULL;
  NEW.rescinded_at     := NULL;
  NEW.rescission_reason := NULL;
  IF NEW.accepted_at IS NULL OR NEW.accepted_at < now() - interval '15 minutes' OR NEW.accepted_at > now() + interval '5 minutes' THEN
    NEW.accepted_at := now();
  END IF;
  RETURN NEW;
END
$guard$;

COMMENT ON FUNCTION public.fee_acceptances_guard_client_insert() IS
  'gh-3409: BEFORE INSERT guard on public.fee_acceptances for client roles. See supabase/migrations_drafts/gh3409_fee_acceptances_client_insert_guard.sql.';

DROP TRIGGER IF EXISTS fee_acceptances_guard_client_insert ON public.fee_acceptances;
CREATE TRIGGER fee_acceptances_guard_client_insert
  BEFORE INSERT ON public.fee_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.fee_acceptances_guard_client_insert();

-- GUARD: the trigger exists, is enabled for every session role (tgenabled 'O'), and is the only non-internal trigger on the table. Else raise and roll the whole file back.
DO $final$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal
     AND tgname = 'fee_acceptances_guard_client_insert' AND tgenabled = 'O' AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 4) = 4;
  IF n <> 1 THEN
    RAISE EXCEPTION 'gh3409: guard trigger missing, disabled or not BEFORE INSERT FOR EACH ROW; nothing is applied';
  END IF;
END
$final$;

COMMIT;
