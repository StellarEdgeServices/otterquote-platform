-- gh-2313: TCPA call/text consent-evidence store for PARTNERS who arrive through a Meta
-- Instant Form (meta-leadgen-webhook partner path). Requested by Sloane (#2306 ask 2); ruled
-- Tier A by Marty (#2306 comment 5876046128): the partner path writes a consent-evidence row,
-- key `partner_call_text_consent`, BEFORE register_partner(), mirroring lead_consents.
--
-- SHAPE CHOSEN: one NEW sibling table, public.partner_lead_consents. Nothing existing is altered.
--   Rejected: a nullable partner reference on public.lead_consents with a CHECK that exactly one
--   of lead_id/partner_id is set. It works, but it (a) runs DROP NOT NULL + ADD COLUMN + ADD
--   CONSTRAINT against the live D-299 homeowner evidence table (10 rows on 2026-09-28) and
--   its (lead_id, consent_key) unique constraint on a hot legal path, (b) still needs a second
--   unique index for the partner side, and (c) makes the rollback delicate (re-adding NOT NULL
--   fails once a partner row exists). The sibling table is purely additive, cannot affect the
--   homeowner flow, and rolls back with one DROP TABLE.
--   Also rejected: keying on referral_agents.id. The ruling requires the evidence BEFORE
--   register_partner(), so no referral_agents row exists yet. The evidence is keyed on the
--   Meta leadgen id instead; referral_agents.meta_lead_id already carries the same value, so
--   evidence and partner join on meta_lead_id with no FK and no ordering problem.
--
-- Tier: 3A (additive: one new table, nothing altered, dropped, renamed or rewritten). It
-- rides with a consent-capture code change that needs LEGAL-READ + R-177 SIGNED before merge.
-- NEVER APPLIED BY THE AUTHOR: this file is in the PR only.
--
-- Rollback: supabase/migrations_rollbacks/20260928211500_gh2313_partner_lead_consents_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/20260928211500_gh2313_partner_lead_consents_pre-flight.md

BEGIN;

-- One row per (Meta lead, consent key). The unique constraint makes a Meta redelivery, or a retry
-- after a register_partner() failure, safe: the second insert hits 23505 and the Edge Function
-- treats that as "evidence already written". FIRST RECORDED OUTCOME WINS.
-- consent_text is the exact wording rendered on the Meta form, supplied by the allowlist entry
-- (config) and stored verbatim, so the record survives any later copy change.
-- disclaimer_responses is Meta's raw custom_disclaimer_responses array for the lead (the response).
CREATE TABLE IF NOT EXISTS public.partner_lead_consents (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_lead_id          text        NOT NULL,
  form_id               text        NOT NULL,
  consent_key           text        NOT NULL,
  consent_given         boolean     NOT NULL,
  consent_text          text        NOT NULL,
  disclaimer_responses  jsonb,
  phone_as_typed        text,
  form_payload          jsonb,
  payload               jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_lead_consents_lead_key_uniq UNIQUE (meta_lead_id, consent_key),
  CONSTRAINT partner_lead_consents_meta_lead_id_nonempty CHECK (btrim(meta_lead_id) <> ''),
  CONSTRAINT partner_lead_consents_consent_text_nonempty CHECK (btrim(consent_text) <> '')
);

COMMENT ON TABLE public.partner_lead_consents IS
  'gh-2313: per-submission TCPA call/text consent evidence for partners who registered through a Meta Instant Form (exact form wording, given flag, Meta raw disclaimer response, phone as typed, form values). Written only by the meta-leadgen-webhook Edge Function (service role), BEFORE register_partner(). Keyed by Meta leadgen id; joins referral_agents on meta_lead_id (no FK: the evidence must exist before the partner row). RLS on with no policy: anon and authenticated cannot read or write it. Sibling of public.lead_consents (homeowners).';
COMMENT ON COLUMN public.partner_lead_consents.consent_text IS
  'The exact disclaimer wording as rendered on the Meta form, supplied by the META_LEADGEN_FORM_ALLOWLIST entry, capped at 2000 characters by the Edge Function.';
COMMENT ON COLUMN public.partner_lead_consents.disclaimer_responses IS
  'Meta Graph custom_disclaimer_responses array for the lead, as returned. Personal data adjacent; service-role read only.';
COMMENT ON COLUMN public.partner_lead_consents.phone_as_typed IS
  'The phone number exactly as the partner typed it into the Meta form, before any normalisation. Personal data; service-role read only.';
COMMENT ON COLUMN public.partner_lead_consents.form_payload IS
  'The submitted Meta form VALUES (name, email, phone, company). Personal data; service-role read only.';

ALTER TABLE public.partner_lead_consents ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policy: with RLS on, that denies anon and authenticated everything.
-- service_role bypasses RLS.

-- Supabase default privileges grant new public tables to anon and authenticated. Strip them
-- explicitly (RLS is one layer, the grant is the other), then grant only what the Edge Function
-- needs. No anon/authenticated grant is added.
REVOKE ALL ON TABLE public.partner_lead_consents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.partner_lead_consents TO service_role;

COMMIT;

-- =============================================================================
-- ROLLBACK lives in supabase/migrations_rollbacks/ (NOT here: a file in this
-- directory would be applied by the Supabase runner as a migration).
-- =============================================================================
