-- gh-2154 P-5 / #2123 (HO-2) — additive `leads.meta_lead_id` column so the
-- homeowner path of meta-leadgen-webhook can dedupe a Meta lead-form
-- delivery on `public.leads`, the same way P-5's original migration
-- (20260924213000_gh2154_p5_meta_lead_id.sql) added the identically-named,
-- identically-shaped column to `public.referral_agents` for the partner
-- path. This file does the `leads` half that migration's own header
-- explicitly deferred ("PARTNER PATH ONLY ... the homeowner `leads` path
-- (#2123) is explicitly NOT built").
--
-- NOT APPLIED BY THIS PR — Tier 3A (additive-only: one new nullable, UNIQUE
-- column; no existing column, constraint, policy, or function altered or
-- dropped), but this repo's own convention (see every migration cited above)
-- is that a claim-holder applies it by hand after review, not that a PR
-- merge applies it. Do not run this against production from this PR.
--
-- Schema check before drafting (read via the Supabase MCP, SELECT only,
-- 2026-09-26): `public.leads` has no `meta_lead_id` column today (confirmed
-- against information_schema.columns) and no unique index on any column
-- named similarly — this ADD COLUMN cannot collide with anything live.
--
-- Why UNIQUE and nullable, exactly mirroring the referral_agents column:
--   - UNIQUE gives index.ts's registerHomeownerLead() a real Postgres
--     unique_violation (23505) to catch on a race between two deliveries of
--     the same leadgen_id, the same dedupe-of-last-resort the partner path
--     already relies on beneath its own isDuplicate() read-then-write gap.
--   - Nullable because every `leads` row NOT sourced from this webhook
--     (the router's own anon insert, `partner-re.html`'s legacy path,
--     etc.) has no Meta lead id at all and must not be forced into a
--     placeholder value that would collide under the UNIQUE constraint.
--
-- Does not touch `leads.variant` (reused as the funnel id, e.g. 'ho-2' —
-- see gh2011_leads_variant.sql's own header for why that column carries no
-- CHECK constraint and is safe to reuse this way) or any existing UTM
-- column — both already exist on `leads` and need no migration.
--
-- Idempotent (`ADD COLUMN IF NOT EXISTS`), matching this repo's established
-- convention for every migration cited above.

BEGIN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS meta_lead_id text UNIQUE;

COMMENT ON COLUMN public.leads.meta_lead_id IS
  'gh-2154 P-5 / #2123 (HO-2): Meta Lead Ads leadgen_id for a homeowner lead captured through meta-leadgen-webhook''s native-form path. NULL for every other leads row (the router''s own anon insert, legacy partner-re.html traffic, etc.). UNIQUE so a race between two webhook deliveries of the same leadgen_id surfaces as a Postgres unique_violation (23505), caught by index.ts and reported as duplicate_meta_lead — mirrors referral_agents.meta_lead_id (20260924213000_gh2154_p5_meta_lead_id.sql) exactly.';

COMMIT;

-- =============================================================================
-- ROLLBACK — run as a single transaction to revert this migration. Dropping
-- the column is sufficient; nothing else in the schema depends on it.
-- =============================================================================
-- BEGIN;
-- ALTER TABLE public.leads DROP COLUMN IF EXISTS meta_lead_id;
-- COMMIT;
