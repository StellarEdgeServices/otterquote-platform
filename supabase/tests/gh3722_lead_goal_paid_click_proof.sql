-- gh-3722 (P12) apply proof, per REVIEW: FAIL 6898262141 (L3). NOT RUN BY THE AUTHOR.
-- Run as ONE psql batch (a client that prints every result; Supabase execute_sql prints only the last).
-- Paste the forward migration body and the rollback body WITHOUT their own BEGIN;/COMMIT; lines,
-- or the inner COMMIT will commit the change. The batch must end in ROLLBACK. Never COMMIT.
BEGIN;
-- A: paste supabase/migrations/20261115172000_gh3722_lead_goal_events_paid_click.sql (minus BEGIN;/COMMIT;)

SELECT string_agg(column_name||':'||data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns
 WHERE table_schema='public' AND table_name='lead_goal_events';
-- expect: lead_id ... goal_type, then lead_utm_source:text,lead_utm_medium:text,lead_has_click_id:boolean,lead_paid_click:boolean

SELECT reloptions, pg_get_userbyid(relowner), relacl FROM pg_class WHERE oid='public.lead_goal_events'::regclass;
-- expect {security_invoker=true}, postgres, postgres + service_role only

-- organic control (real lead)
SELECT lead_id, lead_utm_source, lead_utm_medium, lead_has_click_id, lead_paid_click, goal_type
  FROM public.lead_goal_events WHERE lead_id::text LIKE '147641e5%';
-- expect chatgpt.com / null / f / f / loss_sheet_upload

-- paid pass: UPDATE an existing synthetic lead that already has a view row (no INSERT, so no lead trigger fires)
UPDATE public.leads SET fbclid='gh3722-proof-fbclid', utm_medium='paid'
 WHERE id::text LIKE '0f45358a%' AND is_synthetic IS TRUE;
SELECT lead_id, lead_utm_medium, lead_has_click_id, lead_paid_click FROM public.lead_goal_events WHERE lead_id::text LIKE '0f45358a%';
-- expect paid / t / t

-- M1: gclid-only is paid
UPDATE public.leads SET fbclid=NULL, utm_medium=NULL, gclid='gh3722-proof-gclid'
 WHERE id::text LIKE '0f45358a%' AND is_synthetic IS TRUE;
SELECT lead_has_click_id, lead_paid_click FROM public.lead_goal_events WHERE lead_id::text LIKE '0f45358a%';  -- expect t / t

-- M2: native Meta lead-form lead is paid
UPDATE public.leads SET gclid=NULL, source='meta_leadgen', utm_source='meta', utm_medium='lead_form'
 WHERE id::text LIKE '0f45358a%' AND is_synthetic IS TRUE;
SELECT lead_has_click_id, lead_paid_click FROM public.lead_goal_events WHERE lead_id::text LIKE '0f45358a%';  -- expect f / t

SELECT count(*) FROM public.lead_goal_events;  -- expect 8 (same as before)

-- E: paste the rollback body (minus BEGIN;/COMMIT;)
SELECT md5(pg_get_viewdef('public.lead_goal_events'::regclass, true));  -- expect 7cdde879ab108d0683e1ac72cc147986
SELECT md5(obj_description('public.lead_goal_events'::regclass));      -- expect b7874ae428d3d5a95e9ed4495d212997
SELECT reloptions, pg_get_userbyid(relowner), relacl FROM pg_class WHERE oid='public.lead_goal_events'::regclass;  -- expect {postgres=arwdDxtm,service_role=arwdDxtm}
ROLLBACK;
