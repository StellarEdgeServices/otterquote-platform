-- gh-2443 proof: a contractor can clear ONLY their own CPA re-attestation flag, ONLY by writing the CURRENT agreement version.
-- Run against production (yeszghaspzwwstvsrioa) as ONE transaction that ends in ROLLBACK. Nothing commits.
--   Phase PRE      the live body (negative control: the flag never clears).
--   Phase FIXED    the gh-2443 forward body applied inside the transaction.
--   Phase ROLLBACK the rollback body applied inside the transaction (must equal the live body byte for byte: md5 asserted).
-- Writes are made with role-switched sessions (authenticated, non-admin, jwt sub = the contractor's own user_id) on TWO is_test
-- contractors only (A bb07fc40..., B 136d1a1d...). A temporary current CPA version 'v2-gh2443-proof' is inserted and rolled back with the rest.
-- The last statement before ROLLBACK is the result table; every row's ok must be true. Rows prefixed [expect-differs] are the controls
-- where PRE and FIXED are meant to differ; all other rows must match in every phase.

BEGIN;

CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, phase text, label text, got text, expected text, ok boolean, detail text);

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_email text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
END $f$;

CREATE FUNCTION pg_temp.st(p_cid uuid, p_ver text, p_flag boolean) RETURNS void
LANGUAGE sql AS $f$ UPDATE public.contractors SET cpa_version = p_ver, needs_cpa_reattestation = p_flag WHERE id = p_cid $f$;

CREATE FUNCTION pg_temp.fl(p_cid uuid) RETURNS text
LANGUAGE sql AS $f$ SELECT needs_cpa_reattestation::text FROM public.contractors WHERE id = p_cid $f$;

CREATE FUNCTION pg_temp.rec(p_phase text, p_label text, p_got text, p_exp text, p_detail text) RETURNS void
LANGUAGE sql AS $f$ INSERT INTO proof_r(phase,label,got,expected,ok,detail) VALUES (p_phase,p_label,p_got,p_exp,p_got IS NOT DISTINCT FROM p_exp,p_detail) $f$;

CREATE FUNCTION pg_temp.phase(p_phase text, p_fixed boolean) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE
  a  uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'; ua uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d'; ea text := 'test-contractor@otterquote-internal.test';
  b  uuid := '136d1a1d-764c-43a0-9ded-a47a35faa010';
  v1 text := 'v1-2026-04'; v2 text := 'v2-gh2443-proof';
  clr text := CASE WHEN p_fixed THEN 'false' ELSE 'true' END;   -- expected flag when a legitimate clear is attempted
  r text; snap0 text; snap1 text;
