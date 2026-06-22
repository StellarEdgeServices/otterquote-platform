-- Phase 16 RLS Unit 5 — fix contractor_cert_verifications wrong-column ownership (86e1wquxq/86e1xpb3h)
-- D-220 Tier-3, Dustin-approved 2026-06-18; D-221 Path A
-- contractor_id is a FK to contractors.id, but the policies compared it to auth.uid() (=user_id),
-- so they were effectively always-false (under-grant: contractors could not read/insert their own
-- cert verifications). Correct mapping is contractor_id IN (own contractors). Right-scopes the
-- policy so it can never over-grant. service_role policy unchanged. 0 rows => no data impact.
-- Rollback: ALTER both policies back to (contractor_id = (select auth.uid())) [+ the insert tail].
ALTER POLICY "ccv contractor read own" ON public.contractor_cert_verifications
  USING (contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (select auth.uid())));

ALTER POLICY "ccv contractor insert pending own" ON public.contractor_cert_verifications
  WITH CHECK (
    contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (select auth.uid()))
    AND status = 'pending'
    AND source = 'admin_upload'
  );
