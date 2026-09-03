-- Migration: v60_support_tickets
-- Filed by: gh-1438 migration history backfill batch 1 (Code lane)
-- Date filed: 2026-09-02
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 1, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-04-28T18:06:58Z, recorded in
-- supabase_migrations.schema_migrations as version 20260428180658, name
-- "v60_support_tickets". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-02, gh-1438 backfill batch 1. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

-- SQL v60: support_tickets table (D-195 Support Triage System)
-- Applied: 2026-04-28

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                  uuid              NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at          timestamptz       NOT NULL DEFAULT now(),
  updated_at          timestamptz       NOT NULL DEFAULT now(),
  source              text              NOT NULL DEFAULT 'form',
  mailgun_message_id  text,
  from_name           text              NOT NULL,
  from_email          text              NOT NULL,
  subject             text,
  body                text              NOT NULL,
  raw_email           jsonb,
  user_id             uuid              REFERENCES auth.users(id) ON DELETE SET NULL,
  claim_id            uuid              REFERENCES public.claims(id) ON DELETE SET NULL,
  contractor_id       uuid              REFERENCES public.contractors(id) ON DELETE SET NULL,
  status              text              NOT NULL DEFAULT 'open',
  priority            text              NOT NULL DEFAULT 'normal',
  ai_draft            text,
  ai_draft_created_at timestamptz,
  ai_classification   text,
  ai_confidence       numeric(4, 3),
  sent_at             timestamptz,
  resolved_at         timestamptz,
  resolution_notes    text
);

CREATE INDEX IF NOT EXISTS support_tickets_status_idx      ON public.support_tickets (status);
CREATE INDEX IF NOT EXISTS support_tickets_created_at_idx  ON public.support_tickets (created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_from_email_idx  ON public.support_tickets (from_email);
CREATE INDEX IF NOT EXISTS support_tickets_mailgun_msg_idx ON public.support_tickets (mailgun_message_id) WHERE mailgun_message_id IS NOT NULL;

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

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.support_tickets IS 'D-195 support triage inbox. Populated by send-support-email Edge Function and inbound Mailgun parse. AI triage runs via scheduled task. Admin reviews via service role only.';
