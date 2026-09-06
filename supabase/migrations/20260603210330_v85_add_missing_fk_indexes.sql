-- Migration: v85_add_missing_fk_indexes
-- Filed by: gh-1438 migration history backfill batch 3 (Code lane)
-- Date filed: 2026-09-03
--
-- STATUS: ALREADY APPLIED. This file is a post-apply trace added by the
-- gh-1438 migration history backfill (issue #1438, batch 3, non-money
-- orphans, oldest first) -- it does NOT re-apply anything; merging this PR
-- is a no-op against the database. Applied to production
-- (yeszghaspzwwstvsrioa) 2026-06-03T21:03:30Z, recorded in
-- supabase_migrations.schema_migrations as version 20260603210330, name
-- "v85_add_missing_fk_indexes". NEVER RE-RUN.
--
-- PROVENANCE: sourced verbatim via a read-only SELECT against
-- supabase_migrations.schema_migrations.statements for this version,
-- 2026-09-03, gh-1438 backfill batch 3. No SQL was executed against
-- production to produce this file -- no prior repo record for this
-- version was found; this is the first repo record of it.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_claims_user_id
    ON public.claims (user_id);

CREATE INDEX IF NOT EXISTS idx_admin_dispute_queue_claim_id
    ON public.admin_dispute_queue (claim_id);

CREATE INDEX IF NOT EXISTS idx_admin_dispute_queue_contractor_id
    ON public.admin_dispute_queue (contractor_id);

CREATE INDEX IF NOT EXISTS idx_contractor_templates_reviewed_by
    ON public.contractor_templates (reviewed_by);

CREATE INDEX IF NOT EXISTS idx_disputes_contractor_id
    ON public.disputes (contractor_id);

CREATE INDEX IF NOT EXISTS idx_disputes_quote_id
    ON public.disputes (quote_id);

CREATE INDEX IF NOT EXISTS idx_referral_agents_user_id
    ON public.referral_agents (user_id);

CREATE INDEX IF NOT EXISTS idx_warranty_manifest_drift_warranty_option_id
    ON public.warranty_manifest_drift (warranty_option_id);

COMMIT;
