-- STATUS (gh-1438, as of 2026-11-18T21:13:35Z): APPLIED forward (ledger version 20261118193522, gh3199_admin_email_template_review_read; #3199 comment 6989532009); this rollback was NOT run
-- FILE ROLE: rollback file of set gh3199_admin_email_template_review_read (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-11-15 under #3199. Restores the production policy set read 2026-11-15 (contractor_templates_self and contractor_templates_admin only). Forward applied 2026-11-18 on Dustin's chat word "Go A-H." (14:30 ET) by Ben, CEO RUN 155 (claim ceo-2026-11-18T18:18:18Z); pg_policy on public.contractor_templates after apply held 4 policies (#3199 comment 6989532009).
-- REPO COPY: forward supabase/migrations/20261118193522_gh3199_admin_email_template_review_read.sql (filed by PR #3801); this rollback lives here beside it.
-- DO NOT RUN unless the forward policies must be undone.
--
-- Rollback of gh3199_admin_email_template_review_read: drops the two is_admin_email() policies. After this, ADMIN_EMAILS admins again see an empty template-review queue.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS contractor_templates_admin_email_select ON public.contractor_templates;
DROP POLICY IF EXISTS contractor_templates_admin_email_update ON public.contractor_templates;

DO $p$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policy WHERE polrelid = 'public.contractor_templates'::regclass;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'gh3199 rollback post-check: expected 2 policies on contractor_templates, found %', v_n;
  END IF;
END
$p$;

COMMIT;
