-- gh-2345 proof: server-side 30-day check on advance_referral_registered / claims_advance_referral.
-- Run the WHOLE file as ONE batch against production. It opens its own BEGIN and ends in ROLLBACK, so nothing survives.
-- NEVER change the ROLLBACK to COMMIT. Fixtures are is_test referrals rolled back with the transaction.
-- Phase 1 (control) runs on the PRE-FIX functions; the migration body is pasted at the marker; phase 2 runs on the fixed ones.
-- Note: referrals.created_at is NOT NULL, so the "undated" case cannot be built as a row; the NULL guard is by construction
-- (NULL >= x is NULL, so the UPDATE matches nothing).

BEGIN;

CREATE TEMP TABLE proof_results (case_id text, expected text, got text, pass boolean) ON COMMIT DROP;
CREATE TEMP TABLE proof_fx (name text primary key, id uuid) ON COMMIT DROP;
CREATE TEMP TABLE proof_claims (referral_id uuid) ON COMMIT DROP;
-- the real trigger function, attached to a temp table so it can be fired without a claims row
CREATE TRIGGER proof_trg AFTER INSERT ON proof_claims FOR EACH ROW EXECUTE FUNCTION public.claims_advance_referral();

DO $p$
DECLARE v_agent uuid; v_id uuid; n text;
BEGIN
  SELECT id INTO v_agent FROM public.referral_agents ORDER BY id LIMIT 1;
  FOREACH n IN ARRAY ARRAY['old_ctl','old_adv','new_adv','d29_adv','d31_adv','old_trg_clicked','old_trg_reg','new_trg','d29_trg','d31_trg'] LOOP
    INSERT INTO public.referrals (referral_agent_id, status, is_test)
    VALUES (v_agent, CASE WHEN n LIKE '%trg_reg' THEN 'registered' ELSE 'clicked' END, true) RETURNING id INTO v_id;
    UPDATE public.referrals SET created_at = now() - CASE
        WHEN n IN ('new_adv','new_trg') THEN interval '5 days'
        WHEN n IN ('d29_adv','d29_trg') THEN interval '29 days'
        WHEN n IN ('d31_adv','d31_trg') THEN interval '31 days'
        ELSE interval '45 days' END WHERE id = v_id;
    INSERT INTO proof_fx VALUES (n, v_id);
  END LOOP;
END $p$;

-- PHASE 1: negative control on the PRE-FIX function: a 45-day-old click DOES advance (this is the bug)
INSERT INTO proof_results
SELECT 'CTL pre-fix advance_referral_registered, 45d-old click', 'true (bug: advanced)',
       public.advance_referral_registered((SELECT id FROM proof_fx WHERE name='old_ctl'))::text, NULL;
UPDATE proof_results SET pass = (got = 'true') WHERE case_id LIKE 'CTL%' AND pass IS NULL;
INSERT INTO proof_results
SELECT 'CTL pre-fix row status after', 'registered', (SELECT status FROM public.referrals WHERE id=(SELECT id FROM proof_fx WHERE name='old_ctl')), NULL;
UPDATE proof_results SET pass = (got = 'registered') WHERE case_id = 'CTL pre-fix row status after';
INSERT INTO proof_claims SELECT id FROM proof_fx WHERE name='old_trg_clicked';
INSERT INTO proof_results
SELECT 'CTL pre-fix trigger fn, 45d-old clicked', 'claim_submitted (bug: advanced)', (SELECT status FROM public.referrals WHERE id=(SELECT id FROM proof_fx WHERE name='old_trg_clicked')), NULL;
UPDATE proof_results SET pass = (got = 'claim_submitted') WHERE case_id LIKE 'CTL pre-fix trigger%';
-- reset the trigger fixture so phase 2 re-tests it on the fixed function
UPDATE public.referrals SET status='clicked' WHERE id=(SELECT id FROM proof_fx WHERE name='old_trg_clicked');

-- >>> PASTE THE MIGRATION BODY HERE (supabase/migrations/20260929180000_gh2345_referral_rpc_age_check.sql, without its BEGIN/COMMIT) <<<
-- <<< END MIGRATION BODY

-- PHASE 2: fixed functions
CREATE TEMP TABLE proof_before ON COMMIT DROP AS
  SELECT f.name, r.status, r.homeowner_email, r.created_at FROM proof_fx f JOIN public.referrals r ON r.id=f.id;

