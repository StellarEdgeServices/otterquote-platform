-- ============================================================================
-- v85 ROLLBACK: Remove admin notification trigger for new contractor signups
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_notify_admin_new_contractor ON public.contractors;
DROP FUNCTION IF EXISTS public.notify_admin_new_contractor();

COMMIT;
