-- Rollback for 20260830192051_v116_accept_bid_rpc.sql.
-- One additive object, no ALTER/DROP of anything pre-existing -- the rollback is total
-- and leaves no residue. Revert bids.html/contractor-about.html to their three-.update()
-- form (or redeploy the pre-this-PR commit) before dropping, or homeowner bid acceptance
-- breaks outright.

DROP FUNCTION IF EXISTS public.accept_bid(uuid, uuid);
