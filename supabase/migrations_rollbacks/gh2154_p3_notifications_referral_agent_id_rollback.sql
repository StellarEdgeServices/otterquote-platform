-- ============================================================================
-- gh-2154 P-3 review round 2/3 ROLLBACK: remove notifications.referral_agent_id
-- ============================================================================
--
-- Reverts, in reverse order of the forward migration:
--   1. the two RLS policies' WITH CHECK (review round 3, should-fix 2) back
--      to their pre-P-3 form (20260618171019_p16_notifications_insert_scope_self.sql
--      for the insert policy; the baseline definition for the update policy)
--   2. the partial unique index (review round 3 shape, or the round-2 shape
--      if this rollback runs against a round-2-only apply -- IF EXISTS makes
--      either a no-op-safe DROP)
--   3. the column itself

BEGIN;

ALTER POLICY "Authenticated can insert notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY "Users can update own notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()));

DROP INDEX IF EXISTS public.notifications_partner_alert_dedupe_idx;
ALTER TABLE public.notifications DROP COLUMN IF EXISTS referral_agent_id;

COMMIT;
