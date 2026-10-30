-- gh-3199 proof for submit_template_for_admin_review + the enforce_template_privileged_columns allowance.
-- SCRATCH database only (creates stub auth schema, roles, tables). Run via gh3199_submit_template_proof_run.sh, or:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/gh3199_submit_template_proof.sql scratchdb
-- Scratch DB only; the file ends in RAISE EXCEPTION 'PROOF-OK ...' which aborts the last open transaction (the included migration files COMMIT their own).
-- Trigger/function bodies of freeze_verdict, set_updated_at and request_is_privileged are the production definitions
-- (pg_get_functiondef, 2026-10-30); enforce_template_privileged_columns "before" is the rollback file's body.
\set ON_ERROR_STOP on
BEGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(auth.jwt() ->> 'email','') = 'owner@example.test' $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;

CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid, template_review_role text);
CREATE TABLE public.contractor_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contractor_id uuid NOT NULL REFERENCES public.contractors(id),
  trade text, funding_type text, pdf_storage_path text, status text, validation_result jsonb, manual_overrides jsonb,
  admin_notes text, reviewed_by uuid, reviewed_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
ALTER TABLE public.contractor_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY contractor_templates_admin ON public.contractor_templates FOR ALL USING (EXISTS (SELECT 1 FROM contractors WHERE contractors.user_id = (SELECT auth.uid()) AND contractors.template_review_role = 'admin'));
CREATE POLICY contractor_templates_self ON public.contractor_templates FOR ALL USING (contractor_id IN (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())));
GRANT SELECT, INSERT, UPDATE ON public.contractor_templates TO authenticated;
GRANT SELECT ON public.contractors TO authenticated;

CREATE OR REPLACE FUNCTION public.request_is_privileged() RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp' AS $f$
  SELECT current_setting('request.jwt.claims', true) IS NULL
      OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR public.is_admin_email();
$f$;
CREATE OR REPLACE FUNCTION public.contractor_templates_set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $f$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $f$;
CREATE OR REPLACE FUNCTION public.contractor_templates_freeze_verdict() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $f$
BEGIN
  -- Exempt service_role (EF/system), the admin account, and appointed template reviewers.
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;
  IF coalesce(auth.jwt() ->> 'email','') = 'dustinstohler1@gmail.com' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.contractors c
             WHERE c.user_id = (select auth.uid()) AND c.template_review_role = 'admin') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.status            := 'pending_validation';
    NEW.validation_result := NULL;
    NEW.reviewed_by       := NULL;
    NEW.reviewed_at       := NULL;
    NEW.admin_notes       := NULL;
    RETURN NEW;
  END IF;

  -- Regular contractor UPDATE: verdict/admin fields are never theirs to write.
  NEW.reviewed_by  := OLD.reviewed_by;
  NEW.reviewed_at  := OLD.reviewed_at;
  NEW.admin_notes  := OLD.admin_notes;

  IF (NEW.pdf_storage_path IS DISTINCT FROM OLD.pdf_storage_path)
     OR (NEW.manual_overrides IS DISTINCT FROM OLD.manual_overrides)
     OR (NEW.trade IS DISTINCT FROM OLD.trade)
     OR (NEW.funding_type IS DISTINCT FROM OLD.funding_type) THEN
    NEW.status            := 'pending_validation';
    NEW.validation_result := NULL;
  ELSE
    NEW.status            := OLD.status;
    NEW.validation_result := OLD.validation_result;
  END IF;
  RETURN NEW;
END;
$f$;
-- "before" body of enforce_template_privileged_columns = the rollback file (it also DROPs the new function IF EXISTS, a no-op here).
\i supabase/migrations_drafts/gh3199_submit_template_for_admin_review_rollback.sql
BEGIN;  -- the \i above ended its own transaction; reopen so the proof still rolls back
CREATE TRIGGER contractor_templates_freeze_verdict BEFORE INSERT OR UPDATE ON public.contractor_templates FOR EACH ROW EXECUTE FUNCTION contractor_templates_freeze_verdict();
CREATE TRIGGER trg_contractor_templates_updated_at BEFORE UPDATE ON public.contractor_templates FOR EACH ROW EXECUTE FUNCTION contractor_templates_set_updated_at();
CREATE TRIGGER trg_templates_privileged_guard BEFORE UPDATE ON public.contractor_templates FOR EACH ROW EXECUTE FUNCTION enforce_template_privileged_columns();

