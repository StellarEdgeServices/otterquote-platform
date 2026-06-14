-- Migration v90b — drop the legacy broad authenticated read on contractors
-- Applied to prod 2026-06-13 (migration version 20260613201225).
-- Committed retroactively (prod-vs-repo drift). Safe because, by v90:
--   homeowner reads -> contractors_public (v89); admin reads -> "Admin can read all contractors" (v90);
--   contractor own-record reads -> "Contractors can read own record".
DROP POLICY IF EXISTS "Authenticated users can read contractors" ON public.contractors;
