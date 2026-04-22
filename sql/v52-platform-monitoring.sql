-- v52-platform-monitoring.sql
-- Creates platform_alerts_log table for the platform monitoring system.
-- Part of the platform-health-check Edge Function (Thread 2C, ClickUp 86e112rak).
--
-- Apply via Supabase Management API.

-- ============================================================
-- 1. platform_alerts_log table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.platform_alerts_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type        TEXT        NOT NULL,   -- 'ef_silent_failure' | 'cron_staleness' | 'cron_error' | 'rate_limit'
  function_name     TEXT        NOT NULL,
  message           TEXT        NOT NULL,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at   TIMESTAMPTZ
);

-- ============================================================
-- 2. RLS — admin-only read + update (acknowledge)
-- ============================================================
ALTER TABLE public.platform_alerts_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_read_platform_alerts" ON public.platform_alerts_log;
CREATE POLICY "admin_read_platform_alerts"
  ON public.platform_alerts_log
  FOR SELECT
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');

DROP POLICY IF EXISTS "admin_update_platform_alerts" ON public.platform_alerts_log;
CREATE POLICY "admin_update_platform_alerts"
  ON public.platform_alerts_log
  FOR UPDATE
  TO authenticated
  USING (auth.jwt() ->> 'email' = 'dustinstohler1@gmail.com');

-- Service role INSERT (used by platform-health-check Edge Function)
DROP POLICY IF EXISTS "service_role_insert_platform_alerts" ON public.platform_alerts_log;
CREATE POLICY "service_role_insert_platform_alerts"
  ON public.platform_alerts_log
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- ============================================================
-- 3. acknowledge_alert() — SECURITY DEFINER so admin JWT can
--    update via client without direct service role.
-- ============================================================
CREATE OR REPLACE FUNCTION public.acknowledge_alert(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.platform_alerts_log
     SET acknowledged_at = NOW()
   WHERE id = p_id
     AND acknowledged_at IS NULL;
END;
$$;

-- ============================================================
-- 4. Index for common query patterns
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_platform_alerts_unacked
  ON public.platform_alerts_log (sent_at DESC)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_platform_alerts_function
  ON public.platform_alerts_log (function_name, sent_at DESC);
