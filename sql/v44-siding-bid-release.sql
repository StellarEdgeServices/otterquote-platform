-- v44-siding-bid-release.sql
-- D-164 / D-165: Per-trade siding bid release gate
-- Adds siding_bid_released_at to claims so the D-164 Hover-design gate can
-- set it when manufacturer + profile + color + trim are all present.
-- Also schedules the 30-min polling function.
--
-- Apply via Supabase Management API:
--   POST /v1/projects/yeszghaspzwwstvsrioa/database/query
--   { "query": "<contents of this file>" }

-- ── 1. Add siding_bid_released_at to claims ─────────────────────────────
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS siding_bid_released_at TIMESTAMPTZ;

-- Index for the polling query: retail siding claims awaiting release
CREATE INDEX IF NOT EXISTS idx_claims_siding_pending_release
  ON public.claims (funding_type, siding_bid_released_at)
  WHERE funding_type = 'cash' AND siding_bid_released_at IS NULL;

-- ── 2. Schedule check-siding-design-completion every 30 minutes ─────────
-- Uses pg_cron (already enabled — see process-dunning cron job).
-- The Edge Function URL pattern matches existing scheduled functions.
SELECT cron.schedule(
  'check-siding-design-completion',      -- job name
  '*/30 * * * *',                        -- every 30 minutes
  $$
  SELECT net.http_post(
    url    := current_setting('app.supabase_url') || '/functions/v1/check-siding-design-completion',
    body   := '{}',
    headers:= jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    )
  );
  $$
)
ON CONFLICT (jobname) DO UPDATE
  SET schedule = '*/30 * * * *';
