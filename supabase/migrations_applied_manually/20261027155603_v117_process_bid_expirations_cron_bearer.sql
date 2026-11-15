DO $v117$
DECLARE
  target_jobid BIGINT;
  n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') THEN
    RAISE EXCEPTION 'v117: vault secret cron_service_role_key missing — aborting before touching job 3';
  END IF;
  SELECT count(*) INTO n FROM cron.job WHERE jobname = 'process-bid-expirations';
  IF n <> 1 THEN
    RAISE EXCEPTION 'v117 process-bid-expirations: expected 1 cron.job row, got %', n;
  END IF;
  SELECT jobid INTO target_jobid FROM cron.job WHERE jobname = 'process-bid-expirations';
  PERFORM cron.alter_job(target_jobid, command := $cmd$
  SELECT net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/process-bid-expirations',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_service_role_key') || ''
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $cmd$);
END
$v117$;