-- gh-3049 proof for request_bid_renewal. Run on a SCRATCH database only (it creates stub tables and roles):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/gh3049_request_bid_renewal_proof.sql scratchdb
-- Stubs mirror only the columns the function touches (baseline schema) and Supabase's auth.uid() (reads request.jwt.claim.sub).
\set ON_ERROR_STOP on
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
CREATE TABLE claims (id uuid PRIMARY KEY, user_id uuid NOT NULL, property_address text);
CREATE TABLE contractors (id uuid PRIMARY KEY, user_id uuid, company_name text);
CREATE TABLE quotes (id uuid PRIMARY KEY, claim_id uuid NOT NULL, contractor_id uuid NOT NULL, bid_status text DEFAULT 'active' NOT NULL);
CREATE TABLE notifications (id uuid DEFAULT gen_random_uuid(), user_id uuid, claim_id uuid, channel text NOT NULL,
  notification_type text NOT NULL, recipient text NOT NULL, message_preview text, created_at timestamptz DEFAULT now());
GRANT USAGE ON SCHEMA public TO anon, authenticated;
-- Homeowners can read/write nothing directly (mirrors the real RLS outcome for the private column and cross-user insert).
GRANT USAGE ON SCHEMA auth TO anon, authenticated;

\i supabase/migrations_drafts/gh3049_request_bid_renewal.sql

INSERT INTO claims VALUES ('c0000000-0000-0000-0000-00000000000a','a0000000-0000-0000-0000-00000000000a','1 Main St'),
                          ('c0000000-0000-0000-0000-00000000000b','b0000000-0000-0000-0000-00000000000b','9 Other Ave');
INSERT INTO contractors VALUES ('d0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001','Bidder One'),
                               ('d0000000-0000-0000-0000-000000000002','e0000000-0000-0000-0000-000000000002','Not Bidding Here'),
                               ('d0000000-0000-0000-0000-000000000003',NULL,'No User');
INSERT INTO quotes VALUES ('f0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a','d0000000-0000-0000-0000-000000000001','active'),
                          ('f0000000-0000-0000-0000-000000000002','c0000000-0000-0000-0000-00000000000b','d0000000-0000-0000-0000-000000000002','active'),
                          ('f0000000-0000-0000-0000-000000000003','c0000000-0000-0000-0000-00000000000a','d0000000-0000-0000-0000-000000000003','active');

CREATE TEMP TABLE results(label text, got text, want text);
GRANT ALL ON results TO authenticated, anon;
SET ROLE authenticated;

-- BEFORE (control): today's path -- homeowner session inserts a notification for the contractor user_id, and reads the private column.
SELECT set_config('request.jwt.claim.sub','a0000000-0000-0000-0000-00000000000a',false);
DO $$ BEGIN
  BEGIN SELECT 1 FROM public.contractors LIMIT 1; INSERT INTO results SELECT 'control: homeowner reads contractors.user_id directly','allowed','denied';
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO results VALUES ('control: homeowner reads contractors.user_id directly','denied','denied'); END;
END $$;
RESET ROLE;
-- (the real notifications INSERT policy is own-user-only: p16 / gh2154; client-side insert for another user_id is refused, i.e. zero rows today)
SELECT 'rows before any RPC call' AS label, count(*) FROM notifications;
SET ROLE authenticated;

-- 1. Positive: owner of claim A requests renewal on bid f..01 -> true and exactly one row for contractor user e..01.
SELECT set_config('request.jwt.claim.sub','a0000000-0000-0000-0000-00000000000a',false);
INSERT INTO results SELECT 'owner, own bid -> true', public.request_bid_renewal('f0000000-0000-0000-0000-000000000001')::text, 'true';
RESET ROLE;
INSERT INTO results SELECT 'rows for contractor user after 1st call', count(*)::text, '1' FROM notifications WHERE user_id='e0000000-0000-0000-0000-000000000001' AND notification_type='bid_renewal_requested' AND claim_id='c0000000-0000-0000-0000-00000000000a' AND channel='dashboard';
INSERT INTO results SELECT 'message wording unchanged', message_preview, 'A homeowner is requesting an updated bid on 1 Main St.' FROM notifications WHERE user_id='e0000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
-- 2. Dedupe: second call inserts nothing.
SELECT set_config('request.jwt.claim.sub','a0000000-0000-0000-0000-00000000000a',false);
INSERT INTO results SELECT 'repeat within 24h -> true', public.request_bid_renewal('f0000000-0000-0000-0000-000000000001')::text, 'true';
RESET ROLE;
INSERT INTO results SELECT 'still one row after repeat', count(*)::text, '1' FROM notifications;
SET ROLE authenticated;

-- NEGATIVE CONTROLS
-- 3. Homeowner A tries a bid on homeowner B's claim (contractor not bidding on A's claim) -> false, no row.
INSERT INTO results SELECT 'A -> B''s bid (contractor not bidding on A) -> false', public.request_bid_renewal('f0000000-0000-0000-0000-000000000002')::text, 'false';
-- 4. Unknown quote id -> false (same answer as #3, no oracle).
INSERT INTO results SELECT 'unknown quote -> false', public.request_bid_renewal('99999999-0000-0000-0000-000000000000')::text, 'false';
-- 5. Contractor without user_id -> false.
INSERT INTO results SELECT 'contractor without user_id -> false', public.request_bid_renewal('f0000000-0000-0000-0000-000000000003')::text, 'false';
-- 6. The contractor themself (not the claim owner) -> false.
SELECT set_config('request.jwt.claim.sub','e0000000-0000-0000-0000-000000000001',false);
INSERT INTO results SELECT 'contractor calling on own bid -> false', public.request_bid_renewal('f0000000-0000-0000-0000-000000000001')::text, 'false';
-- 7. No session -> false.
SELECT set_config('request.jwt.claim.sub','',false);
INSERT INTO results SELECT 'no auth.uid() -> false', public.request_bid_renewal('f0000000-0000-0000-0000-000000000001')::text, 'false';
-- 8. Return type is boolean only (no user_id leak) and anon cannot execute.
INSERT INTO results SELECT 'return type', pg_typeof(public.request_bid_renewal('99999999-0000-0000-0000-000000000000'))::text, 'boolean';
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM public.request_bid_renewal('f0000000-0000-0000-0000-000000000001'); INSERT INTO results VALUES ('anon execute','allowed','denied');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO results VALUES ('anon execute','denied','denied'); END;
END $$;
RESET ROLE;
-- 9. Withdrawn bid -> false.
UPDATE quotes SET bid_status='cancelled' WHERE id='f0000000-0000-0000-0000-000000000001';
DELETE FROM notifications;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','a0000000-0000-0000-0000-00000000000a',false);
INSERT INTO results SELECT 'withdrawn bid -> false', public.request_bid_renewal('f0000000-0000-0000-0000-000000000001')::text, 'false';
RESET ROLE;
INSERT INTO results SELECT 'rows after all refusals', count(*)::text, '0' FROM notifications;

SELECT label, got, want, CASE WHEN got = want THEN 'PASS' ELSE 'FAIL' END AS verdict FROM results;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM results WHERE got IS DISTINCT FROM want) THEN RAISE EXCEPTION 'gh3049 proof: FAIL'; END IF;
END $$;
