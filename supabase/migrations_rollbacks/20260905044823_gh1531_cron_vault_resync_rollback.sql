-- ROLLBACK for supabase/migrations/20260905044823_gh1531_cron_vault_resync.sql
--
-- Drops the SECURITY DEFINER entry point used by the vault-resync Edge
-- Function. Reversible with no data loss: the Vault rows it may have
-- written (cron_service_role_key, cron_secret) are left in place because
-- pg_cron jobs read them; removing the function only removes the re-sync
-- path, not the secrets. Run MANUALLY only — never place in migrations/.

DROP FUNCTION IF EXISTS public.cron_vault_resync(text, text);
