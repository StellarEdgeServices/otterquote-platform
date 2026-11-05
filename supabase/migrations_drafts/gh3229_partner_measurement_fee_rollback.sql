-- STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3229_partner_measurement_fee (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-30 under #3229. Restores the production state read 2026-10-30: payout_approvals_payout_type_check = ('commission_referral','commission_recruit'); none of the objects below exist. No database was written to produce this file.
-- REPO COPY: none. When applied, move to supabase/migrations_rollbacks/ beside the filed forward migration.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3229_partner_measurement_fee. It refuses (and changes nothing) while money state exists: any batched or paid fee event, or any
-- measurement_fees_monthly payout row. Accrued and void events carry no payout and are dropped with the table; export them first if wanted.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $g$
BEGIN
  IF to_regclass('public.partner_fee_events') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.partner_fee_events WHERE status IN ('batched', 'paid')) THEN
    RAISE EXCEPTION 'gh3229 rollback refused: partner_fee_events has batched or paid rows';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payout_approvals WHERE payout_type = 'measurement_fees_monthly') THEN
    RAISE EXCEPTION 'gh3229 rollback refused: payout_approvals has measurement_fees_monthly rows';
  END IF;
END $g$;

DROP TRIGGER IF EXISTS partner_fee_follow_payout_delete ON public.payout_approvals;
DROP TRIGGER IF EXISTS partner_fee_follow_payout_status ON public.payout_approvals;
DROP TRIGGER IF EXISTS partner_fee_release_on_reject ON public.payout_approvals;
DROP TRIGGER IF EXISTS partner_fee_accrue_on_order ON public.hover_orders;

DROP FUNCTION IF EXISTS public.partner_fee_events_follow_payout();
DROP FUNCTION IF EXISTS public.partner_fee_release_on_reject();
DROP FUNCTION IF EXISTS public.partner_fee_events_mark_paid(uuid);
DROP FUNCTION IF EXISTS public.create_monthly_fee_batch(date);
DROP FUNCTION IF EXISTS public.get_partner_dashboard_stats();
DROP FUNCTION IF EXISTS public.partner_fee_accrue_on_order();

DROP TABLE IF EXISTS public.partner_fee_events;

ALTER TABLE public.payout_approvals DROP CONSTRAINT IF EXISTS payout_approvals_payout_type_check;
ALTER TABLE public.payout_approvals ADD CONSTRAINT payout_approvals_payout_type_check
  CHECK (payout_type = ANY (ARRAY['commission_referral'::text, 'commission_recruit'::text]));

DELETE FROM public.platform_settings WHERE key IN ('partner_measurement_fee_cents', 'partner_payout_minimum_cents');
COMMIT;
