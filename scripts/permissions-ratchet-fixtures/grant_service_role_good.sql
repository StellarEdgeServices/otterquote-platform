-- RATCHET-FIXTURE: EXPECT=PASS
-- The one allowlisted role in this repo's real grant history
-- (20260501004321_v65_d199_bid_can_submit.sql:93,
-- 20260905044823_gh1531_cron_vault_resync.sql:62). Backend/webhook/cron only,
-- never reachable from a client request -- must pass with no bypass label.
BEGIN;

GRANT EXECUTE ON FUNCTION public.some_backend_only_job() TO service_role;

COMMIT;
