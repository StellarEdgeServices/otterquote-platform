-- gh-3428 proof, run by gh3428_owner_alert_sweep_proof_run.sh against a THROWAWAY Postgres, in four phases (the runner sets :phase to BEFORE, AFTER, ROLLBACK or REAPPLIED).
-- Output: one line per check "PASS|FAIL name", then "FAILING=n of m". Production is never connected.
\set ON_ERROR_STOP off
CREATE TEMP TABLE chk (n serial, name text, ok boolean);
CREATE OR REPLACE FUNCTION pg_temp.ck(p_name text, p_ok boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO chk(name,ok) VALUES (p_name, COALESCE(p_ok,false)) $$;
\if :{?phase}
\else
\set phase NONE
\endif
SELECT :'phase' IN ('AFTER','REAPPLIED') AS installed \gset
SELECT :'phase' = 'AFTER' AS first_after \gset

\if :installed
-- ---- structure and privileges ----
SELECT pg_temp.ck('table owner_alerts exists', to_regclass('public.owner_alerts') IS NOT NULL);
SELECT pg_temp.ck('unique (event_kind, source_id) exists', EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.owner_alerts'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE 'UNIQUE (event_kind, source_id)'));
SELECT pg_temp.ck('RLS on', (SELECT relrowsecurity FROM pg_class WHERE oid='public.owner_alerts'::regclass));
SELECT pg_temp.ck('anon/authenticated have no table privilege', NOT has_table_privilege('anon','public.owner_alerts','SELECT') AND NOT has_table_privilege('authenticated','public.owner_alerts','SELECT')
  AND NOT has_table_privilege('anon','public.owner_alerts','INSERT') AND NOT has_table_privilege('authenticated','public.owner_alerts','UPDATE'));
SELECT pg_temp.ck('service_role has full table privilege', has_table_privilege('service_role','public.owner_alerts','SELECT') AND has_table_privilege('service_role','public.owner_alerts','INSERT')
  AND has_table_privilege('service_role','public.owner_alerts','UPDATE') AND has_table_privilege('service_role','public.owner_alerts','DELETE'));
SELECT pg_temp.ck('EXECUTE probe '||f, NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE') AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
  AND has_function_privilege('service_role', f::regprocedure, 'EXECUTE'))
FROM unnest(ARRAY['public.owner_alert_claim_batch(integer,interval,interval,integer)','public.owner_alert_mark(uuid,boolean,text,text,integer)','public.owner_alert_is_internal(uuid)']) f;
-- Role probes: the verdict is carried in a GUC so the unprivileged role never has to write the check table.
SET ROLE anon;
DO $$ BEGIN PERFORM public.owner_alert_claim_batch(); PERFORM set_config('proof.v','allowed',false); EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('proof.v','denied',false); END $$;
RESET ROLE;
SELECT pg_temp.ck('anon cannot call claim_batch', current_setting('proof.v')='denied');
SET ROLE authenticated;
DO $$ BEGIN PERFORM public.owner_alert_claim_batch(); PERFORM set_config('proof.v','allowed',false); EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('proof.v','denied',false); END $$;
RESET ROLE;
SELECT pg_temp.ck('authenticated cannot call claim_batch', current_setting('proof.v')='denied');
SET ROLE authenticated;
DO $$ BEGIN PERFORM 1 FROM public.owner_alerts; PERFORM set_config('proof.v','allowed',false); EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('proof.v','denied',false); END $$;
RESET ROLE;
SELECT pg_temp.ck('authenticated cannot read owner_alerts', current_setting('proof.v')='denied');
SET ROLE anon;
DO $$ BEGIN PERFORM public.owner_alert_mark('00000000-0000-0000-0000-000000000000', true, 'x', null); PERFORM set_config('proof.v','allowed',false); EXCEPTION WHEN insufficient_privilege THEN PERFORM set_config('proof.v','denied',false); END $$;
RESET ROLE;
SELECT pg_temp.ck('anon cannot call owner_alert_mark', current_setting('proof.v')='denied');

-- ---- baseline: what existed before install never rings ----
SELECT pg_temp.ck('baseline rows exist for the pre-existing claim and order', (SELECT count(*) FROM public.owner_alerts WHERE status='baseline') >= 2);
CREATE TEMP TABLE b0 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('first sweep after install rings nothing (baseline)', (SELECT count(*) FROM b0)=0);

\if :first_after
-- ---- post-install events ----
-- Qualifying: a real buyer pays for measurements on a real claim, and a real claim enters bidding.
INSERT INTO public.claims (id,user_id,status,ready_for_bids,property_state,is_test) VALUES ('00000000-0000-0000-0000-00000000c101','00000000-0000-0000-0000-0000000000a6','active',true,'OH',false);
INSERT INTO public.hover_orders (id,claim_id,user_id,status,product_code,requested_by_role,homeowner_stripe_payment_intent_id)
  VALUES ('00000000-0000-0000-0000-00000000b101','00000000-0000-0000-0000-00000000c101','00000000-0000-0000-0000-0000000000a6','awaiting_fulfillment','roof_basic','homeowner','pi_real');
-- Negative controls, one reason each. None may ring or even be recorded.
INSERT INTO public.claims (id,user_id,status,ready_for_bids,property_state,is_test) VALUES
  ('00000000-0000-0000-0000-00000000c201','00000000-0000-0000-0000-0000000000a6','active',true,'OH',true),            -- N1 claims.is_test
  ('00000000-0000-0000-0000-00000000c202','00000000-0000-0000-0000-0000000000a2','active',true,'OH',false),           -- N2 profiles.is_test (owner)
  ('00000000-0000-0000-0000-00000000c203','00000000-0000-0000-0000-0000000000a3','active',true,'OH',false),           -- N3 unflagged staff domain (gh-3197 gap)
  ('00000000-0000-0000-0000-00000000c204','00000000-0000-0000-0000-0000000000a4','active',true,'OH',false),           -- N4 unflagged staff gmail plus-address
  ('00000000-0000-0000-0000-00000000c205','00000000-0000-0000-0000-0000000000a5','active',true,'OH',false),           -- N5 unflagged otterquote.com
  ('00000000-0000-0000-0000-00000000c206','00000000-0000-0000-0000-0000000000a6','draft',false,'OH',false),           -- N6 not in the bid process
  ('00000000-0000-0000-0000-00000000c207','00000000-0000-0000-0000-0000000000a6','documents_needed',false,'OH',false),-- N7 not in the bid process
  ('00000000-0000-0000-0000-00000000c208','00000000-0000-0000-0000-0000000000a6','contract_signed',true,'OH',false),  -- N8 past the bid process
  ('00000000-0000-0000-0000-00000000c209','00000000-0000-0000-0000-0000000000a6','active',true,'OH',false);           -- parent of the order-side negatives below (itself qualifies as a claim)
INSERT INTO public.hover_orders (id,claim_id,user_id,status,product_code,requested_by_role,requested_by_contractor_id,homeowner_stripe_payment_intent_id) VALUES
  ('00000000-0000-0000-0000-00000000b201','00000000-0000-0000-0000-00000000c201','00000000-0000-0000-0000-0000000000a6','awaiting_fulfillment','roof_basic','homeowner',NULL,'pi_n1'),  -- N1 claim is_test
  ('00000000-0000-0000-0000-00000000b202','00000000-0000-0000-0000-00000000c209','00000000-0000-0000-0000-0000000000a2','awaiting_fulfillment','roof_basic','homeowner',NULL,'pi_n2'),  -- N2 buyer profile is_test
  ('00000000-0000-0000-0000-00000000b203','00000000-0000-0000-0000-00000000c209','00000000-0000-0000-0000-0000000000a3','awaiting_fulfillment','roof_basic','homeowner',NULL,'pi_n3'),  -- N3 unflagged staff buyer
  ('00000000-0000-0000-0000-00000000b204','00000000-0000-0000-0000-00000000c209','00000000-0000-0000-0000-0000000000a6','awaiting_quote',NULL,'contractor','00000000-0000-0000-0000-0000000000f1',NULL),  -- N9 contractor quote request, no payment
  ('00000000-0000-0000-0000-00000000b205','00000000-0000-0000-0000-00000000c209','00000000-0000-0000-0000-0000000000a6','awaiting_fulfillment','roof_upgrade_detailed','contractor','00000000-0000-0000-0000-0000000000f1','pi_n10'),  -- N10 contractor-bought upgrade
  ('00000000-0000-0000-0000-00000000b206','00000000-0000-0000-0000-00000000c209','00000000-0000-0000-0000-0000000000a6','awaiting_fulfillment','roof_basic','homeowner',NULL,NULL);   -- N11 no PaymentIntent recorded
-- The claim-side qualifying set is c101 and c209; the order-side qualifying set is b101 only.
CREATE TEMP TABLE b1 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('sweep 1 leases exactly 3 events (b101 order, c101 claim, c209 claim)', (SELECT count(*) FROM b1)=3
  AND EXISTS (SELECT 1 FROM b1 WHERE event_kind='measurement_paid' AND claim_id='00000000-0000-0000-0000-00000000c101' AND state='OH' AND attempts=1)
  AND EXISTS (SELECT 1 FROM b1 WHERE event_kind='claim_bidding' AND claim_id='00000000-0000-0000-0000-00000000c101')
  AND EXISTS (SELECT 1 FROM b1 WHERE event_kind='claim_bidding' AND claim_id='00000000-0000-0000-0000-00000000c209'));
SELECT pg_temp.ck('no row exists for ANY negative control (is_test x4 shapes, non-bidding x3, contractor/no-PI x4)',
  (SELECT count(*) FROM public.owner_alerts WHERE status<>'baseline') = 3
  AND NOT EXISTS (SELECT 1 FROM public.owner_alerts WHERE source_id IN (
     '00000000-0000-0000-0000-00000000c201','00000000-0000-0000-0000-00000000c202','00000000-0000-0000-0000-00000000c203','00000000-0000-0000-0000-00000000c204','00000000-0000-0000-0000-00000000c205',
     '00000000-0000-0000-0000-00000000c206','00000000-0000-0000-0000-00000000c207','00000000-0000-0000-0000-00000000c208',
     '00000000-0000-0000-0000-00000000b201','00000000-0000-0000-0000-00000000b202','00000000-0000-0000-0000-00000000b203','00000000-0000-0000-0000-00000000b204','00000000-0000-0000-0000-00000000b205','00000000-0000-0000-0000-00000000b206')));
-- Second sweep: nothing (leased), then mark one ok and sweep again: still nothing.
CREATE TEMP TABLE b2 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('second sweep places no second call while the first is leased', (SELECT count(*) FROM b2)=0);
SELECT pg_temp.ck('mark ok -> called', (SELECT public.owner_alert_mark(id,true,'CA_FAKE_SID_1',NULL) FROM b1 WHERE event_kind='measurement_paid')='called');
SELECT pg_temp.ck('mark ok on the other two', (SELECT count(*) FROM b1 WHERE public.owner_alert_mark(id,true,'CA_FAKE_SID_2',NULL) IS NOT NULL AND event_kind='claim_bidding')=2);
UPDATE public.owner_alerts SET next_attempt_at = now() - interval '1 hour';     -- age every lease and retry time
CREATE TEMP TABLE b3 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('sweep after success places no call (one call per event)', (SELECT count(*) FROM b3)=0);
DO $$ BEGIN
  INSERT INTO public.owner_alerts (event_kind, source_id, claim_id) VALUES ('claim_bidding','00000000-0000-0000-0000-00000000c101','00000000-0000-0000-0000-00000000c101');
  PERFORM pg_temp.ck('duplicate (event_kind, source_id) refused by the unique key', false);
EXCEPTION WHEN unique_violation THEN PERFORM pg_temp.ck('duplicate (event_kind, source_id) refused by the unique key', true); END $$;
-- Same claim, status moves active -> bidding (switch-contractor) and updated_at bumps: no second ring.
UPDATE public.claims SET status='bidding', updated_at=now() WHERE id='00000000-0000-0000-0000-00000000c101';
SELECT pg_temp.ck('active -> bidding on the same claim does not ring again', (SELECT count(*) FROM public.owner_alert_claim_batch())=0);
-- Pre-existing claim touched after install: baseline, no ring.
UPDATE public.claims SET status='bidding', updated_at=now() WHERE id='00000000-0000-0000-0000-00000000c001';
SELECT pg_temp.ck('pre-existing ready claim updated after install does not ring', (SELECT count(*) FROM public.owner_alert_claim_batch())=0);

-- ---- failure path: retry, cap, no secrets in the row ----
INSERT INTO public.claims (id,user_id,status,ready_for_bids,property_state,is_test) VALUES ('00000000-0000-0000-0000-00000000c301','00000000-0000-0000-0000-0000000000a6','active',true,NULL,false);
CREATE TEMP TABLE f1 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('failure case: new claim leased, attempts=1, null state carried', (SELECT count(*) FROM f1)=1 AND (SELECT attempts FROM f1)=1 AND (SELECT state FROM f1) IS NULL);
SELECT pg_temp.ck('mark failed (attempt 1 of 3) -> pending, retryable', (SELECT public.owner_alert_mark(id,false,NULL,'twilio_http_400_code_21211') FROM f1)='pending');
SELECT pg_temp.ck('retry not due yet: sweep returns nothing', (SELECT count(*) FROM public.owner_alert_claim_batch())=0);
UPDATE public.owner_alerts SET next_attempt_at = now() - interval '1 second' WHERE source_id='00000000-0000-0000-0000-00000000c301';
CREATE TEMP TABLE f2 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('retry due: leased again, attempts=2', (SELECT count(*) FROM f2)=1 AND (SELECT attempts FROM f2)=2);
SELECT pg_temp.ck('mark failed (attempt 2) -> pending', (SELECT public.owner_alert_mark(id,false,NULL,'twilio_http_500') FROM f2)='pending');
UPDATE public.owner_alerts SET next_attempt_at = now() - interval '1 second' WHERE source_id='00000000-0000-0000-0000-00000000c301';
CREATE TEMP TABLE f3 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('attempt 3 leased', (SELECT attempts FROM f3)=3);
SELECT pg_temp.ck('mark failed at the cap -> failed_final', (SELECT public.owner_alert_mark(id,false,NULL,'twilio_http_500') FROM f3)='failed_final');
UPDATE public.owner_alerts SET next_attempt_at = now() - interval '1 hour';
SELECT pg_temp.ck('a capped row never rings again', (SELECT count(*) FROM public.owner_alert_claim_batch())=0);
-- Crashed worker: lease expires with the cap not yet reached -> retried; at the cap -> final.
INSERT INTO public.claims (id,user_id,status,ready_for_bids,property_state,is_test) VALUES ('00000000-0000-0000-0000-00000000c302','00000000-0000-0000-0000-0000000000a6','active',true,'IN',false);
CREATE TEMP TABLE g1 AS SELECT * FROM public.owner_alert_claim_batch();
UPDATE public.owner_alerts SET next_attempt_at = now() - interval '1 second' WHERE source_id='00000000-0000-0000-0000-00000000c302';
SELECT pg_temp.ck('expired lease is retaken (worker died)', (SELECT attempts FROM public.owner_alert_claim_batch())=2);
UPDATE public.owner_alerts SET next_attempt_at = now() - interval '1 second', attempts=3 WHERE source_id='00000000-0000-0000-0000-00000000c302';
CREATE TEMP TABLE g2 AS SELECT * FROM public.owner_alert_claim_batch();
SELECT pg_temp.ck('expired lease at the cap goes final, no further call', (SELECT count(*) FROM g2)=0 AND (SELECT status FROM public.owner_alerts WHERE source_id='00000000-0000-0000-0000-00000000c302')='failed_final');
SELECT pg_temp.ck('mark on a row not in calling is a no-op (returns NULL)', (SELECT public.owner_alert_mark(id,true,'CA_X',NULL) FROM public.owner_alerts WHERE source_id='00000000-0000-0000-0000-00000000c101' AND event_kind='claim_bidding') IS NULL);
SELECT pg_temp.ck('owner_alerts holds no PII-shaped value (only ids, state, sid, fixed error codes)', NOT EXISTS (SELECT 1 FROM public.owner_alerts WHERE last_error ~ '[0-9]{10}' OR last_error ~ '@'));
-- Lookback: an order older than the lookback is not enqueued after install.
INSERT INTO public.hover_orders (id,claim_id,user_id,status,product_code,requested_by_role,homeowner_stripe_payment_intent_id,created_at)
  VALUES ('00000000-0000-0000-0000-00000000b401','00000000-0000-0000-0000-00000000c101','00000000-0000-0000-0000-0000000000a6','awaiting_fulfillment','roof_basic','homeowner','pi_old', now()-interval '3 days');
SELECT pg_temp.ck('an order older than the 24h lookback is not enqueued', (SELECT count(*) FROM public.owner_alert_claim_batch())=0 AND NOT EXISTS (SELECT 1 FROM public.owner_alerts WHERE source_id='00000000-0000-0000-0000-00000000b401'));
\endif

-- ---- cron file (if run): schedule text and command ----
SELECT pg_temp.ck('cron job row, if scheduled, is every 30 seconds and calls owner-alert-sweep with the vault key', NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='gh3428-owner-alert-sweep')
  OR (SELECT schedule='30 seconds' AND command LIKE '%/functions/v1/owner-alert-sweep%' AND command LIKE '%vault.decrypted_secrets%cron_service_role_key%' AND command !~ '[0-9]{10}' FROM cron.job WHERE jobname='gh3428-owner-alert-sweep'));
\else
-- BEFORE and ROLLBACK: everything is gone, and the existing tables are untouched.
SELECT pg_temp.ck('owner_alerts absent', to_regclass('public.owner_alerts') IS NULL);
SELECT pg_temp.ck('owner_alert functions absent', NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname LIKE 'owner_alert%'));
SELECT pg_temp.ck('cron job absent', NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='gh3428-owner-alert-sweep'));
\endif
SELECT pg_temp.ck('pre-existing rows intact (1 profile set of 6, 1 claim, 1 order at the start)', (SELECT count(*) FROM public.profiles)=6 AND EXISTS (SELECT 1 FROM public.claims WHERE id='00000000-0000-0000-0000-00000000c001') AND EXISTS (SELECT 1 FROM public.hover_orders WHERE id='00000000-0000-0000-0000-00000000b001'));
SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || name FROM chk ORDER BY n;
SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM chk;
