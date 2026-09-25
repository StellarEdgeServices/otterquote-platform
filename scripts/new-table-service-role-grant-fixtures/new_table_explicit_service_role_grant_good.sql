-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- Positive control: brand-new public table with an explicit, narrow
-- service_role grant in the same file. anon/authenticated are deliberately
-- given nothing -- this table is meant to be service-role-only, and after
-- 2026-10-30 that is achieved by omission rather than by relying on the
-- (soon-gone) default grant plus RLS as the only real barrier.

BEGIN;

CREATE TABLE IF NOT EXISTS public.widget_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widget_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.widget_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role only" ON public.widget_events
  FOR ALL USING (auth.role() = 'service_role');

grant select, insert, update, delete on public.widget_events to service_role;

COMMIT;
