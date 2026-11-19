-- gh-3374 (second bump): move the server-held contractor AGREEMENT version label from 'v3-2026-11' to 'v4-2026-11' (D-366 / D-138 Amendment 2).
-- STATUS (gh-1438, as of 2026-11-19T13:12:27Z): NOT APPLIED
-- EVIDENCE: drafted on main ae1feafd. Read-only production reads by the author on 2026-11-19 (Supabase SELECT, project yeszghaspzwwstvsrioa): agreement_version_current = one row, 'v3-2026-11', set_at 2026-11-05 18:07:45Z; accept_cpa() reads it; cpa_versions current = 'v1-2026-04'; contractors with an acceptance, non-test: 0 (all 14 accepted rows are is_test); non-test contractors: 1, pending_approval, agreement_version NULL; newest ledger version 20261119122245.
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, R-177 pair, R-097 24-hour notice, Dustin's GO, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh3374_agreement_version_bump_v4_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3374_agreement_version_bump_v4_pre-flight.md  Proof (BEGIN ... ROLLBACK, throwaway Postgres): supabase/tests/gh3374_agreement_version_bump_v4_proof.sql
--
-- What changes: ONE row. public.agreement_version_current.version_label 'v3-2026-11' -> 'v4-2026-11', set_at = now(). Nothing else: accept_cpa(), the freeze trigger, the grants and
-- the CPA version ('v1-2026-04', public.cpa_versions) are untouched. From the moment this runs, a contractor who FIRST accepts through accept_cpa() is stamped
-- contractors.agreement_version = 'v4-2026-11'. Contractors already stamped keep their value (no backfill; a re-acceptance fills only a NULL). Rows touched: 1 (the singleton).
-- WHY: the label covers the Terms as well as the Agreement (Ben, #3374 comment 6993956936). Visible Terms text merged after the v3-2026-11 bump: #3713 (Terms 15.5, 2026-11-18),
-- #3794 (Terms 8.5, merged 2026-11-19T12:36:14Z) and #3718 (Privacy 14, merged 2026-11-19T12:40:38Z). One bump batches them, before the first real contractor accepts.
-- CONSENT: the label is the record of which legal text a contractor accepted. The label string 'v4-2026-11' and the decision to apply are Dustin's (ASK-DUSTIN on #3374); this file decides neither.
-- ORDER: apply only when #3794 and #3718 are live on the published site (live fetch), so that no acceptance is recorded under a label whose text is not on the page, and before the
-- first real contractor accepts. Guard: refuses (55000) if the row is missing or holds anything other than the expected old label; a re-run after success is a no-op.

DO $bump$
DECLARE
  cur text;
BEGIN
  SELECT a.version_label INTO cur FROM public.agreement_version_current a WHERE a.singleton FOR UPDATE;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'gh3374 v4: public.agreement_version_current has no row' USING ERRCODE = '55000';
  END IF;
  IF cur = 'v4-2026-11' THEN
    RAISE NOTICE 'gh3374 v4: already v4-2026-11, nothing to do';
    RETURN;
  END IF;
  IF cur <> 'v3-2026-11' THEN
    RAISE EXCEPTION 'gh3374 v4: expected v3-2026-11, found %', cur USING ERRCODE = '55000';
  END IF;
  UPDATE public.agreement_version_current SET version_label = 'v4-2026-11', set_at = now() WHERE singleton;
END
$bump$;
