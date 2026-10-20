-- gh-2442 proof: dunning_retry_pass_lease behaves as a single-row lease. SCRATCH POSTGRES ONLY (creates roles).
-- Run as one script; the last statement prints the proof table (result must equal expect). Run on PGlite (PostgreSQL 18.6
-- WASM) by the authoring session on 2026-10-19. GENERATED: the forward DDL below is the body of the forward file.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $r$;
CREATE TABLE IF NOT EXISTS public.dunning_retry_pass_lease (
  id           integer PRIMARY KEY CHECK (id = 1),
  holder       text,
  locked_until timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO public.dunning_retry_pass_lease (id, holder, locked_until) VALUES (1, NULL, 'epoch') ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.dunning_retry_pass_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dunning_retry_pass_lease FROM PUBLIC;
REVOKE ALL ON TABLE public.dunning_retry_pass_lease FROM anon;
REVOKE ALL ON TABLE public.dunning_retry_pass_lease FROM authenticated;
GRANT SELECT, UPDATE ON TABLE public.dunning_retry_pass_lease TO service_role;
COMMENT ON TABLE public.dunning_retry_pass_lease IS 'gh-2442: single-row run lease for the process-dunning retry pass (service role only).';
CREATE TABLE proof (n serial PRIMARY KEY, label text, result text, expect text);
CREATE FUNCTION acquire(p_token text, p_now timestamptz) RETURNS integer LANGUAGE sql AS $$
  WITH u AS (UPDATE public.dunning_retry_pass_lease SET holder = p_token, locked_until = p_now + interval '10 minutes'
              WHERE id = 1 AND locked_until < p_now RETURNING 1) SELECT count(*)::int FROM u $$;
CREATE FUNCTION release(p_token text) RETURNS integer LANGUAGE sql AS $$
  WITH u AS (UPDATE public.dunning_retry_pass_lease SET locked_until = 'epoch' WHERE id = 1 AND holder = p_token RETURNING 1) SELECT count(*)::int FROM u $$;
INSERT INTO proof(label,result,expect) VALUES ('seed row present', (SELECT count(*)::text FROM public.dunning_retry_pass_lease), '1');
INSERT INTO proof(label,result,expect) VALUES ('tick A acquires', acquire('A', '2026-10-20 15:00:00+00')::text, '1');
INSERT INTO proof(label,result,expect) VALUES ('tick B at the same time is refused', acquire('B', '2026-10-20 15:00:05+00')::text, '0');
INSERT INTO proof(label,result,expect) VALUES ('B cannot release A''s lease', release('B')::text, '0');
INSERT INTO proof(label,result,expect) VALUES ('tick B still refused', acquire('B', '2026-10-20 15:00:06+00')::text, '0');
INSERT INTO proof(label,result,expect) VALUES ('A releases', release('A')::text, '1');
INSERT INTO proof(label,result,expect) VALUES ('B acquires after release', acquire('B', '2026-10-20 15:00:07+00')::text, '1');
INSERT INTO proof(label,result,expect) VALUES ('crashed holder: still held at +9 min', acquire('C', '2026-10-20 15:09:00+00')::text, '0');
INSERT INTO proof(label,result,expect) VALUES ('crashed holder: lease expired at +11 min', acquire('C', '2026-10-20 15:11:00+00')::text, '1');
INSERT INTO proof(label,result,expect) VALUES ('RLS enabled', (SELECT relrowsecurity::text FROM pg_class WHERE oid='public.dunning_retry_pass_lease'::regclass), 'true');
INSERT INTO proof(label,result,expect) VALUES ('anon / authenticated hold no privilege', (SELECT count(*)::text FROM information_schema.role_table_grants WHERE table_name='dunning_retry_pass_lease' AND grantee IN ('anon','authenticated','PUBLIC')), '0');
INSERT INTO proof(label,result,expect) VALUES ('service_role holds SELECT and UPDATE', (SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name='dunning_retry_pass_lease' AND grantee='service_role'), 'SELECT,UPDATE');
SELECT n, label, result, expect, CASE WHEN result = expect THEN 'OK' ELSE 'MISMATCH' END AS verdict FROM proof ORDER BY n;
