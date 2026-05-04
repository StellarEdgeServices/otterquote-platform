-- v59: Partial-completion onboarding reminder system
-- Adds partial_completion_email_sent_at to contractors.
-- Schedules daily pg_cron job at 2pm UTC + rate_limit_config entry.
-- Applied: April 27, 2026

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS partial_completion_email_sent_at TIMESTAMPTZ;

INSERT INTO public.rate_limit_config (
  function_name, max_per_hour, max_per_day, max_per_month,
  enabled, monthly_cost_estimate, monthly_budget_cap, notes
)
VALUES (
  'send-incomplete-onboarding-reminders', 2, 2, 62, true, 0.50, 5.00,
  'Daily cron: nudges contractors stalled at onboarding_step=1 after 24h. 1 cron run + 1 manual test slot per day.'
)
ON CONFLICT (function_name) DO NOTHING;

-- NOTE: service role key must be substituted at apply time — not committed to source control
-- SELECT cron.schedule('send-incomplete-onboarding-reminders', '0 14 * * *', $$...$$);
