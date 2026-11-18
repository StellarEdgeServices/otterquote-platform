-- gh-3497 part 2 proof: a client bid whose DISPLAYED rate differs from the configured rate is refused
-- (draft supabase/migrations_drafts/gh3497_quotes_refuse_rate_mismatch.sql). THROWAWAY POSTGRES ONLY.
-- Needs the throwaway schema and gh2626 -> gh2519 -> gh2564 applied. Ends in ROLLBACK; every insert runs in its own undone subtransaction.
-- The one rate in the fixtures is production's platform_fee_config row (5.00, bid_amount). 7.50 is a TEST value, not a proposal.
-- Each line prints whether the insert was ACCEPTED (with the rate and fee_amount the server STORED) or REJECTED (SQLSTATE, message), and how many
-- quote rows exist for the new id afterwards (a refused bid must leave none).
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
BEGIN;
INSERT INTO public.platform_fee_config (id, state, trade, fee_pct, fee_basis, effective_date, notes)
VALUES ('fcd50269-f689-42d4-bbc3-8f01e5390c44', NULL, NULL, 5.00, 'bid_amount', DATE '2026-05-06', 'copy of the one production row')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, status, address_state, coi_file_url, coi_expires_at, attestation_accepted_at,
                                has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, is_test)
VALUES ('aaaaaaa3-0000-4000-8000-000000000003', '55555555-5555-4555-8555-555555555555', 'Proof Roofing Three', 'K Three', 'k3@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'proof-method-3', '4242', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.claims (id, user_id, status, ready_for_bids, trades, selected_contractor_id, selected_bid_amount, referral_id, is_test, created_at)
VALUES ('c0000001-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'bidding', true, '{roofing}', NULL, NULL, NULL, true, now() - interval '2 days')
ON CONFLICT (id) DO NOTHING;

-- Run p_sql as p_role (JWT sub p_sub), read back the row the way the owner sees it, then undo it all. One text line.
CREATE FUNCTION pg_temp.try_insert(p_role text, p_sub uuid, p_sql text, p_id uuid) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE r text; n int;
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
      ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', 'rate-proof@example.invalid')::text END, true);
    PERFORM set_config('role', p_role, true);
    BEGIN
      EXECUTE p_sql;
      EXECUTE 'RESET ROLE';
      SELECT 'ACCEPTED stored rate=' || COALESCE(platform_fee_pct::text, 'NULL') || ' fee_percentage=' || fee_percentage || ' fee_amount=' || fee_amount INTO r
        FROM public.quotes WHERE id = p_id;
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      r := 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 140);
    END;
    SELECT count(*) INTO n FROM public.quotes WHERE id = p_id;
    r := r || ' | quote rows for this bid: ' || n;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;

CREATE FUNCTION pg_temp.cols() RETURNS text LANGUAGE sql AS $f$
  SELECT '(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, scope_summary, supplement_acknowledged, trade_type, value_adds, is_auto_bid, auto_renew, platform_fee_pct, platform_fee_basis, fee_accepted_at)' $f$;
-- the bid forms' insert: they send the rate they SHOW as both fee_percentage and platform_fee_pct, and the fee amount they show
CREATE FUNCTION pg_temp.form_insert(p_id uuid, p_shown numeric, p_price numeric) RETURNS text LANGUAGE sql AS $f$
  SELECT format('INSERT INTO public.quotes %s VALUES (%L, ''c0000001-0000-4000-8000-000000000001'', ''aaaaaaa3-0000-4000-8000-000000000003'', %s, %s, %s, ''scope'', false, ''roofing'', ''{}''::jsonb, false, true, %s, ''bid_amount'', now())',
    pg_temp.cols(), p_id, p_price, p_shown, round(p_shown / 100.0 * p_price, 2), p_shown) $f$;
-- the same insert with NO displayed rate (platform_fee_pct and platform_fee_basis NULL)
CREATE FUNCTION pg_temp.norate_insert(p_id uuid, p_price numeric) RETURNS text LANGUAGE sql AS $f$
  SELECT format('INSERT INTO public.quotes %s VALUES (%L, ''c0000001-0000-4000-8000-000000000001'', ''aaaaaaa3-0000-4000-8000-000000000003'', %s, 5, %s, ''scope'', false, ''roofing'', ''{}''::jsonb, false, true, NULL, NULL, now())',
    pg_temp.cols(), p_id, p_price, round(0.05 * p_price, 2)) $f$;
-- process-auto-bids' insert shape (service_role): the rate it resolved itself, fee_agreed, is_auto_bid, bid_status
CREATE FUNCTION pg_temp.autobid_insert(p_id uuid, p_rate numeric, p_price numeric) RETURNS text LANGUAGE sql AS $f$
  SELECT format('INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, platform_fee_pct, fee_amount, fee_agreed, fee_agreed_at, status, trade_type, is_auto_bid, auto_renew, scope_summary, bid_status, expires_at) VALUES (%L, ''c0000001-0000-4000-8000-000000000001'', ''aaaaaaa3-0000-4000-8000-000000000003'', %s, %s, %s, %s, true, now(), ''submitted'', ''roofing'', true, false, ''Auto-submitted bid'', ''active'', now() + interval ''14 days'')',
    p_id, p_price, p_rate, p_rate, round(p_rate / 100.0 * p_price, 2)) $f$;

SELECT 'TRIGGER ' || CASE WHEN EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_check_displayed_fee_rate' AND NOT tgisinternal)
       THEN 'quotes_check_displayed_fee_rate is installed' ELSE 'quotes_check_displayed_fee_rate is NOT installed' END
       || ' | guard carries gh-2519: ' || (SELECT prosrc LIKE '%gh-2519%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure)
       || ' | BEFORE INSERT row triggers in firing order: ' || (SELECT string_agg(tgname::text, ' > ' ORDER BY tgname::text COLLATE "C") FROM pg_trigger
            WHERE tgrelid = 'public.quotes'::regclass AND NOT tgisinternal AND (tgtype & 1) = 1 AND (tgtype & 2) = 2 AND (tgtype & 4) = 4);

\set k3 '55555555-5555-4555-8555-555555555555'
-- ===== configured 5.00 =====
SELECT 'A1 configured 5.00, form shows 5.00, bid $25,000 (contractor k3): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000001-0000-4000-8000-000000000001', 5, 25000), 'd0000001-0000-4000-8000-000000000001');
SELECT 'A2 configured 5.00, form shows 5.0000 (same number, other scale): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000002-0000-4000-8000-000000000002', 5.0000, 25000), 'd0000002-0000-4000-8000-000000000002');
SELECT 'A3 configured 5.00, form shows 5.00, NO displayed rate sent: ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.norate_insert('d0000003-0000-4000-8000-000000000003', 25000), 'd0000003-0000-4000-8000-000000000003');
SELECT 'A4 configured 5.00, form shows 4.00 (lower than configured): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000004-0000-4000-8000-000000000004', 4, 25000), 'd0000004-0000-4000-8000-000000000004');

