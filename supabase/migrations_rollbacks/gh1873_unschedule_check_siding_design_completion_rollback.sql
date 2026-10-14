-- STATUS (gh-1438, as of 2026-10-13T22:44:46Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh1873_unschedule_check_siding_design_completion (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-1873; the command text below is the one in sql/v108-pg-cron-vault-secrets.sql (vault-key form) with the schedule from sql/v44-siding-bid-release.sql; the live command text was not read (the plan forbids printing it)
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-1873 ROLLBACK for supabase/migrations_drafts/gh1873_unschedule_check_siding_design_completion.sql
--
-- Manual reference only. Never rename this into a 14-digit timestamp or move it into supabase/migrations/ -- the CLI would replay
-- it FORWARD. Re-creates cron job 6 exactly as the repo defines it. Before running, diff the command against the pre-image the
-- apply session recorded (SELECT command FROM cron.job WHERE jobname = 'check-siding-design-completion', read BEFORE the unschedule).
-- Rolling back only helps if the check-siding-design-completion function is also redeployed from git history
-- (supabase/functions/check-siding-design-completion/index.ts at main 4f331d4); the stub ignores the job's request.

BEGIN;

SELECT cron.schedule(
  'check-siding-design-completion',
  '*/30 * * * *',
  $cmd$SELECT net.http_post(url := 'https://yeszghaspzwwstvsrioa.functions.supabase.co/functions/v1/check-siding-design-completion', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''), body := '{}'::jsonb) AS request_id;$cmd$
);

COMMIT;
