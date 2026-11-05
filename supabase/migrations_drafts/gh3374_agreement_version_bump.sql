-- gh-3374: move the server-held contractor AGREEMENT version label from 'v2-2026-10' to 'v3-2026-11' (D-366 / D-138 Amendment 2).
-- STATUS (gh-1438, as of 2026-11-05T18:07:53Z): APPLIED
-- EVIDENCE: applied to production 2026-11-05T18:07:45Z from this file at PR #3405 head 3b0ab9de (sha256 7f8d2a24d233...), on Dustin's word in chat 2026-11-05 12:59 ET. Ledger version 20261105180745, name gh3374_agreement_version_bump. Read back 18:07:53Z: agreement_version_current.version_label = v3-2026-11. Record: #3374 comment 6665505964.
-- public.agreement_version_current and its seed 'v2-2026-10' come from supabase/migrations_drafts/gh3073_agreement_version_stamp.sql, which the #3073
-- thread records as APPLIED 2026-10-29 (ledger 20261029190222, comment 6505803035); the applier re-reads that first (pre-flight).
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, R-177 pair, R-097 24-hour notice, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh3374_agreement_version_bump_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3374_agreement_version_bump_pre-flight.md  Proof (BEGIN ... ROLLBACK, throwaway Postgres): supabase/tests/gh3374_agreement_version_bump_proof.sql
--
-- What changes: ONE row. public.agreement_version_current.version_label 'v2-2026-10' -> 'v3-2026-11', set_at = now(). Nothing else: accept_cpa(), the freeze
-- trigger, the grants and the CPA version ('v1-2026-04', public.cpa_versions) are untouched. From the moment this runs, a contractor who FIRST accepts through
-- accept_cpa() is stamped contractors.agreement_version = 'v3-2026-11'. Contractors already stamped keep their value (no backfill; a re-acceptance fills only a NULL).
-- ORDER: apply only when the Agreement text the label stands for is live (PR #3400, the Central Time wording in Agreement 6.4, merged and published), so that no
-- acceptance is recorded under a label whose text is not on the page. The label 'v3-2026-11' is a proposal: Ben rules on it (PR body, Q1).
-- Guard: refuses (55000) if the row is missing or holds anything other than the expected old label; a re-run after success is a no-op.

DO $bump$
DECLARE
  cur text;
BEGIN
  SELECT a.version_label INTO cur FROM public.agreement_version_current a WHERE a.singleton FOR UPDATE;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'gh3374: public.agreement_version_current has no row' USING ERRCODE = '55000';
  END IF;
  IF cur = 'v3-2026-11' THEN
    RAISE NOTICE 'gh3374: already v3-2026-11, nothing to do';
    RETURN;
  END IF;
  IF cur <> 'v2-2026-10' THEN
    RAISE EXCEPTION 'gh3374: expected v2-2026-10, found %', cur USING ERRCODE = '55000';
  END IF;
  UPDATE public.agreement_version_current SET version_label = 'v3-2026-11', set_at = now() WHERE singleton;
END
$bump$;
