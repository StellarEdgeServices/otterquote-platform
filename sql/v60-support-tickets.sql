-- SQL v60: support_tickets table (D-195 Support Triage System)
-- Applied: 2026-04-28
-- Rollback: v60-support-tickets-rollback.sql

-- ── support_tickets ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                  uuid              NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at          timestamptz       NOT NULL DEFAULT now(),
  updated_at          timestamptz       NOT NULL DEFAULT now(),

  -- Origin
  source              text              NOT NULL DEFAULT 'form',   -- 'form' | 'email' | 'inbound_parse'
  mailgun_message_id  text,                                         -- deduplication key for inbound email

  -- Sender info
  from_name           text              NOT NULL,
  from_email          text              NOT NULL,
  subject             text,

  -- Content
  body                text              NOT NULL,
  raw_email           jsonb,                                        -- full inbound email payload

  -- User linkage (optional — support tickets may come from non-authenticated users)
  user_id             uuid              REFERENCES auth.users(id) ON DELETE SET NULL,
  claim_id            uuid              REFERENCES public.claims(id) ON DELETE SET NULL,
  contractor_id       uuid              REFERENCES public.contractors(id) ON DELETE SET NULL,

  -- Triage state
  status              text              NOT NULL DEFAULT 'open',
    -- 'open' | 'ai_drafted' | 'sent' | 'closed' | 'escalated'
  priority            text              NOT NULL DEFAULT 'normal',
    -- 'low' | 'normal' | 'high' | 'urgent'

  -- AI response
  ai_draft            text,                                         -- AI-generated reply draft
  ai_draft_created_at timestamptz,
  ai_classification   text,                                         -- label from AI triage (e.g. 'billing', 'bug', 'general')
  ai_confidence       numeric(4, 3),                                -- 0.000–1.000

  -- Resolution
  sent_at             timestamptz,                                  -- when support reply was sent
  resolved_at         timestamptz,
  resolution_notes    text
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS support_tickets_status_idx      ON public.support_tickets (status);
CREATE INDEX IF NOT EXISTS support_tickets_created_at_idx  ON public.support_tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_from_email_idx  ON public.support_tickets (from_email);
CREATE INDEX IF NOT EXISTS support_tickets_mailgun_msg_idx ON public.support_tickets (mailgun_message_id) WHERE mailgun_message_id IS NOT NULL;

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'support_tickets_set_updated_at'
      AND tgrelid = 'public.support_tickets'::regclass
  ) THEN
    CREATE TRIGGER support_tickets_set_updated_at
      BEFORE UPDATE ON public.support_tickets
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END; $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS — that is the only write path (Edge Functions use service role)
-- No authenticated-user read policy: support tickets are admin-only via service role

COMMENT ON TABLE public.support_tickets IS
  'D-195 support triage inbox. Populated by send-support-email Edge Function and inbound Mailgun parse. AI triage runs via scheduled task. Admin reviews via service role only — no user-facing RLS read policy.';
