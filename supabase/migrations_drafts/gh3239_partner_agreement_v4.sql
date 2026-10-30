-- STATUS (gh-1438, as of 2026-10-30T15:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3239_partner_agreement_v4 (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3239; production read-only SELECTs the same day (project yeszghaspzwwstvsrioa), details below. No database was written.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and
--   pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-- Evidence detail (production read-only 2026-10-30):
--   register_partner(21 args) is SECURITY DEFINER, search_path public, pg_temp, EXECUTE to anon/authenticated/service_role,
--   md5(prosrc) = 042da30fdc75423c32383035b27f2fa4 (length 14758), byte-identical to the body in
--   supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql lines 318-622, and it holds exactly one
--   "v_agreement_version CONSTANT text := 'v3-2026-09';";
--   referral_agents: partner_agreement_version / partner_agreement_accepted_at / partner_agreement_attestation (jsonb keyed by version) /
--   needs_partner_reacceptance (gh-1059). authenticated holds table-level UPDATE and the "Agents can update own profile" policy, and neither
--   referral_agents_guard_payout_columns() nor referral_agents_guard_agent_type() pins the four agreement columns, so today a partner can
--   PATCH their own version, timestamp and attestation directly. No accept_partner_agreement_v4, partner_v4_accepted_at,
--   partner_agreement_current_version or referral_agents_guard_agreement_columns object exists. user_id has no duplicates (34 linked rows).
--   record_partner_agreement_reacceptance(uuid, text) exists (gh-1059) with no caller; this file does not touch it.
--
-- Migration: gh3239_partner_agreement_v4
-- GitHub: #3239 (PROJECT P18), refs #3238 (Amendment No. 1 rulings). Legal + money gate: Tier 3B / Tier C.
-- Needs REVIEW + LEGAL-READ + R-177 pair and Dustin's final publish OK. Applies only together with the partner-agreement.html v4 publish.
-- Rollback: gh3239_partner_agreement_v4_rollback.sql   Pre-flight: gh3239_partner_agreement_v4_pre-flight.md
-- Proof: supabase/tests/gh3239_partner_agreement_v4_proof.sql   Runner: supabase/tests/gh3239_partner_agreement_v4_proof_run.sh
--
-- What this file does
--   1. partner_agreement_current_version(): 'v4-2026-10', the one place the server names the current Partner Agreement version.
--   2. partner_v4_accepted_at(referral_agent_id): when that partner accepted v4 (the v4 key of partner_agreement_attestation, else
--      partner_agreement_accepted_at when the version column says v4), NULL if never. This is the accrual gate the #3236 $5 trigger calls.
--   3. register_partner(): new signups stamp v4-2026-10. The ONLY change is the v_agreement_version initializer, rewritten in place from
--      the live definition after an md5 guard (any drift from the audited body aborts the whole file). A home_inspector signup keeps
--      v3-2026-09, because that track accepts partner-agreement-inspector.html (D-278 exception), which Amendment No. 1 does not amend yet.
--      The service_role (Meta webhook) path still stamps nothing.
--   4. accept_partner_agreement_v4(): the dashboard / refer-a-friend "I accept". SECURITY DEFINER, search_path pinned, caller from
--      auth.uid() only (no argument). Stamps version, timestamp and an IP/UA attestation under the v4 key (the v3 key is kept), clears
--      needs_partner_reacceptance. Idempotent: a second click returns the first acceptance's timestamp and writes nothing.
--      Refuses a home_inspector (see 3). Until a partner calls it, their row stays on v3 (no write of any kind happens to it).
--   5. referral_agents_guard_agreement_columns: BEFORE UPDATE trigger. A direct anon/authenticated UPDATE (PostgREST PATCH) may not change
--      the four agreement columns; only SECURITY DEFINER functions (which run as their owner) and service_role can. Without it, a partner
--      could write v4 and a back-dated timestamp straight into their own row and pass the $5 accrual gate.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 0. guard: the live register_partner() must be the audited body (or this file's own v4 rewrite of it, for a re-run) ----------------------
DO $guard$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'gh3239 guard: register_partner(21 args) not found';
  END IF;
  IF v_md5 NOT IN ('042da30fdc75423c32383035b27f2fa4',   -- audited v3 body (production 2026-10-30)
                   'f4affeb5b17e2b4d242ce452686ada4d') THEN -- this file's v4 rewrite of that body (re-run)
    RAISE EXCEPTION 'gh3239 guard: register_partner() body drifted (md5 %); re-audit before applying', v_md5;
  END IF;
END
$guard$;

-- 1. current version ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_agreement_current_version()
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 'v4-2026-10'::text
$function$;

COMMENT ON FUNCTION public.partner_agreement_current_version() IS
  'gh-3239 (#3238): the current Partner Agreement version (partner-agreement.html). v3-2026-09 is archived at partner-agreement-v3.html.';

REVOKE ALL ON FUNCTION public.partner_agreement_current_version() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_agreement_current_version() TO authenticated, service_role;

-- 2. accrual gate helper ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_v4_accepted_at(p_referral_agent_id uuid)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_version text;
  v_at      timestamptz;
  v_att     jsonb;
BEGIN
  SELECT ra.partner_agreement_version, ra.partner_agreement_accepted_at, ra.partner_agreement_attestation
    INTO v_version, v_at, v_att
    FROM public.referral_agents ra
   WHERE ra.id = p_referral_agent_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF v_att ? 'v4-2026-10' AND NULLIF(v_att -> 'v4-2026-10' ->> 'accepted_at', '') IS NOT NULL THEN
      RETURN (v_att -> 'v4-2026-10' ->> 'accepted_at')::timestamptz;
    END IF;
  EXCEPTION WHEN others THEN
    NULL;                                          -- malformed stamp: fall through to the flat columns
  END;
  RETURN CASE WHEN v_version = 'v4-2026-10' THEN v_at END;
END;
$function$;

COMMENT ON FUNCTION public.partner_v4_accepted_at(uuid) IS
  'gh-3239 (#3238): when the partner accepted Partner Agreement v4-2026-10, or NULL. The $5 measurement fee accrues only when this is NOT NULL and not after the purchase (proposed gate for the #3236 trigger partner_fee_accrue_on_order).';

REVOKE ALL ON FUNCTION public.partner_v4_accepted_at(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_v4_accepted_at(uuid) TO service_role;

-- 3. register_partner(): stamp v4 at signup (one initializer, rewritten in place) ---------------------------------------------------------
DO $rewrite$
DECLARE
  v_oid oid := to_regprocedure('public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)');
  v_old text := $o$  v_agreement_version CONSTANT text := 'v3-2026-09';$o$;
  v_new text := $n$  v_agreement_version CONSTANT text := CASE WHEN p_agent_type = 'home_inspector' THEN 'v3-2026-09' ELSE 'v4-2026-10' END;  -- gh-3239: v4 for every fee-bearing type; home_inspector accepts partner-agreement-inspector.html (v3-2026-09, D-278)$n$;
  v_def text;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF position(v_new IN v_def) > 0 THEN
    RETURN;                                        -- already rewritten (re-run)
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'gh3239: expected exactly one v3-2026-09 initializer in register_partner()';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);            -- CREATE OR REPLACE keeps owner, ACL, SECURITY DEFINER and search_path
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'f4affeb5b17e2b4d242ce452686ada4d' THEN
    RAISE EXCEPTION 'gh3239: register_partner() rewrite produced an unexpected body';
  END IF;
END
$rewrite$;

-- 4. existing-partner / customer click-to-accept ----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_partner_agreement_v4()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_version  CONSTANT text := 'v4-2026-10';
  v_rows     integer;
  v_inspect  integer;
  v_prior    timestamptz;
  v_at       timestamptz := now();
  v_headers  jsonb;
  v_ip       text;
  v_ua       text;
  v_n        integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  -- the caller's own rows only, locked so two clicks serialize
  SELECT count(*), count(*) FILTER (WHERE ra.agent_type = 'home_inspector'),
         min((ra.partner_agreement_attestation -> v_version ->> 'accepted_at')::timestamptz)
    INTO v_rows, v_inspect, v_prior
    FROM (SELECT * FROM public.referral_agents WHERE user_id = v_uid FOR UPDATE) ra;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'no_partner_record' USING ERRCODE = 'P0002';
  END IF;
  IF v_inspect = v_rows THEN
    -- the inspector track accepts partner-agreement-inspector.html, which Amendment No. 1 does not amend yet
    RAISE EXCEPTION 'inspector_agreement_not_amended' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;
  v_headers := COALESCE(v_headers, '{}'::jsonb);
  -- same source and expression as register_partner()'s attestation, so every acceptance record is captured one way
  v_ip := COALESCE(
    NULLIF(split_part(v_headers->>'x-forwarded-for', ',', 1), ''),
    v_headers->>'cf-connecting-ip',
    v_headers->>'x-real-ip'
  );
  v_ua := v_headers->>'user-agent';

  UPDATE public.referral_agents
     SET partner_agreement_version     = v_version,
         partner_agreement_accepted_at = v_at,
         needs_partner_reacceptance    = false,
         partner_agreement_attestation = COALESCE(partner_agreement_attestation, '{}'::jsonb)
           || jsonb_build_object(v_version, jsonb_build_object('accepted_ip', v_ip, 'accepted_ua', v_ua, 'accepted_at', v_at, 'method', 'click_to_accept'))
   WHERE user_id = v_uid
     AND agent_type <> 'home_inspector'
     AND NOT (COALESCE(partner_agreement_attestation, '{}'::jsonb) ? v_version);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN jsonb_build_object(
    'agreement_version', v_version,
    'accepted_at',       CASE WHEN v_n = 0 THEN v_prior ELSE v_at END,
    'already_accepted',  v_n = 0
  );
END;
$function$;

COMMENT ON FUNCTION public.accept_partner_agreement_v4() IS
  'gh-3239 (#3238): the signed-in partner (or refer-a-friend customer) accepts Partner Agreement v4-2026-10. Caller from auth.uid() only. Writes version, timestamp and an IP/UA attestation under the v4 key; keeps earlier keys; idempotent.';

REVOKE ALL ON FUNCTION public.accept_partner_agreement_v4() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_partner_agreement_v4() TO authenticated;

-- 5. column lock: agreement columns change only through a SECURITY DEFINER function or service_role --------------------------------------
CREATE OR REPLACE FUNCTION public.referral_agents_guard_agreement_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- inside a SECURITY DEFINER function current_user is the function owner, so register_partner(), claim_partner_account(),
  -- accept_partner_agreement_v4() and record_partner_agreement_reacceptance() pass; a PostgREST PATCH runs as anon/authenticated.
  -- An admin session is authenticated too and is refused here: an acceptance record is never hand-edited from the browser.
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND COALESCE(
           (NEW.partner_agreement_version     IS DISTINCT FROM OLD.partner_agreement_version)
        OR (NEW.partner_agreement_accepted_at IS DISTINCT FROM OLD.partner_agreement_accepted_at)
        OR (NEW.partner_agreement_attestation IS DISTINCT FROM OLD.partner_agreement_attestation)
        OR (NEW.needs_partner_reacceptance    IS DISTINCT FROM OLD.needs_partner_reacceptance),
           true) THEN
    RAISE EXCEPTION 'referral_agents: partner agreement columns change only through accept_partner_agreement_v4() or service_role (gh-3239)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.referral_agents_guard_agreement_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS referral_agents_guard_agreement_columns ON public.referral_agents;
CREATE TRIGGER referral_agents_guard_agreement_columns
  BEFORE UPDATE ON public.referral_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.referral_agents_guard_agreement_columns();

COMMIT;