BEGIN
  -- C1 flagged on the old version, re-accepts writing the CURRENT version (v2): clears (pre-fix: stays true) [expect-differs]
  PERFORM pg_temp.st(a, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, cpa_accepted_at=now(), needs_cpa_reattestation=false WHERE id=%L', v2, a));
  PERFORM pg_temp.rec(p_phase, '[expect-differs] C1 flagged, writes CURRENT version + flag=false', pg_temp.fl(a), clr, r || ' ver_after=' || (SELECT cpa_version FROM public.contractors WHERE id=a));
  -- C2 flagged, writes the stale version v1 with flag=false: stays true
  PERFORM pg_temp.st(a, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=false WHERE id=%L', v1, a));
  PERFORM pg_temp.rec(p_phase, 'C2 flagged, writes STALE version + flag=false', pg_temp.fl(a), 'true', r);
  -- C3 flagged, writes an invented version: stays true
  PERFORM pg_temp.st(a, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=false WHERE id=%L', 'v9-invented', a));
  PERFORM pg_temp.rec(p_phase, 'C3 flagged, writes INVENTED version + flag=false', pg_temp.fl(a), 'true', r);
  -- C4 flagged, stored version already current (the stuck state), writes flag=false alone: clears (pre-fix: stays true) [expect-differs]
  PERFORM pg_temp.st(a, v2, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET needs_cpa_reattestation=false WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, '[expect-differs] C4 flagged, stored version CURRENT, flag=false alone', pg_temp.fl(a), clr, r);
  -- C4b flagged, stored version stale, writes flag=false alone: stays true
  PERFORM pg_temp.st(a, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET needs_cpa_reattestation=false WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C4b flagged, stored version STALE, flag=false alone', pg_temp.fl(a), 'true', r);
  -- C5 not flagged, tries to set the flag true (current or stale version): stays false
  PERFORM pg_temp.st(a, v2, false);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET needs_cpa_reattestation=true WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C5 not flagged, sets flag=true', pg_temp.fl(a), 'false', r);
  PERFORM pg_temp.st(a, v1, false);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=true WHERE id=%L', v2, a));
  PERFORM pg_temp.rec(p_phase, 'C5b not flagged, writes current version + flag=true', pg_temp.fl(a), 'false', r);
  -- C6 no is_current row at all: stays pinned (subquery NULL)
  UPDATE public.cpa_versions SET is_current = false WHERE is_current;
  PERFORM pg_temp.st(a, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=false WHERE id=%L', v2, a));
  PERFORM pg_temp.rec(p_phase, 'C6 no is_current row, writes v2 + flag=false', pg_temp.fl(a), 'true', r || ' current_rows=' || (SELECT count(*) FROM public.cpa_versions WHERE is_current));
  PERFORM pg_temp.st(a, v2, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET needs_cpa_reattestation=false WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C6b no is_current row, stored v2, flag=false alone', pg_temp.fl(a), 'true', r);
  UPDATE public.cpa_versions SET is_current = true WHERE version_label = v2;
  -- C7 contractor A tries to clear contractor B's flag: zero rows, B stays true; then A clears only A
  PERFORM pg_temp.st(a, v1, true); PERFORM pg_temp.st(b, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=false WHERE id=%L', v2, b));
  PERFORM pg_temp.rec(p_phase, 'C7 A writes B''s row (current version + flag=false)', pg_temp.fl(b), 'true', r);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=false WHERE id=%L', v2, a));
  PERFORM pg_temp.rec(p_phase, '[expect-differs] C7b A clears A (B unchanged below)', pg_temp.fl(a), clr, r);
  PERFORM pg_temp.rec(p_phase, 'C7c B still flagged after A cleared A', pg_temp.fl(b), 'true', '');
  -- C8 legitimate clear bundled with every other guarded column: the other columns must not move
  PERFORM pg_temp.st(a, v1, true);
  SELECT concat_ws('|', status, verified, is_test, admin_notes, has_payment_method, legacy_pre_approval, rating, review_count, template_review_role, cert_status) INTO snap0 FROM public.contractors WHERE id=a;
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=false, status=%L, verified=true, is_test=false, admin_notes=%L, has_payment_method=true, legacy_pre_approval=true, rating=5, review_count=99, template_review_role=%L WHERE id=%L', v2, 'rejected', 'gh2443', 'admin', a));
  SELECT concat_ws('|', status, verified, is_test, admin_notes, has_payment_method, legacy_pre_approval, rating, review_count, template_review_role, cert_status) INTO snap1 FROM public.contractors WHERE id=a;
  PERFORM pg_temp.rec(p_phase, 'C8 clear + 9 other guarded columns: other columns unchanged', CASE WHEN snap0 = snap1 THEN 'unchanged' ELSE 'CHANGED ' || snap1 END, 'unchanged', r);
  PERFORM pg_temp.rec(p_phase, '[expect-differs] C8b flag in the same write', pg_temp.fl(a), clr, '');
  -- C9 flag written NULL: stays pinned
  PERFORM pg_temp.st(a, v1, true);
  r := pg_temp.try_as('authenticated', ua, ea, format('UPDATE public.contractors SET cpa_version=%L, needs_cpa_reattestation=NULL WHERE id=%L', v2, a));
  PERFORM pg_temp.rec(p_phase, 'C9 flag written NULL', pg_temp.fl(a), 'true', r);
  -- C10 admin and service_role behave as before in every phase
  PERFORM pg_temp.st(a, v1, false);
  r := pg_temp.try_as('authenticated', ua, 'dustinstohler1@gmail.com', format('UPDATE public.contractors SET needs_cpa_reattestation=true WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C10a admin sets flag true', pg_temp.fl(a), 'true', r);
  r := pg_temp.try_as('authenticated', ua, 'dustinstohler1@gmail.com', format('UPDATE public.contractors SET needs_cpa_reattestation=false WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C10b admin clears flag on a stale version', pg_temp.fl(a), 'false', r);
  r := pg_temp.try_as('service_role', ua, ea, format('UPDATE public.contractors SET needs_cpa_reattestation=true WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C10c service_role sets flag true', pg_temp.fl(a), 'true', r);
  r := pg_temp.try_as('service_role', ua, ea, format('UPDATE public.contractors SET needs_cpa_reattestation=false WHERE id=%L', a));
  PERFORM pg_temp.rec(p_phase, 'C10d service_role clears flag on a stale version', pg_temp.fl(a), 'false', r);
END $f$;

-- Setup (as postgres): a CPA publish. v1 stops being current, v2 becomes current.
UPDATE public.cpa_versions SET is_current = false WHERE is_current;
INSERT INTO public.cpa_versions (version_label, effective_date, change_summary, is_current) VALUES ('v2-gh2443-proof', current_date, 'gh-2443 proof only (rolled back)', true);

INSERT INTO proof_r(phase,label,got,expected,ok,detail) SELECT 'PRE','live body md5', md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc)), 'ba1ec8b8f887b0f7de9ac8c57b51bb33', md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc)) = 'ba1ec8b8f887b0f7de9ac8c57b51bb33', '';
SELECT pg_temp.phase('PRE', false);

-- ===== forward body (supabase/migrations_drafts/gh2443_cpa_reattest_clear.sql) =====
CREATE OR REPLACE FUNCTION public.contractors_freeze_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only constrain direct end-user (authenticated) writes. service_role (Edge Functions / cron)
  -- and SECURITY DEFINER system triggers run as a non-'authenticated' role => exempt.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  -- Admin account is exempt (mirrors the existing admin_update_contractors policy).
  IF coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status                         := 'pending_approval';
    NEW.template_review_role           := NULL;
    NEW.verified                       := false;
    NEW.rating                         := NULL;
    NEW.review_count                   := 0;
    NEW.license_verified               := false;
    NEW.license_verified_at            := NULL;
    NEW.insurance_verified             := false;
    NEW.insurance_verified_at          := NULL;
    NEW.insurance_verification_sent_at := NULL;
    NEW.insurance_verification_email   := NULL;
    NEW.approved_at                    := NULL;
    NEW.rejected_at                    := NULL;
    NEW.rejection_reason               := NULL;
    NEW.cert_status                    := NULL;
    NEW.legacy_pre_approval            := false;
    NEW.needs_cpa_reattestation        := false;
    NEW.admin_notes                    := NULL;
    NEW.is_test                        := false;
    NEW.has_payment_method             := false;      -- gh-1425 path 1
    NEW.stripe_payment_method_id       := NULL;       -- gh-1425 path 1
    NEW.stripe_payment_method_last4    := NULL;       -- gh-1425 path 1
    RETURN NEW;
  END IF;

  -- UPDATE: pin every privileged column to its stored value (silently ignore change attempts).
  NEW.status                         := OLD.status;
  NEW.template_review_role           := OLD.template_review_role;
  NEW.verified                       := OLD.verified;
  NEW.rating                         := OLD.rating;
  NEW.review_count                   := OLD.review_count;
  NEW.license_verified               := OLD.license_verified;
  NEW.license_verified_at            := OLD.license_verified_at;
  NEW.insurance_verified             := OLD.insurance_verified;
  NEW.insurance_verified_at          := OLD.insurance_verified_at;
  NEW.insurance_verification_sent_at := OLD.insurance_verification_sent_at;
  NEW.insurance_verification_email   := OLD.insurance_verification_email;
  NEW.approved_at                    := OLD.approved_at;
  NEW.rejected_at                    := OLD.rejected_at;
  NEW.rejection_reason               := OLD.rejection_reason;
  NEW.cert_status                    := OLD.cert_status;
  NEW.legacy_pre_approval            := OLD.legacy_pre_approval;
  -- gh-2443: clear-only exception. A contractor may turn OFF their own re-attestation flag, and only
  -- while writing the CURRENT agreement version. Anything else stays pinned (never set true, never
  -- cleared on a stale or invented version, never cleared when no version is current).
  NEW.needs_cpa_reattestation        := CASE
    WHEN OLD.needs_cpa_reattestation = true
     AND NEW.needs_cpa_reattestation = false
     AND NEW.cpa_version = (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1)
    THEN false
    ELSE OLD.needs_cpa_reattestation
  END;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;              -- gh-1425 path 1
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;        -- gh-1425 path 1
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;     -- gh-1425 path 1
  RETURN NEW;
END;
$function$
;
INSERT INTO proof_r(phase,label,got,expected,ok,detail) SELECT 'FIXED','function body changed', (md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc)) <> 'ba1ec8b8f887b0f7de9ac8c57b51bb33')::text, 'true', md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc)) <> 'ba1ec8b8f887b0f7de9ac8c57b51bb33', '';
SELECT pg_temp.phase('FIXED', true);

-- ===== rollback body (supabase/migrations_rollbacks/gh2443_cpa_reattest_clear_rollback.sql) =====
CREATE OR REPLACE FUNCTION public.contractors_freeze_privileged_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Only constrain direct end-user (authenticated) writes. service_role (Edge Functions / cron)
  -- and SECURITY DEFINER system triggers run as a non-'authenticated' role => exempt.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  -- Admin account is exempt (mirrors the existing admin_update_contractors policy).
  IF coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status                         := 'pending_approval';
    NEW.template_review_role           := NULL;
    NEW.verified                       := false;
    NEW.rating                         := NULL;
    NEW.review_count                   := 0;
    NEW.license_verified               := false;
    NEW.license_verified_at            := NULL;
    NEW.insurance_verified             := false;
    NEW.insurance_verified_at          := NULL;
    NEW.insurance_verification_sent_at := NULL;
    NEW.insurance_verification_email   := NULL;
    NEW.approved_at                    := NULL;
    NEW.rejected_at                    := NULL;
    NEW.rejection_reason               := NULL;
    NEW.cert_status                    := NULL;
    NEW.legacy_pre_approval            := false;
    NEW.needs_cpa_reattestation        := false;
    NEW.admin_notes                    := NULL;
    NEW.is_test                        := false;
    NEW.has_payment_method             := false;      -- gh-1425 path 1
    NEW.stripe_payment_method_id       := NULL;       -- gh-1425 path 1
    NEW.stripe_payment_method_last4    := NULL;       -- gh-1425 path 1
    RETURN NEW;
  END IF;

  -- UPDATE: pin every privileged column to its stored value (silently ignore change attempts).
  NEW.status                         := OLD.status;
  NEW.template_review_role           := OLD.template_review_role;
  NEW.verified                       := OLD.verified;
  NEW.rating                         := OLD.rating;
  NEW.review_count                   := OLD.review_count;
  NEW.license_verified               := OLD.license_verified;
  NEW.license_verified_at            := OLD.license_verified_at;
  NEW.insurance_verified             := OLD.insurance_verified;
  NEW.insurance_verified_at          := OLD.insurance_verified_at;
  NEW.insurance_verification_sent_at := OLD.insurance_verification_sent_at;
  NEW.insurance_verification_email   := OLD.insurance_verification_email;
  NEW.approved_at                    := OLD.approved_at;
  NEW.rejected_at                    := OLD.rejected_at;
  NEW.rejection_reason               := OLD.rejection_reason;
  NEW.cert_status                    := OLD.cert_status;
  NEW.legacy_pre_approval            := OLD.legacy_pre_approval;
  NEW.needs_cpa_reattestation        := OLD.needs_cpa_reattestation;
  NEW.admin_notes                    := OLD.admin_notes;
  NEW.is_test                        := OLD.is_test;
  NEW.has_payment_method             := OLD.has_payment_method;              -- gh-1425 path 1
  NEW.stripe_payment_method_id       := OLD.stripe_payment_method_id;        -- gh-1425 path 1
  NEW.stripe_payment_method_last4    := OLD.stripe_payment_method_last4;     -- gh-1425 path 1
  RETURN NEW;
END;
$function$
;
INSERT INTO proof_r(phase,label,got,expected,ok,detail) SELECT 'ROLLBACK','rolled-back body md5 = live md5', md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc)), 'ba1ec8b8f887b0f7de9ac8c57b51bb33', md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc)) = 'ba1ec8b8f887b0f7de9ac8c57b51bb33', '';
SELECT pg_temp.phase('ROLLBACK', false);

SELECT n, phase, label, got, expected, ok, detail FROM proof_r
UNION ALL SELECT 9999, 'SUMMARY', 'rows / failing rows', count(*)::text, count(*) FILTER (WHERE NOT ok)::text, count(*) FILTER (WHERE NOT ok) = 0, '' FROM proof_r
ORDER BY n;

ROLLBACK;
