-- v117 ROLLBACK — restore job 3 (process-bid-expirations) to its pre-gh-3104 command
-- (no Authorization header; measured 2026-10-26, length 201, md5 prefix c6e63809).
-- Direction of safety: leaving the bearer on job 3 is harmless against an ungated function, so this
-- rollback only matters if the bearer itself must be removed. Do not run it while the gated function is deployed.
DO $v117r$
DECLARE
  target_jobid BIGINT;
  n INT;
BEGIN
  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'process-bid-expirations';
  IF n <> 1 THEN
    RAISE EXCEPTION 'v117 rollback: expected 1 cron.job row, got %', n;
  END IF;
  SELECT jobid INTO target_jobid FROM cron.job WHERE jobname = 'process-bid-expirations';
  -- cron.alter_job: the migration role has no UPDATE on cron.job (42501, 2026-10-27).
  PERFORM cron.alter_job(target_jobid, command := $cmd$SELECT net.http_post(url := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-bid-expirations', headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb) AS request_id$cmd$);
END
$v117r$;
