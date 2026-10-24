-- Proof for 20261019224248_gh2154_internal_test_email_add_otterquote_com (#2154).
-- For the APPLIER, run AFTER the forward migration, as ONE batch, as the table owner. BEGIN ... ROLLBACK only.
-- The AFTER INSERT alert trigger is disabled inside the transaction so fixtures cannot queue an admin alert.
-- Negative control: the same INSERT with referral_agents_set_is_test_internal DISABLED must be born is_test=false.
-- EXPECTED: NOTICE 'gh2154 positive OK', NOTICE 'gh2154 negative control OK', then after.ra_total = before.ra_total.
BEGIN;

SELECT 'before' AS phase, count(*) AS ra_total FROM public.referral_agents;

ALTER TABLE public.referral_agents DISABLE TRIGGER trg_notify_admin_new_partner;

DO $p$
DECLARE v_got boolean;
BEGIN
  INSERT INTO public.referral_agents (agent_type, first_name, last_name, email)
  VALUES ('re_agent', 'Proof', 'Gh2154', 'sloane+gh2154proof@otterquote.com') RETURNING is_test INTO v_got;
  IF v_got IS NOT TRUE THEN RAISE EXCEPTION 'gh2154 proof: otterquote.com row born is_test=%', v_got; END IF;

  INSERT INTO public.referral_agents (agent_type, first_name, last_name, email)
  VALUES ('re_agent', 'Proof', 'Gh2154', 'gh2154proof@otterquote.com.evil.io') RETURNING is_test INTO v_got;
  IF v_got IS DISTINCT FROM false THEN RAISE EXCEPTION 'gh2154 proof: lookalike domain born is_test=%', v_got; END IF;

  INSERT INTO public.referral_agents (agent_type, first_name, last_name, email)
  VALUES ('re_agent', 'Proof', 'Gh2154', 'gh2154proof@otterquotes.com') RETURNING is_test INTO v_got;
  IF v_got IS DISTINCT FROM false THEN RAISE EXCEPTION 'gh2154 proof: otterquotes.com born is_test=%', v_got; END IF;
  RAISE NOTICE 'gh2154 positive OK';
END
$p$;

ALTER TABLE public.referral_agents DISABLE TRIGGER referral_agents_set_is_test_internal;
DO $n$
DECLARE v_got boolean;
BEGIN
  INSERT INTO public.referral_agents (agent_type, first_name, last_name, email)
  VALUES ('re_agent', 'Proof', 'Gh2154', 'sloane+gh2154neg@otterquote.com') RETURNING is_test INTO v_got;
  IF v_got IS DISTINCT FROM false THEN RAISE EXCEPTION 'gh2154 negative control failed: born is_test=% with the trigger disabled', v_got; END IF;
  RAISE NOTICE 'gh2154 negative control OK';
END
$n$;

ROLLBACK;

SELECT 'after' AS phase, count(*) AS ra_total,
       count(*) FILTER (WHERE email LIKE '%gh2154proof%' OR email LIKE '%gh2154neg%') AS fixtures_left
FROM public.referral_agents;