INSERT INTO contractors VALUES ('c1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001',NULL),   -- contractor A
                               ('c2000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000002',NULL),   -- contractor B
                               ('c3000000-0000-0000-0000-000000000003','a3000000-0000-0000-0000-000000000003','admin');-- template reviewer
INSERT INTO contractor_templates (id, contractor_id, trade, funding_type, pdf_storage_path, status, validation_result, manual_overrides) VALUES
  ('e0000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','roofing','insurance','a/1.pdf','manual_mapping_pending','{"requiredCount":3}','{"old":"x"}'),
  ('e0000000-0000-0000-0000-000000000002','c1000000-0000-0000-0000-000000000001','siding','insurance','a/2.pdf','pending_validation',NULL,NULL),
  ('e0000000-0000-0000-0000-000000000003','c1000000-0000-0000-0000-000000000001','gutters','insurance','a/3.pdf','auto_validated','{"ok":true}',NULL),
  ('e0000000-0000-0000-0000-000000000004','c1000000-0000-0000-0000-000000000001','windows','insurance','a/4.pdf','admin_validated','{"ok":true}',NULL),
  ('e0000000-0000-0000-0000-000000000005','c1000000-0000-0000-0000-000000000001','paint','insurance','a/5.pdf','rejected','{"ok":false}',NULL),
  ('e0000000-0000-0000-0000-000000000006','c2000000-0000-0000-0000-000000000002','roofing','insurance','b/1.pdf','manual_mapping_pending','{"requiredCount":3}',NULL),
  ('e0000000-0000-0000-0000-000000000007','c1000000-0000-0000-0000-000000000001','decks','insurance','a/7.pdf','manual_mapping_pending','{"requiredCount":3}',NULL);

CREATE SCHEMA proof;
GRANT USAGE ON SCHEMA proof TO authenticated;
CREATE TABLE proof.results(label text, got text, want text);
GRANT ALL ON proof.results TO authenticated;
CREATE OR REPLACE FUNCTION proof.as_user(u text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false) $$;
-- a SECURITY DEFINER stand-in WITHOUT the flag: shows the guard blocks a definer caller before this migration
CREATE FUNCTION public.zz_definer_no_flag(p uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN UPDATE contractor_templates SET status='submitted_for_admin_review' WHERE id=p; RETURN 'updated'; EXCEPTION WHEN OTHERS THEN RETURN 'error ' || SQLSTATE; END $$;
GRANT EXECUTE ON FUNCTION public.zz_definer_no_flag(uuid) TO authenticated;

-- ===== NEGATIVE CONTROLS (before the migration) =====
SET ROLE authenticated;
SELECT proof.as_user('a1000000-0000-0000-0000-000000000001');
UPDATE contractor_templates SET manual_overrides='{"k":"v","_missing_fields":["x"]}', status='submitted_for_admin_review' WHERE id='e0000000-0000-0000-0000-000000000001';
INSERT INTO proof.results SELECT 'CONTROL main: client writes overrides+submitted status -> stored status', status, 'pending_validation' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000001';
UPDATE contractor_templates SET status='submitted_for_admin_review' WHERE id='e0000000-0000-0000-0000-000000000007';
INSERT INTO proof.results SELECT 'CONTROL main: client writes status only -> stored status (requestAdminReview path)', status, 'manual_mapping_pending' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000007';
INSERT INTO proof.results SELECT 'CONTROL: SECURITY DEFINER update without the flag, on the old guard', public.zz_definer_no_flag('e0000000-0000-0000-0000-000000000002'), 'error 42501';
RESET ROLE;
INSERT INTO proof.results SELECT 'CONTROL main: rows in submitted_for_admin_review before', count(*)::text, '0' FROM contractor_templates WHERE status='submitted_for_admin_review';
-- reset row 1 to its seeded state for the positive tests
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);  -- setup writes run as service role
UPDATE contractor_templates SET status='manual_mapping_pending', manual_overrides='{"old":"x"}', validation_result='{"requiredCount":3}' WHERE id='e0000000-0000-0000-0000-000000000001';