-- ===== the configured rate moves to 7.50 (the admin fee panel writes the table live; a TEST value) =====
UPDATE public.platform_fee_config SET fee_pct = 7.50 WHERE id = 'fcd50269-f689-42d4-bbc3-8f01e5390c44';
SELECT 'RATE configured now: ' || (SELECT fee_pct::text FROM public.quotes_platform_fee_for('aaaaaaa3-0000-4000-8000-000000000003', 'c0000001-0000-4000-8000-000000000001'));
SELECT 'B1 THE HOLE: configured 7.50, form still shows 5.00, bid $25,000 (k3): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000011-0000-4000-8000-000000000011', 5, 25000), 'd0000011-0000-4000-8000-000000000011');
SELECT 'B2 configured 7.50, form shows 7.50 (re-read and re-accepted): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000012-0000-4000-8000-000000000012', 7.5, 25000), 'd0000012-0000-4000-8000-000000000012');
SELECT 'B3 configured 7.50, form shows 9.00 (higher than configured): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000013-0000-4000-8000-000000000013', 9, 25000), 'd0000013-0000-4000-8000-000000000013');
SELECT 'B4 configured 7.50, NO displayed rate sent (a path that inserts without one): ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.norate_insert('d0000014-0000-4000-8000-000000000014', 25000), 'd0000014-0000-4000-8000-000000000014');
SELECT 'B5 process-auto-bids shape, service_role, resolved rate 7.50: ' || pg_temp.try_insert('service_role', NULL, pg_temp.autobid_insert('d0000015-0000-4000-8000-000000000015', 7.5, 25000), 'd0000015-0000-4000-8000-000000000015');
SELECT 'B6 process-auto-bids shape, service_role, rate 5.00 (stale, as sent): ' || pg_temp.try_insert('service_role', NULL, pg_temp.autobid_insert('d0000016-0000-4000-8000-000000000016', 5, 25000), 'd0000016-0000-4000-8000-000000000016');
SELECT 'B7 owner-level session (SECURITY DEFINER path), shows 5.00: ' || pg_temp.try_insert(current_user, NULL, pg_temp.form_insert('d0000017-0000-4000-8000-000000000017', 5, 25000), 'd0000017-0000-4000-8000-000000000017');
SELECT 'B8 anon, shows 5.00: ' || pg_temp.try_insert('anon', NULL, pg_temp.form_insert('d0000018-0000-4000-8000-000000000018', 5, 25000), 'd0000018-0000-4000-8000-000000000018');
SELECT 'B9 other contractor id (k3 JWT, someone else''s contractor_id), shows 5.00: ' || pg_temp.try_insert('authenticated', '66666666-6666-4666-8666-666666666666', pg_temp.form_insert('d0000019-0000-4000-8000-000000000019', 5, 25000), 'd0000019-0000-4000-8000-000000000019');

-- ===== CONTROL: the same check, firing AFTER the guard, reads the overwritten rate and the hole is open again =====
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_check_displayed_fee_rate' AND NOT tgisinternal) THEN
    ALTER TRIGGER quotes_check_displayed_fee_rate ON public.quotes RENAME TO quotes_zz_check_displayed_fee_rate;
  END IF;
END $c$;
SELECT 'C1 CONTROL (trigger renamed to fire after the guard; no-op before the migration), configured 7.50, form shows 5.00: ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000021-0000-4000-8000-000000000021', 5, 25000), 'd0000021-0000-4000-8000-000000000021');
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_zz_check_displayed_fee_rate' AND NOT tgisinternal) THEN
    ALTER TRIGGER quotes_zz_check_displayed_fee_rate ON public.quotes RENAME TO quotes_check_displayed_fee_rate;
  END IF;
END $c$;

-- ===== no config row at all: the guard's own refusal, unchanged =====
DELETE FROM public.platform_fee_config;
SELECT 'D1 no platform_fee_config row, form shows 5.00: ' || pg_temp.try_insert('authenticated', :'k3', pg_temp.form_insert('d0000031-0000-4000-8000-000000000031', 5, 25000), 'd0000031-0000-4000-8000-000000000031');
SELECT 'D2 no platform_fee_config row, process-auto-bids shape (service_role): ' || pg_temp.try_insert('service_role', NULL, pg_temp.autobid_insert('d0000032-0000-4000-8000-000000000032', 5, 25000), 'd0000032-0000-4000-8000-000000000032');
ROLLBACK;
