SET LOCAL lock_timeout = '5s';
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
DO $post$
DECLARE
  v_client_truncate int; v_client_roles int; v_client_other int; v_service_truncate int;
BEGIN
  SELECT count(*) FILTER (WHERE e.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND e.privilege_type = 'TRUNCATE'),
         count(DISTINCT e.grantee) FILTER (WHERE e.grantee IN ('anon'::regrole, 'authenticated'::regrole)),
         count(*) FILTER (WHERE e.grantee IN ('anon'::regrole, 'authenticated'::regrole)
                            AND e.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'TRIGGER')),
         count(*) FILTER (WHERE e.grantee = 'service_role'::regrole AND e.privilege_type = 'TRUNCATE')
    INTO v_client_truncate, v_client_roles, v_client_other, v_service_truncate
    FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) e
   WHERE d.defaclrole = 'postgres'::regrole AND d.defaclnamespace = 'public'::regnamespace AND d.defaclobjtype = 'r';
  IF v_client_truncate <> 0 THEN
    RAISE EXCEPTION 'gh3256: anon/authenticated still carry TRUNCATE in postgres''s public table defaults (% entries)', v_client_truncate USING ERRCODE = 'P0B57';
  END IF;
  IF v_client_roles <> 2 OR v_client_other <> 12 THEN
    RAISE EXCEPTION 'gh3256: anon/authenticated lost a default privilege other than TRUNCATE (roles=%, privileges=%, want 2/12)', v_client_roles, v_client_other USING ERRCODE = 'P0B57';
  END IF;
  IF v_service_truncate <> 1 THEN
    RAISE EXCEPTION 'gh3256: service_role lost TRUNCATE in the defaults' USING ERRCODE = 'P0B57';
  END IF;
END
$post$;