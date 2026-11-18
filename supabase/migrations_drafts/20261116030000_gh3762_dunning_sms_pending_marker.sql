-- STATUS (gh-1438, as of 2026-11-16): NOT APPLIED
-- EVIDENCE: payment_failures has no column named sms% (information_schema SELECT, project yeszghaspzwwstvsrioa, 2026-11-16); table holds 2 rows.
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md. Tier 3A (R-097): additive, needs a recorded apply BEFORE the process-dunning deploy that reads it.
-- gh-3762 (#3726 item 5, PR #3774 REVISION 2) -- DRAFT, NOT APPLIED (Tier 3A, additive).
--
-- WHAT: two nullable columns on public.payment_failures marking a dunning TEXT (reminder or 8 AM warning) that quiet hours
-- refused, so a later process-dunning run can send it when the contractor's window opens.
--   sms_pending_kind   text         'reminder' | 'warning' (NULL = nothing pending)
--   sms_pending_since  timestamptz  when the text was refused (drives the 4-hour expiry)
-- No default, no backfill, no constraint, no index (the table is tiny and the drain filters on a NULL test), nothing rewritten,
-- nothing dropped. Existing readers/writers are unaffected: neither column is read or written until the new process-dunning
-- is deployed. APPLY THIS BEFORE deploying process-dunning or send-sms (see the pre-flight: a deploy first makes the marker write fail; the code then retries without it and logs sms_pending_marker_unavailable, but texts are not deferred). Email timing, state transitions and the D-130 schedule are NOT touched by this migration.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.payment_failures ADD COLUMN IF NOT EXISTS sms_pending_kind text;
ALTER TABLE public.payment_failures ADD COLUMN IF NOT EXISTS sms_pending_since timestamptz;

COMMENT ON COLUMN public.payment_failures.sms_pending_kind IS 'gh-3762: dunning text refused by quiet hours and awaiting the contractor window (reminder|warning); NULL = none';
COMMENT ON COLUMN public.payment_failures.sms_pending_since IS 'gh-3762: when the pending dunning text was refused; the text expires 4 hours after this or at the next sequence step';
