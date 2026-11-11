DROP POLICY IF EXISTS "Admin can update fee acceptances" ON public.fee_acceptances;

REVOKE UPDATE, DELETE ON TABLE public.fee_acceptances FROM anon, authenticated;

DO $guard$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(r || ':' || p || CASE WHEN p = 'UPDATE' AND NOT has_table_privilege(r, 'public.fee_acceptances', p) THEN ' (column-level)' ELSE '' END, ', ') INTO bad
    FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p
   WHERE CASE WHEN p = 'UPDATE' THEN has_any_column_privilege(r, 'public.fee_acceptances', p) ELSE has_table_privilege(r, 'public.fee_acceptances', p) END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'gh3320: client privilege survived on public.fee_acceptances: %', bad USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fee_acceptances' AND cmd IN ('UPDATE', 'DELETE', 'ALL')) THEN
    RAISE EXCEPTION 'gh3320: an UPDATE, DELETE or ALL policy survives on public.fee_acceptances' USING ERRCODE = '55000';
  END IF;
END
$guard$;