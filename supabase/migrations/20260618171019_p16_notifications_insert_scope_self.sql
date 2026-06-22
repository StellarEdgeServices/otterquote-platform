-- Phase 16 RLS Unit 2 — close notifications forge (86e1xe0wb)
-- D-220 Tier-3, Dustin-approved 2026-06-18; D-221 Path A
-- Was: "Authenticated can insert notifications" WITH CHECK (true) => any authed user could
-- insert a notification for ANY recipient (cross-user feed forgery / in-app phishing).
-- Now: an authenticated user may only insert a notification addressed to themselves.
-- service_role full-access policy unchanged => all EF/system notifications unaffected.
-- Rollback: ALTER POLICY ... WITH CHECK (true);
ALTER POLICY "Authenticated can insert notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()));
