-- gh-2154 P-3 review round 2 (REVIEW FAIL 5832785581, must-fix 1): the
-- notify-admin-new-partner dedupe check was keyed on notifications.user_id,
-- which is NULL for every partner row at signup time (register_partner never
-- sets it -- user_id is linked later by claim_partner_account). A
-- .eq("user_id", null) query is turned by supabase-js into
-- `user_id=eq.null`, which live prod REST answers with HTTP 400
-- (22P02 invalid input syntax for type uuid: "null"), and the Edge Function
-- was discarding that error and sending anyway -- so every retry (and every
-- P-5 Meta lead, which has no auth user at all) sent a duplicate alert.
--
-- Fix (Edge Function side, same PR): dedupe on the partner's own id instead
-- of user_id, and fail closed (no send) if the dedupe query errors. This
-- migration is the additive schema change that partner-id dedupe needs:
-- notifications has no partner-referencing column today (confirmed via
-- sql/schema-snapshot.json -- id, user_id, claim_id, channel,
-- notification_type, recipient, message_preview, sent_at, delivered,
-- twilio_sid, mailgun_id, created_at, read_at; no referral_agent_id).
--
-- Additive only: one new nullable column + one new partial unique index.
-- No existing column, constraint, trigger or row is altered or dropped.
-- The FK is ON DELETE SET NULL (never blocks a referral_agents delete on an
-- old notification row) and the column is nullable so every other
-- notification_type this table already carries (contractor/homeowner
-- alerts, SMS, etc.) is completely unaffected.
--
-- The partial unique index prevents two concurrent admin_new_partner_alert
-- ROWS for the same partner at the database level. It does NOT prevent two
-- duplicate SENDS (REVIEW FAIL 5833567534, should-fix 1): the Edge Function
-- is check -> send -> insert, so two concurrent calls for one partner can
-- both see "not yet sent" and both send before either insert lands; only
-- the second INSERT then fails, which index.ts downgrades to a
-- console.warn. In practice this needs two concurrent Edge Function calls
-- for the same partner_id (one trigger per INSERT, pg_net does not retry),
-- so the realistic exposure is at most one extra admin email, not the
-- unbounded resend must-fix 1 (round 1) found. It is defense in depth
-- against duplicate ROWS, not a substitute for the Edge Function's own
-- dedupe check.
--
-- REVIEW FAIL 5833567534, should-fix 2: this migration also narrows two
-- existing notifications RLS policies. Before this migration, any signed-in
-- user could INSERT or UPDATE their own notifications row (WITH CHECK
-- user_id = auth.uid()) -- with a referral_agent_id column that any
-- authenticated user could set to point at another partner's row now to
-- write, that same WITH CHECK would let a user forge or suppress a
-- partner's admin alert: insert/update their own row with
-- notification_type='admin_new_partner_alert', channel='email',
-- referral_agent_id=<victim partner's uuid>, and the Edge Function's dedupe
-- read would see "already sent" and never call. Adding
-- "AND referral_agent_id IS NULL" to both policies' WITH CHECK closes that
-- off: a user-authored notifications row can never carry a
-- referral_agent_id at all (only service_role, which bypasses RLS, ever
-- sets it -- the trigger's Edge Function call uses the service-role key).
-- SELECT is unaffected (still own-rows-only via notifications_user_read).
--
-- REVIEW FAIL 5833567534, should-fix 3: the index predicate is narrowed to
-- this one notification_type instead of "any referral_agent_id" so a
-- second, different partner-keyed notification_type (e.g. a future repeat
-- partner reminder) is not rejected by this index.

BEGIN;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS referral_agent_id UUID
    REFERENCES public.referral_agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.notifications.referral_agent_id IS
'gh-2154 P-3 review round 2: partner (referral_agents) this notification is about, e.g. admin_new_partner_alert. NULL for every non-partner notification. Added because user_id is NULL for a referral_agents row at signup time and cannot key dedupe.';

DROP INDEX IF EXISTS public.notifications_partner_alert_dedupe_idx;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_partner_alert_dedupe_idx
  ON public.notifications (referral_agent_id)
  WHERE referral_agent_id IS NOT NULL
    AND notification_type = 'admin_new_partner_alert';

COMMENT ON INDEX public.notifications_partner_alert_dedupe_idx IS
'gh-2154 P-3 review round 3 (REVIEW FAIL 5833567534, should-fix 1 + 3): prevents two admin_new_partner_alert ROWS for the same partner, not two SENDS (the Edge Function is check -> send -> insert; the second insert is the only thing this index rejects, downgraded to a warning). Scoped to notification_type=''admin_new_partner_alert'' so a future, different partner-keyed notification_type is not blocked by this index.';

-- REVIEW FAIL 5833567534, should-fix 2: a signed-in user's own notifications
-- row can never carry a referral_agent_id (only service_role, which
-- bypasses RLS, ever writes one) -- prevents a user from forging or
-- suppressing a partner's admin alert via their own insert/update.
ALTER POLICY "Authenticated can insert notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()) AND referral_agent_id IS NULL);

ALTER POLICY "Users can update own notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()) AND referral_agent_id IS NULL);

COMMIT;
