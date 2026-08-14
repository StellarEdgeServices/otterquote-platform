-- Rollback for 20260814013701_gh820_accept_public_directory_rpc_risk.sql
-- Comment-only change — rollback simply clears the comments.
COMMENT ON FUNCTION public.get_contractors_public() IS NULL;
COMMENT ON FUNCTION public.get_referral_agents_public() IS NULL;
