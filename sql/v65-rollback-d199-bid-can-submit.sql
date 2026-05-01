-- ROLLBACK: D-199 bid-time validation gate (SQL v65)
-- Reverses migration v65_d199_bid_can_submit.
-- Session 463, Apr 30, 2026.

DROP TRIGGER IF EXISTS quotes_enforce_bid_can_submit ON public.quotes;
DROP FUNCTION IF EXISTS public.enforce_bid_can_submit();
DROP FUNCTION IF EXISTS public.bid_can_submit(uuid, text, text);
