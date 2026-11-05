-- gh-3409: a contractor session cannot insert a forged public.fee_acceptances row (UETA fee-acceptance evidence, D-214 / D-215).
-- STATUS (gh-1438, as of 2026-11-05): NOT APPLIED. REVISED at the second head after REVIEW FAIL 6668449870 and LEGAL-READ FAIL 6668344412: a genuine acceptance is never refused or lost; see below.
-- EVIDENCE: drafted on main e39d091 under #3409 (CTO RUN 96, claim cto-2026-11-05T19:06:47Z, subagent cto96-b3409). Production read-only SELECTs 2026-11-05 (project yeszghaspzwwstvsrioa, nothing written):
--   fee_acceptances: RLS on, not forced; policies admin read / admin UPDATE / contractor INSERT own (WITH CHECK contractor_id only) / contractor read own; NO trigger; 8 rows; anon holds INSERT, SELECT, UPDATE;
--   authenticated holds INSERT, SELECT, UPDATE, DELETE. platform_fee_config: 1 row (fee_pct 5.00, bid_amount). quotes_platform_fee_for(uuid,uuid) exists (gh-2519 applied, ledger 20261015205902), so quotes.platform_fee_pct /
--   fee_percentage / fee_amount are server-set on a client bid. All 8 existing rows (all is_test = true, HTML wording) pass every rule below (pre-flight check 3): same contractor and claim as their bid, rate and fee equal the bid's,
--   fee text equals the form's text, one row per bid. They describe TEST acceptances; no real contractor acceptance has been observed.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (review, R-177 pair or Ben's ruling that none is owed, R-097 24-hour notice, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh3409_fee_acceptances_client_insert_guard_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3409_fee_acceptances_client_insert_guard_pre-flight.md
-- Proof (throwaway Postgres, forged insert refused, real acceptance still works, mutants fail): supabase/tests/gh3409_fee_acceptances_client_insert_guard_proof_run.sh
-- TRANSACTION: this file carries its own BEGIN ... COMMIT and is meant to be run ALONE (`psql -v ON_ERROR_STOP=1 -f`). Never dry-run it by wrapping it in BEGIN ... ROLLBACK: the file's COMMIT ends the wrapper
--   (same hazard, proven for gh-3320 in PR #3406). A plain `psql -f` exits 0 even if the guard below fires (nothing is committed); read pre-flight checks 1 and 2 afterwards.
--
-- THE REAL ACCEPTANCE PATH (read before this file was written). There is NO server-side function that writes fee_acceptances. The only writers are the two bid forms inserting straight from the contractor's
-- browser session (role authenticated, PostgREST): contractor-bid-form.html (~5436, new bids only) and react-app/app/contractor/bid/[claimId]/bid-form.tsx (~366, new bids only; it ignores the returned error).
-- Each inserts the contractor's bid (quotes) first, then one fee_acceptances row naming that bid. The two forms send DIFFERENT disclosure wording, so both are recognised. service_role (stripe-webhook and
-- get-business-lines-dashboard read it, e2e teardown deletes) and owner-level SECURITY DEFINER code are not client callers and are untouched.
--
-- DESIGN RULE (Legal read 6668344412, D-214 "the amount displayed", D-215, D-267): this guard never refuses and never drops a genuine acceptance, and no row that is not a true record reaches the table stripe-webhook reads.
-- The two are reconciled by DIVERTING, not refusing. For a CLIENT caller only (current_user anon or authenticated, JWT role not service_role), an INSERT does one of three things:
--   A. REFUSED 42501, only for what no genuine form insert can be: contractor_id that is not the caller's own contractor row, or a bid_id that is not one of the caller's own bids on the claim named by claim_id.
--      (The form inserts the bid first and uses its returned id, so the genuine path always satisfies this. The bid is committed before the acceptance, so a refusal here never refuses a bid.)
--   B. RECORDED in public.fee_acceptances when the disclosure text is exactly one of the two forms' texts, the rate and dollar fee printed in it equal the bid's stored rate and fee (to a cent, because the browser
--      formats a float and the server rounds half up; in the React wording the net equals total minus fee to two cents), and the bid has no acceptance yet. The server writes fee_pct, fee_basis and fee_amount from the
--      bid, created_at = now(), and NULLs invoice_url, rescinded_at and rescission_reason; accepted_at is kept unless the device clock is more than 15 minutes off. Age and status of the bid do NOT matter (a slow
--      IP lookup, a late retry or a bid already selected still records the true values); a bid whose created_at is forged is harmless because nothing depends on it.
--   C. QUARANTINED, otherwise: the whole row exactly as the browser sent it (every column, including its own id, created_at and accepted_at; text capped at 4000 characters), plus the reasons (text_not_form_wording, displayed_fee_differs, duplicate_bid, bid_has_no_fee), the server's rate and fee and the caller,
--      go into public.fee_acceptance_quarantine and NO row is added to fee_acceptances (so stripe-webhook cannot pick it), a WARNING carrying the shown text is logged, and a client that does not demand exactly one row back (next paragraph) sees a normal success. The record of what the contractor
--      was shown is kept for a person to read; which figure stands when the screen and the server disagree is a Tier C decision (question on #3409), not made here.
-- Cases that land in C legitimately: the form's rate lookup differs from the server's (the forms read contractors.state, a column production does not have, the server reads address_state, so the first state-specific
--   row in platform_fee_config would do it), a rate change while a form is open, an out-of-order fee refresh on a keystroke, and any wording change not yet mirrored here. Every one is KEPT, none lost.
-- SHIP ORDER, READ THIS (REVIEW 6669057587 B1, proven against a real PostgREST 12.2.3 and supabase-js in supabase/tests/gh3409_postgrest_proof.mjs): the HTML bid form inserts with `.select('id').single()`, which asks
--   PostgREST for exactly one row. A diverted row returns zero rows, so PostgREST answers 406 PGRST116 and ROLLS THE WHOLE REQUEST BACK, taking the quarantine row with it: the record of what was shown is lost
--   (only the log line below survives). contractor-bid-form.html in this PR drops `.single()` (it keeps `.select('id')`) and treats an empty result as a diversion to report. THAT FORM CHANGE MUST BE LIVE BEFORE
--   THIS MIGRATION IS APPLIED (pre-flight check 0 reads the deployed page). The React form sends no returning clause and is unaffected. Any other client that uses `.single()` on this insert would lose the quarantine row.
-- Quarantine table: RLS on, no policy, no privilege for anon or authenticated (service_role and the SQL editor only). It is written by one SECURITY DEFINER function that refuses to run outside a trigger.
--
-- STILL OPEN IN THE DATA PATH, and fixed in the webhook, not here (REVIEW 6668449870 B1): a contractor can submit a second bid, or move a bid's price down and back, and each acceptance row is true at its own
--   instant, so "the newest row for claim and contractor" can name the wrong bid or a superseded price. supabase/functions/stripe-webhook now reads the acceptance of the SELECTED bid (bid_id) and treats a row whose
--   fee differs from that bid's current fee as not-evidence (manual evidence gathering). That is a code change, deployed through the normal Edge Function path; this file does not need it to be safe, and it does
--   not rely on this file.
-- NOT changed, stated plainly: ip_address and user_agent are what the browser reports and cannot be verified on the server. id is client-chosen (harmless). The bid's own price and fee are the bid form's and
--   gh-2519's business (gh-2519 sets them server-side; this file RELIES ON gh-2519 being applied and refuses to run without it). The React form's sentence "deducted from your bid amount ... You will receive $X"
--   is recognised as the React form's own wording because it is on main; Legal's note that it sits badly with D-226 is a wording question for Legal (Tier C) and is not decided here.
-- WORDING DRIFT, a deliberate coupling: the recognised texts live in public.fee_acceptance_text_check(). A new wording is quarantined (kept, not lost) until that function is updated in the same release. The runner
--   renders the texts from the two form source files; supabase/tests/gh3409_*.mjs and the runner should be run in CI (no workflow is added here; the runner is run by hand until a Postgres-service job exists).
-- ORDER WITH PR #3406 (gh-3320, UPDATE/DELETE revoke + admin UPDATE policy drop): independent. This file touches only the INSERT path (a trigger, three functions, one new table); #3406 touches only UPDATE/DELETE
--   grants and one UPDATE policy on fee_acceptances. Recommended order: #3406 first, then this file; the runner proves both orders and independent rollback.

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

-- Where a diverted row is kept. Append-only in intent; no client privilege of any kind.
CREATE TABLE IF NOT EXISTS public.fee_acceptance_quarantine (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  quarantined_at timestamptz DEFAULT now() NOT NULL,
  reasons text[] NOT NULL,
  caller_user_id uuid,
  server_fee_pct numeric(5,2),
  server_fee_amount numeric(12,2),
  -- the row exactly as the browser sent it (text and user agent capped at 4000 and 500 characters; fee_text_length is the original length)
  client_row_id uuid,
  client_created_at timestamptz,
  contractor_id uuid,
  claim_id uuid,
  bid_id uuid,
  fee_pct numeric(5,2),
  fee_basis text,
  fee_amount numeric(10,2),
  fee_text_displayed text,
  fee_text_length integer,
  accepted_at timestamptz,
  ip_address inet,
  user_agent text,
  invoice_url text,
  rescinded_at timestamptz,
  rescission_reason text
);
ALTER TABLE public.fee_acceptance_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fee_acceptance_quarantine FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.fee_acceptance_quarantine TO service_role;
COMMENT ON TABLE public.fee_acceptance_quarantine IS
  'gh-3409: client fee-acceptance inserts that were not recorded in fee_acceptances, kept exactly as the browser sent them with the reasons. Read by a person. Not read by stripe-webhook.';

-- Recognises the two forms' disclosure texts. Returns ok, text_not_form_wording (not exactly either text) or displayed_fee_differs (a form text, but the rate or fee printed in it is not the bid's).
-- Pure, reads no table. Numbers must be written the way the forms write them (no leading zeros, thousands grouped by three).
CREATE OR REPLACE FUNCTION public.fee_acceptance_text_check(p_text text, p_pct numeric, p_fee numeric, p_total numeric)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $txt$
DECLARE
  a text[];
  b text[];
