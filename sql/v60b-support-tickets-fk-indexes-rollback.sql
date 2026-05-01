-- SQL v60b ROLLBACK: Missing FK indexes on support_tickets
-- Run this to undo v60b-support-tickets-fk-indexes.sql

DROP INDEX IF EXISTS public.support_tickets_claim_id_idx;
DROP INDEX IF EXISTS public.support_tickets_contractor_id_idx;
DROP INDEX IF EXISTS public.support_tickets_user_id_idx;
