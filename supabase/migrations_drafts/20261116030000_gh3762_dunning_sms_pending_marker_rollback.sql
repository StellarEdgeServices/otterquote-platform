-- STATUS (gh-1438, as of 2026-11-16): NOT APPLIED
-- EVIDENCE: see the forward file; nothing to roll back until it is applied.
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md.
-- gh-3762 rollback: drops the two pending-text marker columns. Destroys only the transient markers (a text still pending is
-- lost, which is what quiet hours did before this change). Deploy the process-dunning that stops reading them FIRST, or it will
-- log a drain error each run (non-fatal; the passes continue).
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS sms_pending_since;
ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS sms_pending_kind;
