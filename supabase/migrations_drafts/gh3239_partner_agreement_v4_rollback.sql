-- STATUS (gh-1438, as of 2026-10-30T15:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3239_partner_agreement_v4 (forward and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-30 under #3239; production read-only SELECTs (see the forward file). No database was written.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Exact rollback of gh3239_partner_agreement_v4.sql:
--   - register_partner() goes back to the audited v3 body; the file checks md5(prosrc) = 042da30fdc75423c32383035b27f2fa4 afterwards
--     (byte-identical to production on 2026-10-30), so a partial or wrong restore aborts.
--   - the trigger and the four functions the forward created are dropped.
-- DATA IS KEPT ON PURPOSE: acceptances already recorded (partner_agreement_version = 'v4-2026-10', the v4 key of
--   partner_agreement_attestation) are records of consent a partner gave and are not erased. After a rollback those partners still
--   read as v4 in their rows; partner-agreement-v3.html and partner-agreement.html stay published, so each recorded version still
--   resolves to its text.
-- ORDER: if the #3236 accrual gate (which calls partner_v4_accepted_at) is applied, roll that gate back FIRST. A plpgsql caller records
--   no dependency, so DROP would succeed and the gated trigger would then log a WARNING and accrue nothing on every order.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS referral_agents_guard_agreement_columns ON public.referral_agents;
DROP FUNCTION IF EXISTS public.referral_agents_guard_agreement_columns();
DROP FUNCTION IF EXISTS public.accept_partner_agreement_v4();
DROP FUNCTION IF EXISTS public.partner_v4_accepted_at(uuid);
DROP FUNCTION IF EXISTS public.partner_agreement_current_version();

DO $restore$
DECLARE
  v_oid oid := to_regprocedure('public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)');
  v_v3  text := $o$  v_agreement_version CONSTANT text := 'v3-2026-09';$o$;
  v_v4  text := $n$  v_agreement_version CONSTANT text := CASE WHEN p_agent_type = 'home_inspector' THEN 'v3-2026-09' ELSE 'v4-2026-10' END;  -- gh-3239: v4 for every fee-bearing type; home_inspector accepts partner-agreement-inspector.html (v3-2026-09, D-278)$n$;
  v_def text;
  v_md5 text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'gh3239 rollback: register_partner(21 args) not found';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
  IF v_md5 = 'f4affeb5b17e2b4d242ce452686ada4d' THEN
    v_def := pg_get_functiondef(v_oid);
    EXECUTE replace(v_def, v_v4, v_v3);
  ELSIF v_md5 <> '042da30fdc75423c32383035b27f2fa4' THEN
    RAISE EXCEPTION 'gh3239 rollback: register_partner() is neither the gh3239 body nor the audited v3 body (md5 %); restore by hand', v_md5;
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> '042da30fdc75423c32383035b27f2fa4' THEN
    RAISE EXCEPTION 'gh3239 rollback: register_partner() restore did not produce the audited v3 body';
  END IF;
END
$restore$;

COMMIT;
