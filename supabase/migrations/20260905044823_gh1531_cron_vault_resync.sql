-- gh-1531: post-rotation Vault re-sync mechanism (the 2026-08-29 CEO ruling:
-- "an Edge Function re-syncing Vault from its own injected
-- SUPABASE_SERVICE_ROLE_KEY after any rotation"). PostgREST exposes only the
-- public schema, so the `vault-resync` Edge Function needs one narrow,
-- SECURITY DEFINER entry point to write the two pg_cron Vault secrets:
--
--   cron_service_role_key  (gh-688, created 2026-08-12; read by 10 pg_cron jobs)
--   cron_secret            (gh-1531, created 2026-09-05; read by jobs 8/13/16)
--
-- Allow-listed by name; never returns the secret (only len + 4-char prefix);
-- EXECUTE granted to service_role only (the Edge Function's injected key),
-- revoked from PUBLIC / anon / authenticated so no client JWT can reach it.
-- Additive: creates one function, touches no table and no existing row.
--
-- Filed by CTO cto-2026-09-02T13:45:25Z; tier:3b-approved applied
-- 2026-09-04T13:11:17Z (R-097 window closed without objection). Applied to
-- production by CTO subagent claim cto-2026-09-05T03:07:58Z.
--
-- Rollback: supabase/migrations_rollbacks/20260905044823_gh1531_cron_vault_resync_rollback.sql

CREATE OR REPLACE FUNCTION public.cron_vault_resync(p_name text, p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id     uuid;
  v_action text;
BEGIN
  IF p_name IS NULL OR p_name NOT IN ('cron_service_role_key', 'cron_secret') THEN
    RAISE EXCEPTION 'cron_vault_resync: name % is not in the allow-list', p_name
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_secret IS NULL OR pg_catalog.length(p_secret) < 16 THEN
    RAISE EXCEPTION 'cron_vault_resync: refusing an empty/short value for %', p_name
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.id INTO v_id FROM vault.secrets s WHERE s.name = p_name;

  IF v_id IS NULL THEN
    v_id := vault.create_secret(
      p_secret, p_name,
      'pg_cron secret; created by public.cron_vault_resync (gh-1531 vault-resync)');
    v_action := 'created';
  ELSE
    PERFORM vault.update_secret(v_id, p_secret);
    v_action := 'updated';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'name',   p_name,
    'action', v_action,
    'len',    pg_catalog.length(p_secret),
    'prefix', pg_catalog.left(p_secret, 4)
  );
END
$$;

REVOKE ALL ON FUNCTION public.cron_vault_resync(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_vault_resync(text, text) TO service_role;

COMMENT ON FUNCTION public.cron_vault_resync(text, text) IS
  'gh-1531: upsert one allow-listed pg_cron Vault secret (cron_service_role_key | cron_secret). service_role only; called by the vault-resync Edge Function. Returns name/action/len/prefix — never the value.';