INSERT INTO proof_results VALUES ('B1 fixed advance, 45d-old click', 'false', public.advance_referral_registered((SELECT id FROM proof_fx WHERE name='old_adv'))::text, NULL);
INSERT INTO proof_results VALUES ('B2 fixed advance, 5d-old click', 'true', public.advance_referral_registered((SELECT id FROM proof_fx WHERE name='new_adv'))::text, NULL);
INSERT INTO proof_results VALUES ('B3 fixed advance, 29d-old click', 'true', public.advance_referral_registered((SELECT id FROM proof_fx WHERE name='d29_adv'))::text, NULL);
INSERT INTO proof_results VALUES ('B4 fixed advance, 31d-old click', 'false', public.advance_referral_registered((SELECT id FROM proof_fx WHERE name='d31_adv'))::text, NULL);
INSERT INTO proof_results VALUES ('B5 fixed advance, NULL id', 'false', public.advance_referral_registered(NULL)::text, NULL);
INSERT INTO proof_results VALUES ('B6 fixed advance, unknown id', 'false', public.advance_referral_registered(gen_random_uuid())::text, NULL);
UPDATE proof_results SET pass = (got = split_part(expected,' ',1)) WHERE case_id LIKE 'B%';

INSERT INTO proof_claims SELECT id FROM proof_fx WHERE name IN ('old_trg_clicked','old_trg_reg','new_trg','d29_trg','d31_trg');

INSERT INTO proof_results
SELECT 'T'||x.k||' '||x.name||' after trigger', x.expected, (SELECT status FROM public.referrals WHERE id=f.id), NULL
FROM (VALUES (1,'old_trg_clicked','clicked'),(2,'old_trg_reg','registered'),(3,'new_trg','claim_submitted'),(4,'d29_trg','claim_submitted'),(5,'d31_trg','clicked')) x(k,name,expected)
JOIN proof_fx f ON f.name=x.name;
UPDATE proof_results SET pass = (got = expected) WHERE case_id LIKE 'T%';

-- unchanged-row proof for the refused cases (status, email, created_at identical to before)
INSERT INTO proof_results
SELECT 'U refused rows unchanged (old_adv, d31_adv, old_trg_clicked, old_trg_reg, d31_trg)', '5 unchanged',
       count(*) FILTER (WHERE r.status=b.status AND r.homeowner_email IS NOT DISTINCT FROM b.homeowner_email AND r.created_at=b.created_at)||' unchanged', NULL
FROM proof_before b JOIN proof_fx f ON f.name=b.name JOIN public.referrals r ON r.id=f.id
WHERE b.name IN ('old_adv','d31_adv','old_trg_clicked','old_trg_reg','d31_trg');
UPDATE proof_results SET pass = (got = expected) WHERE case_id LIKE 'U %';

-- signature / security / ACL preserved
INSERT INTO proof_results
SELECT 'S '||p.oid::regprocedure::text, 'secdef=true cfg=search_path=public, pg_temp',
       'secdef='||p.prosecdef||' cfg='||array_to_string(p.proconfig,','), NULL FROM pg_proc p
WHERE proname IN ('advance_referral_registered','claims_advance_referral');
UPDATE proof_results SET pass = (got = expected) WHERE case_id LIKE 'S %';
INSERT INTO proof_results VALUES ('ACL advance_referral_registered', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE proname='advance_referral_registered'), NULL);
INSERT INTO proof_results VALUES ('ACL claims_advance_referral', '{postgres=X/postgres,service_role=X/postgres}',
  (SELECT proacl::text FROM pg_proc WHERE proname='claims_advance_referral'), NULL);
INSERT INTO proof_results VALUES ('ACL referral_attribution_window (no client role may execute)', 'no anon/authenticated/service_role',
  CASE WHEN has_function_privilege('anon','public.referral_attribution_window()','EXECUTE') OR has_function_privilege('authenticated','public.referral_attribution_window()','EXECUTE') OR has_function_privilege('service_role','public.referral_attribution_window()','EXECUTE') THEN 'HAS CLIENT EXECUTE' ELSE 'no anon/authenticated/service_role' END, NULL);
UPDATE proof_results SET pass = (got = expected) WHERE case_id LIKE 'ACL %';

SELECT case_id, expected, got, pass FROM proof_results ORDER BY case_id;

ROLLBACK;
