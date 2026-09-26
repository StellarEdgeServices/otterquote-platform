-- gh-2121 (LRS HO-1 S21) fix round 1 (CEO RUN 68 REVIEW: FAIL, comment
-- 5825698253, go-live order item 3): the pg_cron schedule for
-- send-lead-next-step-reminder. Deliberately a SEPARATE migration file from
-- 20260925020000_gh2121_lead_next_step_reminder.sql (that one is the
-- columns + kill-switch row; this one only wires the schedule) so the two
-- can be applied and reasoned about independently, matching how
-- 20260916132127_gh1994_router_leads_columns.sql and
-- 20260917010217_gh1994_router_lead_alert.sql were kept separate.
--
-- Tier: 3B (cron that ultimately triggers a commercial email send) --
-- despite that, this migration is disabled-safe: adding the pg_cron job
-- does not, by itself, cause a single email to go out. Every fire of this
-- schedule still hits send-lead-next-step-reminder's own kill-switch read
-- (rate_limit_config.enabled for function_name='send-lead-next-step-
-- reminder', inserted false by the sibling migration above) FIRST,
-- unconditionally, before any candidate query runs -- see that function's
-- index.ts header. While that row reads enabled=false, this cron job's
-- every invocation returns { sent: 0, skipped_disabled: true } and touches
-- no `leads` row. Applying this migration does not need to wait for the
-- kill switch to be turned on, and turning the kill switch on later does
-- not require touching this migration again.
--
-- Same pg_cron -> net.http_post -> vault secret pattern as this repo's
-- other scheduled EFs (20260914211825_gh1932_homeowner_signup_sweep_cron.sql,
-- send-homeowner-next-steps' own schedule), using vault secret
-- cron_service_role_key as the Authorization: Bearer credential --
-- send-lead-next-step-reminder's own auth gate (fix round 1, must-fix 3)
-- accepts that same service-role Bearer credential.
--
-- Hourly, matching send-homeowner-next-steps' own cadence for the same
-- "day-after" style nudge -- the Edge Function's own REMINDER_MIN_AGE_MS /
-- REMINDER_MAX_AGE_MS window (select-candidates.ts) is what actually decides
-- eligibility per lead, not this schedule's frequency.
--
-- Rollback:
--   select cron.unschedule('gh2121-lead-next-step-reminder');

BEGIN;

SELECT cron.schedule(
  'gh2121-lead-next-step-reminder',
  '0 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-lead-next-step-reminder',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cron$
);

COMMIT;
