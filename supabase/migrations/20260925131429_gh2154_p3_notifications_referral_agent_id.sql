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
-- rows for the same partner at the database level -- defense in depth on
-- top of the Edge Function's own check-then-send dedupe query.

BEGIN;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS referral_agent_id UUID
    REFERENCES public.referral_agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.notifications.referral_agent_id IS
'gh-2154 P-3 review round 2: partner (referral_agents) this notification is about, e.g. admin_new_partner_alert. NULL for every non-partner notification. Added because user_id is NULL for a referral_agents row at signup time and cannot key dedupe.';

CREATE UNIQUE INDEX IF NOT EXISTS notifications_partner_alert_dedupe_idx
  ON public.notifications (referral_agent_id, notification_type)
  WHERE referral_agent_id IS NOT NULL;

COMMIT;