-- ===== APPLY THE MIGRATION =====
\i supabase/migrations_drafts/gh3199_submit_template_for_admin_review.sql
BEGIN;

-- ===== POSITIVE =====
SET ROLE authenticated;
SELECT proof.as_user('a1000000-0000-0000-0000-000000000001');
INSERT INTO proof.results SELECT 'manual-mapping submit -> returned status', (public.submit_template_for_admin_review('e0000000-0000-0000-0000-000000000001', '{"k":"v"}'::jsonb, ARRAY['x','y']::text[])).status, 'submitted_for_admin_review';
RESET ROLE;
INSERT INTO proof.results SELECT 'stored status', status, 'submitted_for_admin_review' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000001';
INSERT INTO proof.results SELECT 'stored overrides (same shape the client wrote)', manual_overrides::text, '{"k": "v", "_missing_fields": ["x", "y"]}' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000001';
INSERT INTO proof.results SELECT 'validation_result kept for the reviewer', validation_result::text, '{"requiredCount": 3}' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000001';
INSERT INTO proof.results SELECT 'reviewed_by/at/admin_notes untouched', (reviewed_by IS NULL AND reviewed_at IS NULL AND admin_notes IS NULL)::text, 'true' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
-- Request-admin-review path: NULL/NULL leaves overrides alone, from pending_validation.
INSERT INTO proof.results SELECT 'null overrides, from pending_validation', (public.submit_template_for_admin_review('e0000000-0000-0000-0000-000000000002', NULL, NULL)).status, 'submitted_for_admin_review';
RESET ROLE;
INSERT INTO proof.results SELECT 'null/null leaves manual_overrides NULL', coalesce(manual_overrides::text,'NULL'), 'NULL' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000002';
-- Admin queue filter (admin/template-review/utils.ts NEEDS_REVIEW_STATUSES), run as the template reviewer.
SET ROLE authenticated;
SELECT proof.as_user('a3000000-0000-0000-0000-000000000003');
INSERT INTO proof.results SELECT 'admin queue (status in submitted/mapping_pending) sees both submitted rows', count(*)::text, '2' FROM contractor_templates WHERE id IN ('e0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000002') AND status IN ('submitted_for_admin_review','manual_mapping_pending');
RESET ROLE;
INSERT INTO proof.results SELECT 'rows in submitted_for_admin_review after', count(*)::text, '2' FROM contractor_templates WHERE status='submitted_for_admin_review';

