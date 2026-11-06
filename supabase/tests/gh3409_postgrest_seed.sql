-- gh-3409: seed for the real-PostgREST proof (gh3409_postgrest_proof.mjs). Throwaway database only.
-- Creates the login role PostgREST connects as (Supabase's is also called authenticator), two contractors, and bids. Prints one JSON line.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gh3409_authenticator') THEN CREATE ROLE gh3409_authenticator LOGIN NOINHERIT PASSWORD 'proof'; END IF;
END $$;
GRANT anon, authenticated, service_role TO gh3409_authenticator;
GRANT USAGE ON SCHEMA public TO gh3409_authenticator;
\pset format unaligned
\pset tuples_only on
CREATE TEMP TABLE s (k text, v text);
CREATE TEMP TABLE c (who text, user_id uuid, contractor_id uuid);
INSERT INTO c VALUES ('a', gen_random_uuid(), gen_random_uuid()), ('b', gen_random_uuid(), gen_random_uuid());
INSERT INTO public.contractors (id, user_id) SELECT contractor_id, user_id FROM c;
DO $$
DECLARE r record; i int; cl uuid; qid uuid;
BEGIN
  FOR r IN SELECT * FROM c LOOP
    FOR i IN 1..12 LOOP
      cl := gen_random_uuid(); qid := gen_random_uuid();
      INSERT INTO public.claims(id) VALUES (cl);
      INSERT INTO public.quotes(id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, status) VALUES (qid, cl, r.contractor_id, 15000, 0, 0, 'submitted');
      INSERT INTO s VALUES (r.who || i, qid::text || ',' || cl::text);
    END LOOP;
  END LOOP;
END $$;
SELECT json_build_object(
  'a', (SELECT json_build_object('user_id', user_id, 'contractor_id', contractor_id) FROM c WHERE who='a'),
  'b', (SELECT json_build_object('user_id', user_id, 'contractor_id', contractor_id) FROM c WHERE who='b'),
  'bids', (SELECT json_object_agg(k, json_build_object('bid_id', split_part(v, ',', 1), 'claim_id', split_part(v, ',', 2))) FROM s));
