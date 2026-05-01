-- SQL v60 ROLLBACK: support_tickets table
-- Run this to undo v60-support-tickets.sql

DROP TABLE IF EXISTS public.support_tickets CASCADE;
-- Note: set_updated_at() function is shared — only drop if not used by other tables
-- DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE;