BEGIN
  IF p_text IS NULL THEN RETURN 'text_not_form_wording'; END IF;
  -- contractor-bid-form.html generateExactFeeText() (GC-approved verbatim, #547 item 1A)
  a := regexp_match(p_text, '^Platform fee for this job: \$((?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)\.[0-9]{2}) \(((?:0|[1-9][0-9]{0,2})\.[0-9]{2})% of your bid\)\. By submitting this bid, you agree to pay Otter Quotes this fee if the homeowner selects your bid and a contract is signed\. The fee is due upon contract execution and will be charged to your card on file\. Submitting this bid constitutes your acceptance of this fee\.$');
  IF a IS NOT NULL THEN
    IF p_pct IS NOT NULL AND p_fee IS NOT NULL AND abs(replace(a[1], ',', '')::numeric - p_fee) <= 0.01 AND a[2]::numeric = round(p_pct, 2) THEN RETURN 'ok'; END IF;
    RETURN 'displayed_fee_differs';
  END IF;
  -- react-app contractor/bid/[claimId]/copy.ts buildFeeDisclosureText()
  b := regexp_match(p_text, '^By submitting this bid, you agree to pay Otter Quotes a platform fee of ((?:0|[1-9][0-9]{0,2})\.[0-9]{2})% \(\$((?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)\.[0-9]{2})\) upon contract execution\. This fee is deducted from your bid amount before disbursement\. You will receive \$((?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)\.[0-9]{2}) upon completion\. I understand and agree to the platform fee of ((?:0|[1-9][0-9]{0,2})\.[0-9]{2})% \(\$((?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)\.[0-9]{2})\)$');
  IF b IS NOT NULL THEN
    IF b[1] <> b[4] OR b[2] <> b[5] THEN RETURN 'text_not_form_wording'; END IF;
    IF p_pct IS NOT NULL AND p_fee IS NOT NULL AND b[1]::numeric = round(p_pct, 2)
       AND abs(replace(b[2], ',', '')::numeric - p_fee) <= 0.01
       AND (p_total IS NULL OR abs(replace(b[3], ',', '')::numeric - (p_total - p_fee)) <= 0.02) THEN RETURN 'ok'; END IF;
    RETURN 'displayed_fee_differs';
  END IF;
  RETURN 'text_not_form_wording';
END
$txt$;

COMMENT ON FUNCTION public.fee_acceptance_text_check(text, numeric, numeric, numeric) IS
  'gh-3409: ok when p_text is exactly the HTML bid form''s or the React bid form''s fee disclosure and the rate and fee printed in it equal p_pct and p_fee (one cent) and, in the React wording, the net equals p_total - p_fee (two cents); displayed_fee_differs when it is a form text with other numbers; text_not_form_wording otherwise. Update together with either form''s wording.';

-- The only writer of the quarantine table. SECURITY DEFINER so the client roles need no privilege on it; refuses to run outside a trigger, so a client cannot call it to write rows.
CREATE OR REPLACE FUNCTION public.fee_acceptance_quarantine_add(p_row public.fee_acceptances, p_reasons text[], p_server_pct numeric, p_server_fee numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $qa$
BEGIN
  IF pg_trigger_depth() < 1 THEN
    RAISE EXCEPTION 'fee_acceptance_quarantine_add runs only inside the fee_acceptances guard trigger (gh-3409)' USING ERRCODE = '42501';
  END IF;
  -- Flood cap: a genuine caller diverts about one row per bid, so 25 an hour per caller is far above real use. Past it the row is only logged (the trigger logs every diversion with the shown text).
  IF (SELECT count(*) FROM public.fee_acceptance_quarantine x WHERE x.caller_user_id IS NOT DISTINCT FROM auth.uid() AND x.quarantined_at > now() - interval '1 hour') >= 25 THEN
    RAISE WARNING 'gh-3409 quarantine cap reached for caller %; row not stored (logged only)', auth.uid();
    RETURN;
  END IF;
  INSERT INTO public.fee_acceptance_quarantine (reasons, caller_user_id, server_fee_pct, server_fee_amount, client_row_id, client_created_at, contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount,
                                                fee_text_displayed, fee_text_length, accepted_at, ip_address, user_agent, invoice_url, rescinded_at, rescission_reason)
  VALUES (p_reasons, auth.uid(), p_server_pct, p_server_fee, p_row.id, p_row.created_at, p_row.contractor_id, p_row.claim_id, p_row.bid_id, p_row.fee_pct, p_row.fee_basis, p_row.fee_amount,
          left(p_row.fee_text_displayed, 4000), length(p_row.fee_text_displayed), p_row.accepted_at, p_row.ip_address, left(p_row.user_agent, 500), p_row.invoice_url, p_row.rescinded_at, p_row.rescission_reason);
END
$qa$;
REVOKE ALL ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) TO anon, authenticated, service_role;

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

COMMENT ON FUNCTION public.fee_acceptances_guard_client_insert() IS
  'gh-3409: BEFORE INSERT guard on public.fee_acceptances for client roles. See supabase/migrations_drafts/gh3409_fee_acceptances_client_insert_guard.sql.';

DROP TRIGGER IF EXISTS fee_acceptances_guard_client_insert ON public.fee_acceptances;
CREATE TRIGGER fee_acceptances_guard_client_insert
  BEFORE INSERT ON public.fee_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.fee_acceptances_guard_client_insert();

-- GUARD: the trigger exists, is enabled for every session role (tgenabled 'O'), is BEFORE INSERT FOR EACH ROW, and no client role holds a privilege on the quarantine table, which has RLS on.
DO $final$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND NOT tgisinternal
     AND tgname = 'fee_acceptances_guard_client_insert' AND tgenabled = 'O' AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 4) = 4;
  IF n <> 1 THEN
    RAISE EXCEPTION 'gh3409: guard trigger missing, disabled or not BEFORE INSERT FOR EACH ROW; nothing is applied';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.fee_acceptance_quarantine'::regclass)
     OR has_table_privilege('anon', 'public.fee_acceptance_quarantine', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.fee_acceptance_quarantine', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_any_column_privilege('anon', 'public.fee_acceptance_quarantine', 'SELECT,INSERT,UPDATE')
     OR has_any_column_privilege('authenticated', 'public.fee_acceptance_quarantine', 'SELECT,INSERT,UPDATE') THEN
    RAISE EXCEPTION 'gh3409: the quarantine table is readable or writable by a client role, or has no RLS; nothing is applied';
  END IF;
END
$final$;

COMMIT;
