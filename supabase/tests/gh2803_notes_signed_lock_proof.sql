-- gh-2803 proof: refuse client changes to quotes.notes once EITHER homeowner_signed_at OR contractor_signed_at is set (#2846 ruling, option (b)). THROWAWAY POSTGRES ONLY.
-- Needs the throwaway schema, gh2626/gh2519/gh2564, and update_selected_bid_notes() (PR #2844) applied. Runs in one transaction, ends in ROLLBACK.
-- Fixtures: claim cn1 / quote qn1 (selected, active, NOT signed), claim cn2 / quote qn2 (selected, active, homeowner-SIGNED), claim cn3 / quote qn3 (selected, active, CONTRACTOR-signed only), all contractor k1 (user 3333...).
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
BEGIN;
INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, status, address_state, coi_file_url, coi_expires_at, attestation_accepted_at,
                                has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, is_test)
VALUES ('aaaaaaa1-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'Proof Roofing One', 'K One', 'k1@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'proof-method-1', '4242', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.claims (id, user_id, status, ready_for_bids, trades, selected_contractor_id, selected_bid_amount, referral_id, is_test, created_at)
VALUES ('c0000051-0000-4000-8000-000000000051', '11111111-1111-4111-8111-111111111111', 'awarded', true, '{roofing}', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, NULL, true, now() - interval '2 days'),
       ('c0000052-0000-4000-8000-000000000052', '11111111-1111-4111-8111-111111111111', 'awarded', true, '{roofing}', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, NULL, true, now() - interval '2 days'),
       ('c0000053-0000-4000-8000-000000000053', '11111111-1111-4111-8111-111111111111', 'awarded', true, '{roofing}', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, NULL, true, now() - interval '2 days');
INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis, status, bid_status, trade_type, notes, homeowner_signed_at, contractor_signed_at, is_test)
VALUES ('e0000051-0000-4000-8000-000000000051', 'c0000051-0000-4000-8000-000000000051', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, 5.00, 750, 5.00, 'bid_amount', 'selected', 'active', 'roofing', 'original unsigned note', NULL, NULL, true),
       ('e0000052-0000-4000-8000-000000000052', 'c0000052-0000-4000-8000-000000000052', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, 5.00, 750, 5.00, 'bid_amount', 'selected', 'active', 'roofing', 'ORIGINAL SIGNED NOTE', now(), NULL, true),
       ('e0000053-0000-4000-8000-000000000053', 'c0000053-0000-4000-8000-000000000053', 'aaaaaaa1-0000-4000-8000-000000000001', 15000, 5.00, 750, 5.00, 'bid_amount', 'selected', 'active', 'roofing', 'ORIGINAL CONTRACTOR-SIGNED NOTE', NULL, now(), true);

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'notes-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 100);
  END;
END $f$;
-- stored notes, read as the table owner
CREATE FUNCTION pg_temp.nt(p_id uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT ' -> notes=' || COALESCE((SELECT notes FROM public.quotes WHERE id = p_id), 'NULL') $f$;
-- put both fixtures back, as the owner (the guard does not act for the owner session)
CREATE FUNCTION pg_temp.reset() RETURNS void LANGUAGE sql AS $f$
  UPDATE public.quotes SET notes = 'original unsigned note' WHERE id = 'e0000051-0000-4000-8000-000000000051';
  UPDATE public.quotes SET notes = 'ORIGINAL SIGNED NOTE'   WHERE id = 'e0000052-0000-4000-8000-000000000052';
  UPDATE public.quotes SET notes = 'ORIGINAL CONTRACTOR-SIGNED NOTE' WHERE id = 'e0000053-0000-4000-8000-000000000053'; $f$;

SELECT 'TRIGGER ' || CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_refuse_signed_notes_change' AND NOT tgisinternal)
       THEN 'quotes_refuse_signed_notes_change is installed' ELSE 'quotes_refuse_signed_notes_change is NOT installed' END
       || ' | guard carries gh-2564: ' || (SELECT prosrc LIKE '%gh-2564%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure)
       || ' | RPC present: ' || (to_regprocedure('public.update_selected_bid_notes(uuid,text)') IS NOT NULL);

-- N1 THE HOLE: contractor, direct table write of notes on a SIGNED bid
SELECT 'N1 direct notes write on signed bid (k1, authenticated): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET notes = 'rewritten after signature' WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N2 notes BEFORE signature stay writable (direct)
SELECT 'N2 direct notes write on unsigned selected bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET notes = 'edited before signature' WHERE id = 'e0000051-0000-4000-8000-000000000051'$q$) || pg_temp.nt('e0000051-0000-4000-8000-000000000051');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N3 RPC before signature works
SELECT 'N3 update_selected_bid_notes on unsigned bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$SELECT public.update_selected_bid_notes('e0000051-0000-4000-8000-000000000051', ' via rpc before signature ')$q$) || pg_temp.nt('e0000051-0000-4000-8000-000000000051');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N4 RPC after signature refuses (22023), notes unmoved
SELECT 'N4 update_selected_bid_notes on signed bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$SELECT public.update_selected_bid_notes('e0000052-0000-4000-8000-000000000052', 'via rpc after signature')$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N5 service_role still writes a signed bid's notes
SELECT 'N5 direct notes write on signed bid (service_role): ' || pg_temp.try_as('service_role', NULL,
  $q$UPDATE public.quotes SET notes = 'service edit' WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N6 re-sending the same value after signature is not a change
SELECT 'N6 same notes value re-sent on signed bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET notes = 'ORIGINAL SIGNED NOTE' WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
-- N7 price lock still holds (gh2564 control) on the signed bid
SELECT 'N7 direct price write on signed bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET total_price = total_price + 1 WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$);
-- N8 clearing notes (set NULL) after signature is also a change
SELECT 'N8 direct notes = NULL on signed bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET notes = NULL WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N9 owner-level session (the SECURITY DEFINER path's role) still writes
SELECT 'N9 direct notes write on signed bid (table owner session): ' || pg_temp.try_as(current_user, NULL,
  $q$UPDATE public.quotes SET notes = 'owner edit' WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
-- N10 anon cannot write at all
SELECT 'N10 direct notes write on signed bid (anon): ' || pg_temp.try_as('anon', NULL,
  $q$UPDATE public.quotes SET notes = 'anon edit' WHERE id = 'e0000052-0000-4000-8000-000000000052'$q$) || pg_temp.nt('e0000052-0000-4000-8000-000000000052');
-- N11 (#2846 option (b)): contractor signature ALONE (homeowner unsigned) -- direct notes write refused
SELECT 'N11 direct notes write on contractor-signed-only bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET notes = 'rewritten after contractor signature' WHERE id = 'e0000053-0000-4000-8000-000000000053'$q$) || pg_temp.nt('e0000053-0000-4000-8000-000000000053');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N12 contractor signature alone: clearing notes (set NULL) is also a change
SELECT 'N12 direct notes = NULL on contractor-signed-only bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET notes = NULL WHERE id = 'e0000053-0000-4000-8000-000000000053'$q$) || pg_temp.nt('e0000053-0000-4000-8000-000000000053');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N13 RPC after contractor signature alone refuses (22023), notes unmoved
SELECT 'N13 update_selected_bid_notes on contractor-signed-only bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$SELECT public.update_selected_bid_notes('e0000053-0000-4000-8000-000000000053', 'via rpc after contractor signature')$q$) || pg_temp.nt('e0000053-0000-4000-8000-000000000053');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N14 CHAINED REWRITE (reviewer's non-blocking suggestion, plain BEFORE UPDATE): the statement never names notes; a test trigger that sorts BEFORE
-- quotes_refuse_signed_notes_change rewrites NEW.notes when auto_renew changes (auto_renew stays client-writable on a selected bid, gh2564 header). An "OF notes" trigger would not fire at all here.
CREATE FUNCTION public.quotes_aa_proof_chain() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN IF NEW.auto_renew IS DISTINCT FROM OLD.auto_renew THEN NEW.notes := 'chained rewrite'; END IF; RETURN NEW; END $f$;
CREATE TRIGGER quotes_aa_proof_chain BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.quotes_aa_proof_chain();
SELECT 'N14 chained rewrite of notes via another column on contractor-signed-only bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET auto_renew = NOT COALESCE(auto_renew, false) WHERE id = 'e0000053-0000-4000-8000-000000000053'$q$) || pg_temp.nt('e0000053-0000-4000-8000-000000000053');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N15 the same chained write on an UNSIGNED bid is allowed (before signature notes stay writable)
SELECT 'N15 chained rewrite of notes via another column on unsigned bid (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET auto_renew = NOT COALESCE(auto_renew, false) WHERE id = 'e0000051-0000-4000-8000-000000000051'$q$) || pg_temp.nt('e0000051-0000-4000-8000-000000000051');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N16 one statement that clears the contractor signature AND edits notes is refused (the trigger reads OLD)
SELECT 'N16 clear contractor_signed_at AND edit notes in one statement (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET contractor_signed_at = NULL, notes = 'unsign then edit' WHERE id = 'e0000053-0000-4000-8000-000000000053'$q$) || pg_temp.nt('e0000053-0000-4000-8000-000000000053');
SELECT '' WHERE pg_temp.reset() IS NULL;
-- N17 PROBE (reported, not asserted): can the contractor clear contractor_signed_at on its own, as a separate statement?
SELECT 'N17 PROBE clear contractor_signed_at alone (k1): ' || pg_temp.try_as('authenticated', '33333333-3333-4333-8333-333333333333',
  $q$UPDATE public.quotes SET contractor_signed_at = NULL WHERE id = 'e0000053-0000-4000-8000-000000000053'$q$);
ROLLBACK;
