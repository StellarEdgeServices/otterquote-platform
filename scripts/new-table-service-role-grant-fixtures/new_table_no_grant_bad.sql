-- GRANT-CHECK-FIXTURE: EXPECT=FAIL
-- Negative control: brand-new public table, RLS enabled, but NO explicit
-- GRANT of any kind. Before 2026-10-30 this silently gets the full default
-- grant to anon/authenticated/service_role; after, it gets none at all,
-- and service_role (which every Edge Function needs) breaks with
-- permission-denied. This is exactly the shape gh-2145 exists to catch.

BEGIN;

CREATE TABLE IF NOT EXISTS public.widget_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.widget_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.widget_events
  FOR ALL USING (auth.role() = 'service_role');

COMMIT;
