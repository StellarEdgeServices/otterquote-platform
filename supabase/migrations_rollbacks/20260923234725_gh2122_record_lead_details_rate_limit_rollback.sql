-- Rollback for: 20260923234725_gh2122_record_lead_details_rate_limit.sql
-- GitHub: #2122
-- Restores the original record-lead-details limits (30/hour, 100/day, 1000/month). Config data only; nothing else
-- in the migration to undo. Pinned to the values the migration set (300 / 1000 / 10000) and raises unless it
-- changed exactly one row, so it cannot overwrite a row that has been retuned since. Rolling back restores the
-- behaviour in which one carrier-NAT IP can lose a real lead's consent record to a 429 (see the migration header).

DO $rb$
DECLARE
  n integer;
BEGIN
  UPDATE public.rate_limit_config
     SET max_per_hour  = 30,
         max_per_day   = 100,
         max_per_month = 1000,
         notes = 'gh2122: per-IP synthetic-UUID bucket (sha256 of "record-lead-details:<ip>", not a real user_id -- this endpoint is called pre-auth from /start?v=f). One call per Arm F submit, two with the single retry. Starting judgment call; raise if a legitimate visitor is throttled.'
   WHERE function_name = 'record-lead-details'
     AND max_per_hour = 300
     AND max_per_day = 1000
     AND max_per_month = 10000;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'gh2122 rate-limit rollback expected to change exactly 1 row (record-lead-details at 300/1000/10000), changed %', n;
  END IF;
END
$rb$;
