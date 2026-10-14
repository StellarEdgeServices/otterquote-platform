-- STATUS (gh-1438, as of 2026-10-14T07:22Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2431_profiles_address_state_backfill (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-2431 (CTO RUN 65); production read-only counts and a self-rolling-back proof are in supabase/migrations_rollbacks/gh2431_profiles_address_state_backfill_pre-flight.md
-- REPO COPY: none in supabase/migrations/ yet (copy in at apply time under a 14-digit version)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-2431 data repair (Tier 3B, production data write): the DEFAULT 'IN' and the 'IN' in handle_new_user()
-- were removed on 2026-10-07 (ledger 20261007201941). Homeowner profiles created BEFORE that still hold
-- the seeded 'IN'. The rule below clears 'IN' only where nothing shows the homeowner ever entered an
-- address: no street, city or zip, and the row was never updated after signup (updated_at within one
-- minute of created_at). An 'IN' that a homeowner typed leaves street/city/zip or updated_at behind.
-- Each cleared id is written to an audit table first-class so the rollback is exact.
-- Claims are not touched (claims.property_state is stored on the claim itself).
-- Rollback: supabase/migrations_rollbacks/gh2431_profiles_address_state_backfill_rollback.sql
-- NOT APPLIED by the authoring session. Apply only after REVIEW and the R-097 window.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gh2431_profiles_state_backfill_audit (
  profile_id  uuid PRIMARY KEY,
  prior_state text NOT NULL,
  repaired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.gh2431_profiles_state_backfill_audit ENABLE ROW LEVEL SECURITY;

WITH hit AS (
  UPDATE public.profiles
     SET address_state = NULL
   WHERE role = 'homeowner'
     AND address_state = 'IN'
     AND address_street IS NULL
     AND address_city IS NULL
     AND address_zip IS NULL
     AND updated_at <= created_at + interval '1 minute'
  RETURNING id
)
INSERT INTO public.gh2431_profiles_state_backfill_audit (profile_id, prior_state)
SELECT id, 'IN' FROM hit;

COMMIT;
