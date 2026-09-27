-- ROLLBACK for 20260927133501_gh1529_r3_contractor_can_bid_and_onboarding_sends.sql
--
-- Restores exactly the live state captured before the forward migration
-- (project yeszghaspzwwstvsrioa, 2026-09-27T13:35:01Z):
--   - "Contractors can insert quotes" policy back to roles={public}.
--   - EXECUTE on contractor_can_bid(uuid) back to PUBLIC and anon (proacl
--     before: {=X/postgres,postgres=X/postgres,anon=X/postgres,
--     authenticated=X/postgres,service_role=X/postgres}).
--   - INSERT/UPDATE/DELETE on partner_onboarding_sends back to anon.
--
-- Run manually if the forward migration needs to be reverted; never
-- replayed automatically by the Supabase CLI's forward-only chain.

BEGIN;

ALTER POLICY "Contractors can insert quotes" ON public.quotes TO public;

GRANT EXECUTE ON FUNCTION public.contractor_can_bid(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.contractor_can_bid(uuid) TO anon;

GRANT INSERT, UPDATE, DELETE ON public.partner_onboarding_sends TO anon;

COMMIT;
