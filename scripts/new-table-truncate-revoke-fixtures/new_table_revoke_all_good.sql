-- TRUNCATE-CHECK-FIXTURE: EXPECT=PASS
-- REVOKE ALL covers TRUNCATE; a narrower grant afterwards (no TRUNCATE) does not undo it.
CREATE TABLE public.gh3256_log (id bigserial PRIMARY KEY, body text);
REVOKE ALL ON TABLE public.gh3256_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.gh3256_log TO authenticated;
GRANT ALL ON public.gh3256_log TO service_role;
