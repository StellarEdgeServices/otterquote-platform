-- STATUS (gh-1438, as of 2026-10-19T22:51:02Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2875_d391_contractor_sms_numbers (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-19 under #2875 (D-391 + D-391 AMENDMENT 1). Production read-only 2026-10-19: none of the five tables
--   below exists (to_regclass NULL for sms_suppression_list and contractor_sms_numbers); public.is_admin_email() exists;
--   contractors.id is uuid NOT NULL, contractors.user_id uuid NULL. No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and
--   pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2875_d391_contractor_sms_numbers
-- GitHub: #2875 (D-391), supersedes the single-consented-phone model of PR #2791 (D-383). Tier: 3B (new consent tables; R-097
--   notice 6256733805, window closes 2026-10-19T23:54:07Z). R-177 applies to anything that writes consent text; this file writes NONE.
-- Rollback: supabase/migrations_drafts/gh2875_d391_contractor_sms_numbers_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2875_d391_contractor_sms_numbers_pre-flight.md
-- Proof: supabase/tests/gh2875_d391_contractor_sms_numbers_proof.sql (runner ..._proof_run.sh, throwaway Postgres only)
--
-- What this is: layer 1 of the D-391 build order (Marty, #2875 comment 6256542144): the per-number verification record and the
-- suppression list. It adds STORAGE and ONE read function. It changes no sender, no page and no existing column; nothing texts
-- anyone differently after this applies. Layers 2-4 (Twilio Verify Edge Functions, signup/settings UI, sender switch) read and
-- write these tables.
--
-- The rules this schema makes structural (D-391 spec, Stellar Edge Services/Otter Quotes/Legal/contractor-sms-consent-spec-2026-10-18.md):
--   * "No consent record, no number on file": a contractor_sms_numbers row cannot exist without verified_at, the disclosure
--     version id AND its exact text, method and source (all NOT NULL). Clients (anon/authenticated) cannot INSERT, UPDATE or DELETE
--     any of these tables; only service_role (the Verify Edge Functions, after Twilio approves the code) writes.
--   * Senders read ONLY public.contractor_textable_numbers(contractor_id): status verified, confirmed within 395 days (yearly
--     re-confirm prompt + 30 days, spec "Re-verification"), and not on the open suppression list. service_role only.
--   * STOP covers one number; the opt-out is kept on public.sms_suppression_list, separate from the account, released only by START.
--   * At most one primary per contractor; a number that leaves 'verified' loses primary, and the oldest remaining verified number
--     is promoted (spec: "the oldest remaining verified number becomes primary automatically"; the e-mail is the Edge Function's job).
--   * The last verified number cannot be 'removed' or 'disabled' (spec: replace-only; staff "never the last one"). An opt-out of the
--     last number IS allowed: an opt-out must always be honoured (LEGAL-READ 6256074958). Amendment 1: after that, e-mail only plus
--     a banner, no lead restriction -- nothing here restricts leads.
--   * Per-number preference record defaulting to 'all' (spec), so per-type filtering later is a settings change.
--   * Staff actions log: who, when, what changed, reason (reason NOT NULL, non-blank).
-- Proposed, NOT decided (flagged for the reviewer and the legal read):
--   P1 the 395-day window (365 + 30) is my reading of "prompted yearly ... unconfirmed for 30 days is treated as unverified".
--   P2 retention: no row is ever deleted here (ON DELETE CASCADE from contractors only; contractors are not hard-deleted today).
--      LEGAL-READ: consent record = life of number + 4 years; suppression entry until START, minimum 5 years. A purge job is out of scope.
--   P3 sms_disclosure_versions gets NO row here. The disclosure wording waits on LEGAL-READ + R-177 SIGNED; until a version row is
--      inserted by a separate signed change, no number can be verified (the FK refuses it), which is the safe default.
-- NOT in this file: the legacy-15 wipe (D-391 AMENDMENT 1, #2876) is a data change on contractors.* phone columns and goes in its
--   own reviewed step; Twilio Verify service creation (Tier C vendor check, #2875 6256542144) is not a database object.
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS; CREATE OR REPLACE FUNCTION; DROP TRIGGER/POLICY IF EXISTS before CREATE.

BEGIN;

DO $gate$
BEGIN
  IF to_regclass('public.contractors') IS NULL THEN
    RAISE EXCEPTION 'gh2875 gate: public.contractors is missing';
  END IF;
  IF to_regprocedure('public.is_admin_email()') IS NULL THEN
    RAISE EXCEPTION 'gh2875 gate: public.is_admin_email() is missing';
  END IF;
END
$gate$;

-- 1. Disclosure versions (versioned like D-328). Public text, readable by anyone; written only by service_role.
CREATE TABLE IF NOT EXISTS public.sms_disclosure_versions (
  id              text PRIMARY KEY CHECK (btrim(id) <> ''),
  program_name    text NOT NULL CHECK (btrim(program_name) <> ''),
  disclosure_text text NOT NULL CHECK (btrim(disclosure_text) <> ''),
  effective_at    timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 2. The per-number verification record. One row per (contractor, number) verification; history rows stay.
CREATE TABLE IF NOT EXISTS public.contractor_sms_numbers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id         uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,
  phone_e164            text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status                text NOT NULL DEFAULT 'verified'
                          CHECK (status IN ('verified', 'opted_out', 'disabled', 'removed')),
  is_primary            boolean NOT NULL DEFAULT false,
  verified_at           timestamptz NOT NULL,
  last_confirmed_at     timestamptz NOT NULL,
  disclosure_version_id text NOT NULL REFERENCES public.sms_disclosure_versions(id),
  disclosure_text       text NOT NULL CHECK (btrim(disclosure_text) <> ''),
  verification_method   text NOT NULL CHECK (verification_method IN ('sms_otp')),
  source                text NOT NULL CHECK (source IN ('signup', 'settings', 'reverify')),
  verify_sid            text,
  consent_ip            inet,
  consent_user_agent    text,
  opted_out_at          timestamptz,
  opt_out_keyword       text,
  opt_out_channel       text CHECK (opt_out_channel IN ('sms_keyword', 'sms_freeform', 'email', 'support_call',
                                                        'carrier_disconnect')),
  status_changed_at     timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contractor_sms_numbers_optout_recorded CHECK (status <> 'opted_out' OR (opted_out_at IS NOT NULL AND opt_out_channel IS NOT NULL)),
  CONSTRAINT contractor_sms_numbers_primary_is_verified CHECK (NOT is_primary OR status = 'verified')
);
CREATE UNIQUE INDEX IF NOT EXISTS contractor_sms_numbers_one_live_per_number
  ON public.contractor_sms_numbers (contractor_id, phone_e164) WHERE status = 'verified';
CREATE UNIQUE INDEX IF NOT EXISTS contractor_sms_numbers_one_primary
  ON public.contractor_sms_numbers (contractor_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS contractor_sms_numbers_user_idx ON public.contractor_sms_numbers (user_id);
CREATE INDEX IF NOT EXISTS contractor_sms_numbers_phone_idx ON public.contractor_sms_numbers (phone_e164);

-- 3. Per-number preferences, default 'all' (spec). Filtering later is a settings change, not a migration.
CREATE TABLE IF NOT EXISTS public.contractor_sms_number_preferences (
  number_id   uuid PRIMARY KEY REFERENCES public.contractor_sms_numbers(id) ON DELETE CASCADE,
  categories  text[] NOT NULL DEFAULT ARRAY['all']::text[],
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 4. Suppression list: separate from the account; an open row (released_at NULL) blocks the number for every contractor.
CREATE TABLE IF NOT EXISTS public.sms_suppression_list (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164       text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  suppressed_at    timestamptz NOT NULL DEFAULT now(),
  keyword          text,
  channel          text NOT NULL CHECK (channel IN ('sms_keyword', 'sms_freeform', 'email', 'support_call', 'carrier_disconnect')),
  source_number_id uuid REFERENCES public.contractor_sms_numbers(id) ON DELETE SET NULL,
  released_at      timestamptz,
  released_keyword text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_suppression_release_by_start CHECK (released_at IS NULL OR upper(btrim(released_keyword)) IN ('START', 'UNSTOP', 'YES'))
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_suppression_one_open_per_number
  ON public.sms_suppression_list (phone_e164) WHERE released_at IS NULL;

-- 5. Staff actions log.
CREATE TABLE IF NOT EXISTS public.contractor_sms_staff_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL,
  number_id     uuid REFERENCES public.contractor_sms_numbers(id) ON DELETE SET NULL,
  actor_user_id uuid,
  actor_email   text NOT NULL CHECK (btrim(actor_email) <> ''),
  action        text NOT NULL CHECK (action IN ('remove', 'disable', 'reenable', 'send_reverify_link')),
  reason        text NOT NULL CHECK (btrim(reason) <> ''),
  before_state  jsonb,
  after_state   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 6. Invariants on the number record.
CREATE OR REPLACE FUNCTION public.contractor_sms_numbers_before_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
    -- replace-only: the last verified number of a contractor cannot be removed or disabled (an opt-out is always honoured).
    IF OLD.status = 'verified' AND NEW.status IN ('removed', 'disabled') AND NOT EXISTS (
         SELECT 1 FROM public.contractor_sms_numbers o
          WHERE o.contractor_id = OLD.contractor_id AND o.id <> OLD.id AND o.status = 'verified') THEN
      RAISE EXCEPTION 'gh2875: the last verified number of contractor % cannot be %; verify a replacement first', OLD.contractor_id, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status <> 'verified' THEN
    NEW.is_primary := false;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.contractor_sms_numbers_promote_primary()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF OLD.is_primary AND NOT NEW.is_primary AND NOT EXISTS (
       SELECT 1 FROM public.contractor_sms_numbers p WHERE p.contractor_id = NEW.contractor_id AND p.is_primary) THEN
    UPDATE public.contractor_sms_numbers SET is_primary = true
     WHERE id = (SELECT o.id FROM public.contractor_sms_numbers o
                  WHERE o.contractor_id = NEW.contractor_id AND o.status = 'verified'
                    AND o.last_confirmed_at > now() - interval '395 days'
                    AND NOT EXISTS (SELECT 1 FROM public.sms_suppression_list s
                                     WHERE s.phone_e164 = o.phone_e164 AND s.released_at IS NULL)
                  ORDER BY o.verified_at, o.id LIMIT 1);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS contractor_sms_numbers_before_write ON public.contractor_sms_numbers;
CREATE TRIGGER contractor_sms_numbers_before_write BEFORE INSERT OR UPDATE ON public.contractor_sms_numbers
  FOR EACH ROW EXECUTE FUNCTION public.contractor_sms_numbers_before_write();
DROP TRIGGER IF EXISTS contractor_sms_numbers_promote_primary ON public.contractor_sms_numbers;
CREATE TRIGGER contractor_sms_numbers_promote_primary AFTER UPDATE OF is_primary, status ON public.contractor_sms_numbers
  FOR EACH ROW EXECUTE FUNCTION public.contractor_sms_numbers_promote_primary();

-- 7. The one read the senders may use.
CREATE OR REPLACE FUNCTION public.contractor_textable_numbers(p_contractor_id uuid)
RETURNS TABLE (number_id uuid, phone_e164 text, is_primary boolean)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT n.id, n.phone_e164, n.is_primary
    FROM public.contractor_sms_numbers n
   WHERE n.contractor_id = p_contractor_id
     AND n.status = 'verified'
     AND n.last_confirmed_at > now() - interval '395 days'
     AND NOT EXISTS (SELECT 1 FROM public.sms_suppression_list s
                      WHERE s.phone_e164 = n.phone_e164 AND s.released_at IS NULL)
   ORDER BY n.is_primary DESC, n.verified_at, n.id
$fn$;
REVOKE ALL ON FUNCTION public.contractor_textable_numbers(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contractor_textable_numbers(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.contractor_sms_numbers_before_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.contractor_sms_numbers_promote_primary() FROM PUBLIC, anon, authenticated;

-- 8. Privileges and RLS. Clients read only; service_role writes.
REVOKE ALL ON public.sms_disclosure_versions, public.contractor_sms_numbers, public.contractor_sms_number_preferences,
              public.sms_suppression_list, public.contractor_sms_staff_actions FROM anon, authenticated;
GRANT SELECT ON public.sms_disclosure_versions TO anon, authenticated;
GRANT SELECT ON public.contractor_sms_numbers, public.contractor_sms_number_preferences TO authenticated;
GRANT SELECT ON public.sms_suppression_list, public.contractor_sms_staff_actions TO authenticated;
GRANT ALL ON public.sms_disclosure_versions, public.contractor_sms_numbers, public.contractor_sms_number_preferences,
             public.sms_suppression_list, public.contractor_sms_staff_actions TO service_role;

ALTER TABLE public.sms_disclosure_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_sms_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_sms_number_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_suppression_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_sms_staff_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_disclosure_versions_read ON public.sms_disclosure_versions;
CREATE POLICY sms_disclosure_versions_read ON public.sms_disclosure_versions FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS contractor_sms_numbers_owner_or_admin_read ON public.contractor_sms_numbers;
CREATE POLICY contractor_sms_numbers_owner_or_admin_read ON public.contractor_sms_numbers FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.contractors c WHERE c.id = contractor_id AND c.user_id = auth.uid())
         OR public.is_admin_email());

DROP POLICY IF EXISTS contractor_sms_number_prefs_owner_or_admin_read ON public.contractor_sms_number_preferences;
CREATE POLICY contractor_sms_number_prefs_owner_or_admin_read ON public.contractor_sms_number_preferences FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.contractor_sms_numbers n WHERE n.id = number_id));

DROP POLICY IF EXISTS sms_suppression_admin_read ON public.sms_suppression_list;
CREATE POLICY sms_suppression_admin_read ON public.sms_suppression_list FOR SELECT TO authenticated USING (public.is_admin_email());

DROP POLICY IF EXISTS contractor_sms_staff_actions_admin_read ON public.contractor_sms_staff_actions;
CREATE POLICY contractor_sms_staff_actions_admin_read ON public.contractor_sms_staff_actions FOR SELECT TO authenticated USING (public.is_admin_email());

COMMIT;
