-- gh-2864 proof: a client session (homeowner or contractor) can no longer change or clear a recorded quotes.homeowner_signed_at /
-- contractor_signed_at; service_role and SECURITY DEFINER platform paths still can.
-- NOT RUN when written (no database write access); run by Marty against production (yeszghaspzwwstvsrioa) as a superuser/owner role.
-- A single DO block whose last action is a deliberate RAISE EXCEPTION, so the forward DDL and every fixture write roll back
-- whatever the client does; the findings are the exception text. The text between the $fwd$ markers is the body of
-- supabase/migrations_drafts/gh2864_quotes_signature_stamps_platform_only.sql without its header, apply gate, COMMENT and BEGIN/COMMIT
-- lines (regenerate if that file changes).
-- Fixtures are looked up at run time (nothing hard-coded): an is_test homeowner's is_test claim in 'bidding' that has a submitted, active
-- is_test quote whose contractor is an is_test contractor with a user. Both stamps are set on it by a rolled-back superuser write.
-- Phases (each attempt runs as the named role with the caller's JWT sub, in its own savepoint):
--   BEFORE  live schema  : owner clears homeowner_signed_at -> expect ACCEPTED (the defect, the negative control); contractor clears contractor_signed_at -> expect ACCEPTED; BEFORE-3 NULL-to-value by owner and contractor -> expect ACCEPTED
--   FORWARD applied
--   AFTER-1 owner sets homeowner_signed_at = NULL            -> expect REJECTED 42501 ending (gh-2864)
--   AFTER-2 owner overwrites homeowner_signed_at with another time -> expect REJECTED 42501 (gh-2864)
--   AFTER-3 contractor sets contractor_signed_at = NULL      -> expect REJECTED 42501 (gh-2864)
--   AFTER-4 contractor overwrites contractor_signed_at       -> expect REJECTED 42501 (gh-2864)
--   AFTER-5 service_role clears and re-stamps both (the signing webhook / admin-reissue-contract path) -> expect ACCEPTED
--   AFTER-6 owner-level SECURITY DEFINER function, called by the owner, clears a stamp -> expect ACCEPTED (platform path)
--   AFTER-7 negative controls (expect ACCEPTED, unchanged behaviour): owner re-sends the same homeowner_signed_at; bid contractor edits notes;
--           owner declines the submitted quote (7b2 is informational: #2863's notes freeze refuses a notes edit on a signed quote)
--   AFTER-8 owner sets a NULL homeowner_signed_at to a value, contractor sets a NULL contractor_signed_at to a value (forged first stamp) -> expect REJECTED 42501 (gh-2864)
--   AFTER-9 trigger and function metadata, and the guard body md5 (untouched)

CREATE FUNCTION pg_temp.try_as(p_sub uuid, p_sql text, p_role text DEFAULT 'authenticated') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2864-proof@example.invalid')::text, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 160);
  END;
END $f$;
DO $proof$
DECLARE
  v text := '';
  owner_id uuid; c uuid; q uuid; k_id uuid; k_user uuid;
  fwd text := $fwd$
CREATE OR REPLACE FUNCTION public.quotes_refuse_client_signature_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND (NEW.homeowner_signed_at IS DISTINCT FROM OLD.homeowner_signed_at
          OR NEW.contractor_signed_at IS DISTINCT FROM OLD.contractor_signed_at) THEN
    RAISE EXCEPTION 'quotes: a signature stamp (homeowner_signed_at / contractor_signed_at) can only be written by the platform; a direct write is refused (gh-2864)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.quotes_refuse_client_signature_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_refuse_client_signature_change ON public.quotes;

CREATE TRIGGER quotes_refuse_client_signature_change
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  WHEN (NEW.homeowner_signed_at IS DISTINCT FROM OLD.homeowner_signed_at
        OR NEW.contractor_signed_at IS DISTINCT FROM OLD.contractor_signed_at)
  EXECUTE FUNCTION public.quotes_refuse_client_signature_change();
$fwd$;
  reset_q text;
  def_fn text := $def$
CREATE FUNCTION public.gh2864_proof_clear_homeowner_stamp(p_quote uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS 'UPDATE public.quotes SET homeowner_signed_at = NULL WHERE id = p_quote';
$def$;
BEGIN
  SELECT cl.id, cl.user_id, qt.id, qt.contractor_id, k.user_id INTO c, owner_id, q, k_id, k_user
    FROM public.claims cl
    JOIN public.profiles p ON p.id = cl.user_id
    JOIN public.quotes qt ON qt.claim_id = cl.id
    JOIN public.contractors k ON k.id = qt.contractor_id
   WHERE cl.is_test AND p.is_test AND qt.is_test AND k.is_test AND k.user_id IS NOT NULL
     AND cl.status = 'bidding' AND qt.status = 'submitted' AND qt.bid_status = 'active'
   ORDER BY qt.id LIMIT 1;
  IF c IS NULL THEN RAISE EXCEPTION 'fixture lookup failed: no is_test bidding claim with a submitted, active is_test quote'; END IF;

  -- put the fixture quote in a signed state (rolled back with everything else)
  reset_q := format('UPDATE public.quotes SET homeowner_signed_at = %L::timestamptz, contractor_signed_at = %L::timestamptz WHERE id = %L',
                    '2026-01-01 12:00:00+00', '2026-01-01 11:00:00+00', q);
  v := v || E'\nFIXTURES ' || format('claim=%s status=%s is_test=%s | quote=%s status=%s bid_status=%s is_test=%s | contractor=%s is_test=%s',
    left(c::text,8), (SELECT status FROM claims WHERE id=c), (SELECT is_test FROM claims WHERE id=c),
    left(q::text,8), (SELECT status FROM quotes WHERE id=q), (SELECT bid_status FROM quotes WHERE id=q), (SELECT is_test FROM quotes WHERE id=q),
    left(k_id::text,8), (SELECT is_test FROM contractors WHERE id=k_id));
  v := v || E'\nLIVE trigger present before=' || (EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_refuse_client_signature_change' AND NOT tgisinternal))::text
         || ' guard body_md5=' || left((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns'::regproc), 8);

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nBEFORE-1 NEGATIVE CONTROL owner sets homeowner_signed_at = NULL (defect, expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = NULL WHERE id = %L', q));
    v := v || format(' -> homeowner_signed_at=%s', (SELECT homeowner_signed_at FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nBEFORE-2 NEGATIVE CONTROL contractor sets contractor_signed_at = NULL (defect, expect ACCEPTED): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET contractor_signed_at = NULL WHERE id = %L', q));
    v := v || format(' -> contractor_signed_at=%s', (SELECT contractor_signed_at FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE format('UPDATE public.quotes SET homeowner_signed_at = NULL, contractor_signed_at = NULL WHERE id = %L', q);
    v := v || E'\nBEFORE-3 NEGATIVE CONTROL owner sets NULL homeowner_signed_at to a value (forged first stamp, expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = now() WHERE id = %L', q));
    v := v || E'\nBEFORE-3b NEGATIVE CONTROL contractor sets NULL contractor_signed_at to a value (expect ACCEPTED): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET contractor_signed_at = now() WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  EXECUTE fwd;
  v := v || E'\nFORWARD applied';

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-1 owner sets homeowner_signed_at = NULL (expect REJECTED 42501 ... (gh-2864)): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = NULL WHERE id = %L', q));
    v := v || format(' -> homeowner_signed_at=%s', (SELECT homeowner_signed_at FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-2 owner overwrites homeowner_signed_at (expect REJECTED 42501 ... (gh-2864)): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = now() WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-3 contractor sets contractor_signed_at = NULL (expect REJECTED 42501 ... (gh-2864)): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET contractor_signed_at = NULL WHERE id = %L', q));
    v := v || format(' -> contractor_signed_at=%s', (SELECT contractor_signed_at FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-4 contractor overwrites contractor_signed_at (expect REJECTED 42501 ... (gh-2864)): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET contractor_signed_at = now() WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-5a service_role clears both stamps (admin-reissue-contract path, expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = NULL, contractor_signed_at = NULL WHERE id = %L', q), 'service_role');
    v := v || format(' -> hs=%s cs=%s', (SELECT homeowner_signed_at FROM quotes WHERE id=q), (SELECT contractor_signed_at FROM quotes WHERE id=q));
    v := v || E'\nAFTER-5b service_role re-stamps both (docusign-webhook path, expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = now(), contractor_signed_at = now() WHERE id = %L', q), 'service_role');
    v := v || format(' -> hs set=%s cs set=%s', (SELECT homeowner_signed_at IS NOT NULL FROM quotes WHERE id=q), (SELECT contractor_signed_at IS NOT NULL FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    EXECUTE def_fn;
    v := v || E'\nAFTER-6 owner calls an owner-level SECURITY DEFINER function that clears homeowner_signed_at (expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('SELECT public.gh2864_proof_clear_homeowner_stamp(%L)', q));
    v := v || format(' -> homeowner_signed_at=%s', (SELECT homeowner_signed_at FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-7a NEGATIVE CONTROL owner re-sends the same homeowner_signed_at (expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = homeowner_signed_at WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    -- stamps cleared first (superuser, rolled back): #2863's quotes_refuse_signed_notes_change (live in production since
    -- ledger 20261019191903) refuses a client notes edit while a stamp is set, which is its rule, not this trigger's.
    EXECUTE reset_q;
    EXECUTE format('UPDATE public.quotes SET homeowner_signed_at = NULL, contractor_signed_at = NULL WHERE id = %L', q);
    v := v || E'\nAFTER-7b NEGATIVE CONTROL bid contractor edits notes on its own UNSIGNED quote (expect ACCEPTED): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET notes = ''gh2864 proof'' WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-7b2 INFORMATIONAL bid contractor edits notes on its own SIGNED quote (expect REJECTED 42501 from #2863''s notes freeze once it is live, which it is in production; ACCEPTED if #2863 is absent; this trigger does not touch notes): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET notes = ''gh2864 proof'' WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-7c NEGATIVE CONTROL owner declines the submitted quote (expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET status = ''declined'' WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE format('UPDATE public.quotes SET homeowner_signed_at = NULL, contractor_signed_at = NULL WHERE id = %L', q);
    v := v || E'\nAFTER-8 owner sets a NULL homeowner_signed_at to a value (expect REJECTED 42501 ... (gh-2864)): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET homeowner_signed_at = now() WHERE id = %L', q));
    v := v || E'\nAFTER-8b contractor sets a NULL contractor_signed_at to a value (expect REJECTED 42501 ... (gh-2864)): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET contractor_signed_at = now() WHERE id = %L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  v := v || E'\nAFTER-9 ' || (SELECT format('trigger=%s enabled=%s', t.tgname, t.tgenabled) FROM pg_trigger t
                             WHERE t.tgrelid = 'public.quotes'::regclass AND t.tgname = 'quotes_refuse_client_signature_change' AND NOT t.tgisinternal)
         || ' | ' || (SELECT format('prosecdef=%s search_path=%s acl=%s', prosecdef, proconfig::text, proacl::text)
                        FROM pg_proc WHERE oid = 'public.quotes_refuse_client_signature_change'::regproc);
  v := v || E'\nAFTER-9 guard function untouched: quotes_guard_homeowner_columns body_md5=' || left((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns'::regproc), 8)
         || ' (compare with the value printed under LIVE above)';

  RAISE EXCEPTION E'GH2864-PROOF\n%', v USING ERRCODE = 'P0U02';
END
$proof$;
