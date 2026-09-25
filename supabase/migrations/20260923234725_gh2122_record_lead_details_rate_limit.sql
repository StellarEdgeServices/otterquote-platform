-- gh-2122: raise the record-lead-details rate limit so a real lead's consent record is not lost to a 429.
-- Authorised by Ben (CEO RUN 66, claim ceo-2026-09-23T18:56:07Z), ruling DECIDED (Tier A) on #2122, comment
-- 5804580144 section 3: "raise it from 30 to 300 per hour per IP ... Change only the rate_limit_config row, via a
-- migration PR. That is Tier 3A." Config data only: one UPDATE of one existing row; no schema change; nothing
-- dropped, renamed or retyped.
--
-- WHY. The row shipped in 20260923211259_gh2122_leads_details_consent.sql at 30/hour, 100/day, 1000/month per IP
-- bucket. One Arm F lead can now cost up to three requests (the keepalive fetch, its one retry, the pagehide
-- beacon), and paid mobile-ad traffic shares carrier NAT addresses, so one IP can be many real leads. A blocked
-- call loses that lead's consent record with no alert, and D-299 makes that the costlier failure. Abuse surface is
-- low: the RPC writes only to a lead under 30 minutes old that has not been redeemed, and the first write wins.
--
-- WHY THE DAY AND MONTH CAPS MOVE WITH IT (read this before approving). check_rate_limit() enforces all three
-- windows per bucket, in the order hour, day, month, and each is a hard stop. Left at 100/day and 1000/month, a
-- 300/hour ruling changes nothing: the 101st request from one IP in a day is refused by the DAILY cap first. So
-- this migration keeps the same 1 : 3.33 : 33 ratio the original row had and moves all three:
--     hour 30 -> 300     day 100 -> 1000     month 1000 -> 10000
-- Ben's ruling names only the hourly number; if he wants the day and month caps left alone, drop the two extra
-- assignments below (the hourly raise alone would then be inert past 100 requests a day per IP).
--
-- SAFETY. The UPDATE is pinned to the exact values it expects to replace (30 / 100 / 1000) and the block raises
-- unless it changed exactly one row, so it cannot silently overwrite a row someone has already tuned, and it
-- cannot silently do nothing.
--
-- Companion rollback: supabase/migrations_rollbacks/20260923234725_gh2122_record_lead_details_rate_limit_rollback.sql

DO $mig$
DECLARE
  n integer;
BEGIN
  UPDATE public.rate_limit_config
     SET max_per_hour  = 300,
         max_per_day   = 1000,
         max_per_month = 10000,
         notes = 'gh2122: per-IP synthetic-UUID bucket (sha256 of "record-lead-details:<ip>", not a real user_id -- this endpoint is called pre-auth from /start?v=f). Up to three requests per Arm F lead (fetch, its one retry, the pagehide beacon). Raised 30/100/1000 -> 300/1000/10000 by Ben''s ruling 5804580144 s3 (carrier NAT shares IPs across real leads; a blocked call loses a consent record). Raise again if a legitimate visitor is throttled.'
   WHERE function_name = 'record-lead-details'
     AND max_per_hour = 30
     AND max_per_day = 100
     AND max_per_month = 1000;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'gh2122 rate-limit raise expected to change exactly 1 row (record-lead-details at 30/100/1000), changed %', n;
  END IF;
END
$mig$;