-- ===== REFUSALS =====
CREATE OR REPLACE FUNCTION proof.try(p_id uuid, p_uid text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF p_uid IS NULL THEN PERFORM set_config('request.jwt.claims', '{"role":"anon"}', false); ELSE PERFORM proof.as_user(p_uid); END IF;
  PERFORM public.submit_template_for_admin_review(p_id, NULL, NULL);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE;
END $$;
GRANT EXECUTE ON FUNCTION proof.try(uuid,text) TO authenticated;
SET ROLE authenticated;
INSERT INTO proof.results SELECT 'other contractor''s template', proof.try('e0000000-0000-0000-0000-000000000006', 'a1000000-0000-0000-0000-000000000001'), 'P0002';
INSERT INTO proof.results SELECT 'unknown template id (same error as not-yours)', proof.try('e0000000-0000-0000-0000-0000000000ff', 'a1000000-0000-0000-0000-000000000001'), 'P0002';
INSERT INTO proof.results SELECT 'no session (auth.uid() null)', proof.try('e0000000-0000-0000-0000-000000000007', NULL), '42501';
INSERT INTO proof.results SELECT 'from auto_validated', proof.try('e0000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001'), '55000';
INSERT INTO proof.results SELECT 'from admin_validated', proof.try('e0000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001'), '55000';
INSERT INTO proof.results SELECT 'from rejected', proof.try('e0000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001'), '55000';
INSERT INTO proof.results SELECT 'resubmit when already submitted', proof.try('e0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001'), '55000';
SELECT proof.as_user('a1000000-0000-0000-0000-000000000001');
INSERT INTO proof.results SELECT 'null template id', (SELECT CASE WHEN true THEN (SELECT 'x') END), 'x';  -- placeholder row, replaced below
DELETE FROM proof.results WHERE label='null template id';
DO $$ BEGIN
  BEGIN PERFORM public.submit_template_for_admin_review(NULL, NULL, NULL); INSERT INTO proof.results VALUES ('null template id','ok','22023');
  EXCEPTION WHEN OTHERS THEN INSERT INTO proof.results VALUES ('null template id', SQLSTATE, '22023'); END;
  BEGIN PERFORM public.submit_template_for_admin_review('e0000000-0000-0000-0000-000000000007', '[1,2]'::jsonb, NULL); INSERT INTO proof.results VALUES ('non-object overrides','ok','22023');
  EXCEPTION WHEN OTHERS THEN INSERT INTO proof.results VALUES ('non-object overrides', SQLSTATE, '22023'); END;
END $$;
-- The allowance is not reachable from a client: forging the GUC and writing the status directly still does not submit.
SELECT set_config('oq.template_submit','on',false);
UPDATE contractor_templates SET status='submitted_for_admin_review' WHERE id='e0000000-0000-0000-0000-000000000007';
UPDATE contractor_templates SET manual_overrides='{"forged":1}', status='submitted_for_admin_review' WHERE id='e0000000-0000-0000-0000-000000000007';
RESET ROLE;
INSERT INTO proof.results SELECT 'forged GUC + direct client write -> stored status', status, 'pending_validation' FROM contractor_templates WHERE id='e0000000-0000-0000-0000-000000000007';
-- The RPC leaves the flag off when it returns (same transaction), starting from a cleared GUC.
SELECT set_config('oq.template_submit','',false);
SET ROLE authenticated;
SELECT proof.as_user('a1000000-0000-0000-0000-000000000001');
SELECT public.submit_template_for_admin_review('e0000000-0000-0000-0000-000000000007', NULL, NULL);
RESET ROLE;
INSERT INTO proof.results SELECT 'flag is off again after the RPC (same txn)', coalesce(current_setting('oq.template_submit', true),''), 'off';
-- The guard still refuses other status moves for a definer caller with the flag on (e.g. to admin_validated).
CREATE FUNCTION public.zz_definer_flag_other(p uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN PERFORM set_config('oq.template_submit','on',true); UPDATE contractor_templates SET status='admin_validated' WHERE id=p; RETURN 'updated'; EXCEPTION WHEN OTHERS THEN RETURN 'error ' || SQLSTATE; END $$;
GRANT EXECUTE ON FUNCTION public.zz_definer_flag_other(uuid) TO authenticated;
SET ROLE authenticated;
SELECT proof.as_user('a1000000-0000-0000-0000-000000000001');
INSERT INTO proof.results SELECT 'flag on but target status admin_validated', public.zz_definer_flag_other('e0000000-0000-0000-0000-000000000007'), 'error 42501';
RESET ROLE;
-- Grants
INSERT INTO proof.results SELECT 'anon cannot execute', has_function_privilege('anon','public.submit_template_for_admin_review(uuid,jsonb,text[])','EXECUTE')::text, 'false';
INSERT INTO proof.results SELECT 'authenticated can execute', has_function_privilege('authenticated','public.submit_template_for_admin_review(uuid,jsonb,text[])','EXECUTE')::text, 'true';

SELECT label, got, want, CASE WHEN got IS NOT DISTINCT FROM want THEN 'PASS' ELSE 'FAIL' END AS verdict FROM proof.results ORDER BY ctid;
DO $$
DECLARE bad int; n int;
BEGIN
  SELECT count(*) FILTER (WHERE got IS DISTINCT FROM want), count(*) INTO bad, n FROM proof.results;
  IF bad > 0 THEN RAISE EXCEPTION 'PROOF-FAIL % of % checks failed', bad, n; END IF;
  RAISE EXCEPTION 'PROOF-OK all % checks passed; last transaction deliberately aborted (scratch DB)', n;
END $$;
