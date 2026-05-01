-- SQL v60b: Missing FK indexes on support_tickets (D-195)
-- Applied: 2026-04-28
-- Rollback: v60b-support-tickets-fk-indexes-rollback.sql
-- Reason: v60 created support_tickets with claim_id and contractor_id FKs
--         but omitted indexes on those columns — detected by unindexed FK scan.

CREATE INDEX IF NOT EXISTS support_tickets_claim_id_idx
  ON public.support_tickets (claim_id)
  WHERE claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_tickets_contractor_id_idx
  ON public.support_tickets (contractor_id)
  WHERE contractor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx
  ON public.support_tickets (user_id)
  WHERE user_id IS NOT NULL;
