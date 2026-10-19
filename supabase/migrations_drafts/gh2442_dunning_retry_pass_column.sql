-- STATUS (gh-1438, as of 2026-10-19T19:32:54Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_dunning_retry_pass_column
-- EVIDENCE: payment_failures.retry_handled_at absence on production is to be confirmed by the pre-flight SELECT (see the pre-flight file); authoring session read-only check noted there
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_dunning_retry_pass_column
-- GitHub: #2442. Companion to the process-dunning retry pass (supabase/functions/process-dunning/retry-pass.ts).
-- Tier: 3B (money-path table). NOT APPLIED by the authoring session or by CI.
-- Rollback: supabase/migrations_drafts/gh2442_dunning_retry_pass_column_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2442_dunning_retry_pass_column_pre-flight.md
-- Proof (to run rolled-back on production's PostgreSQL before the apply): supabase/tests/gh2442_dunning_retry_pass_column_proof.sql
--
-- What it does. Adds two nullable timestamptz columns, no default, to payment_failures:
--   retry_handled_at : the "consumed" marker the retry pass stamps (compare-and-set) BEFORE it calls Stripe, so one
--                      recorded request can produce at most one charge attempt.
--   retry_unknown_at : set when a Stripe call ends with an UNKNOWN outcome (timeout, 5xx, 409, 429, non-JSON). While
--                      set, the pass only looks the PaymentIntent up by metadata; it never charges the quote again.
--                      Cleared by the pass once the lookup resolves, or by a person.
-- A request is pending when the latest retry_requested_at of the quote's rows is newer than the latest
-- retry_handled_at. Nothing else changes: no grant, no policy, no function. request_dunning_retry() does not read
-- or write the column. The CHECK on retry_request_count (0..3) is untouched.
-- Apply order: THIS migration, then deploy process-dunning (the pass selects the column; without it the pass
-- throws inside its own try/catch and the reminder passes still run). The pass is off until
-- DUNNING_RETRY_PASS_ENABLED=true is set, and runs on STRIPE_SECRET_KEY_TEST while DUNNING_RETRY_PASS_TEST_MODE=true.
BEGIN;
ALTER TABLE public.payment_failures ADD COLUMN IF NOT EXISTS retry_handled_at timestamptz;
ALTER TABLE public.payment_failures ADD COLUMN IF NOT EXISTS retry_unknown_at timestamptz;
COMMENT ON COLUMN public.payment_failures.retry_handled_at IS
  'gh-2442: set by the process-dunning retry pass (service role) when it consumes a retry request, before any Stripe call. Pending request = latest retry_requested_at of the quote is newer than the latest retry_handled_at.';
COMMENT ON COLUMN public.payment_failures.retry_unknown_at IS
  'gh-2442: set by the process-dunning retry pass when a Stripe call for a retry request had an unknown outcome. While set the pass never charges this quote again; it looks the intent up by metadata and clears this.';
COMMIT;
