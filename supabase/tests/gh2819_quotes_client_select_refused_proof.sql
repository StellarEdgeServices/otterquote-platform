-- gh-2819 proof: a homeowner session can no longer set quotes.status = 'selected' directly; accept_bid() still can.
-- NOT RUN when written (no database access); run by Marty against production (yeszghaspzwwstvsrioa) as a superuser/owner role.
-- A single DO block whose last action is a deliberate RAISE EXCEPTION, so the forward DDL and every fixture write roll back
-- whatever the client does; the findings are the exception text. The text between the $fwd$ markers is the body of
-- supabase/migrations_drafts/gh2819_quotes_client_select_refused.sql without its header, apply gate and BEGIN/COMMIT lines
-- (regenerate if that file changes).
-- Fixtures are looked up at run time (nothing hard-coded): an is_test homeowner's is_test claim in 'bidding' that has a quote,
-- and an is_test contractor with has_payment_method = true (k_pm), to which the quote is moved by a rolled-back superuser write.
-- Phases (each attempt runs as role authenticated with the caller's JWT sub, in its own savepoint):
--   BEFORE  live schema  : owner sets the submitted, active quote to 'selected' directly -> expect ACCEPTED (the defect, the negative control)
--   FORWARD applied
--   AFTER-1 owner direct status='selected'           -> expect REJECTED 42501 ending (gh-2819)   [flips #2620 proof line AFTER-5b]
--   AFTER-2 accept_bid() RPC as the owner            -> expect ACCEPTED, claim awarded, quote selected [#2620 proof line AFTER-6 stays ACCEPTED]
--   AFTER-3 negative control: owner declines the submitted quote           -> expect ACCEPTED (unchanged behaviour)
--   AFTER-4 negative control: bid contractor edits notes on its own quote  -> expect ACCEPTED (unchanged behaviour)
--   AFTER-5 negative control: a non-client write (this session, owner role) to selected -> expect ACCEPTED (trigger does not touch it)
--   AFTER-6 trigger and function metadata

CREATE FUNCTION pg_temp.try_as(p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated', 'email', 'gh2819-proof@example.invalid')::text, true);
  PERFORM set_config('role', 'authenticated', true);
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
  owner_id uuid; c uuid; q uuid; k_pm uuid; k_user uuid;
  fwd text := $fwd$
CREATE OR REPLACE FUNCTION public.quotes_refuse_client_select_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false)
     AND NEW.status = 'selected'
     AND OLD.status IS DISTINCT FROM 'selected' THEN
    RAISE EXCEPTION 'quotes: a bid can only be marked selected by accept_bid(); a direct status write is refused (gh-2819)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.quotes_refuse_client_select_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS quotes_refuse_client_select_status ON public.quotes;

CREATE TRIGGER quotes_refuse_client_select_status
  BEFORE UPDATE ON public.quotes
  FOR EACH ROW
  WHEN (NEW.status = 'selected' AND OLD.status IS DISTINCT FROM 'selected')
  EXECUTE FUNCTION public.quotes_refuse_client_select_status();
$fwd$;
  reset_q text;
BEGIN
  SELECT cl.id, cl.user_id, qt.id INTO c, owner_id, q
    FROM public.claims cl JOIN public.profiles p ON p.id = cl.user_id JOIN public.quotes qt ON qt.claim_id = cl.id
   WHERE cl.is_test AND p.is_test AND qt.is_test AND cl.status = 'bidding'
   ORDER BY cl.id LIMIT 1;
  SELECT id, user_id INTO k_pm, k_user FROM public.contractors WHERE is_test AND has_payment_method IS TRUE ORDER BY id LIMIT 1;
  IF c IS NULL OR k_pm IS NULL THEN RAISE EXCEPTION 'fixture lookup failed: claim=% k_pm=%', c, k_pm; END IF;

  -- put the fixture quote in the shape the guard admits for an owner select: submitted, bid_status active, bid by k_pm
  reset_q := format('UPDATE public.quotes SET contractor_id=%L, status=''submitted'', bid_status=''active'' WHERE id=%L', k_pm, q);
  v := v || E'\nFIXTURES ' || format('claim=%s status=%s is_test=%s | quote=%s is_test=%s | k_pm=%s is_test=%s has_pm=%s',
    left(c::text,8), (SELECT status FROM claims WHERE id=c), (SELECT is_test FROM claims WHERE id=c),
    left(q::text,8), (SELECT is_test FROM quotes WHERE id=q),
    left(k_pm::text,8), (SELECT is_test FROM contractors WHERE id=k_pm), (SELECT has_payment_method FROM contractors WHERE id=k_pm));
  v := v || E'\nLIVE trigger present before=' || (EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND tgname = 'quotes_refuse_client_select_status' AND NOT tgisinternal))::text
         || ' accept_bid prosecdef=' || (SELECT prosecdef FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure)::text;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nBEFORE-1 NEGATIVE CONTROL owner direct status=selected (defect, expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q));
    v := v || format(' -> claim.status=%s quote.status=%s', (SELECT status FROM claims WHERE id=c), (SELECT status FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  EXECUTE fwd;
  v := v || E'\nFORWARD applied';

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-1 owner direct status=selected (expect REJECTED 42501 ... (gh-2819)): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', q));
    v := v || format(' -> claim.status=%s quote.status=%s', (SELECT status FROM claims WHERE id=c), (SELECT status FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-2 accept_bid() RPC as owner (expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('SELECT * FROM public.accept_bid(%L, %L)', c, q));
    v := v || format(' -> claim.status=%s quote.status=%s', (SELECT status FROM claims WHERE id=c), (SELECT status FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-3 NEGATIVE CONTROL owner declines the submitted quote (expect ACCEPTED): '
           || pg_temp.try_as(owner_id, format('UPDATE public.quotes SET status=''declined'' WHERE id=%L', q));
    v := v || format(' -> quote.status=%s', (SELECT status FROM quotes WHERE id=q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    v := v || E'\nAFTER-4 NEGATIVE CONTROL bid contractor edits notes on its own quote (expect ACCEPTED): '
           || pg_temp.try_as(k_user, format('UPDATE public.quotes SET notes=''gh2819 proof'' WHERE id=%L', q));
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  BEGIN
    EXECUTE reset_q;
    BEGIN
      UPDATE public.quotes SET status = 'selected' WHERE id = q;
      v := v || E'\nAFTER-5 NEGATIVE CONTROL non-client write to selected as ' || current_user || ' (expect ACCEPTED): ACCEPTED';
    EXCEPTION WHEN OTHERS THEN
      v := v || E'\nAFTER-5 NEGATIVE CONTROL non-client write to selected as ' || current_user || ' (expect ACCEPTED): REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 160);
    END;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  v := v || E'\nAFTER-6 ' || (SELECT format('trigger=%s enabled=%s', t.tgname, t.tgenabled) FROM pg_trigger t
                             WHERE t.tgrelid = 'public.quotes'::regclass AND t.tgname = 'quotes_refuse_client_select_status' AND NOT t.tgisinternal)
         || ' | ' || (SELECT format('prosecdef=%s search_path=%s acl=%s', prosecdef, proconfig::text, proacl::text)
                        FROM pg_proc WHERE oid = 'public.quotes_refuse_client_select_status'::regproc);
  v := v || E'\nAFTER-6 guard function untouched: quotes_guard_homeowner_columns body_md5=' || left((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns'::regproc), 8)
         || ' (compare with the value read before this run)';

  RAISE EXCEPTION E'GH2819-PROOF\n%', v USING ERRCODE = 'P0U02';
END
$proof$;
