-- STATUS (gh-1438, as of 2026-10-14T15:07:42Z): NOT APPLIED
-- FILE ROLE: forward file of set gh1916_contractors_sms_consent_phone (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted 2026-10-14 under D-383 (issue #2732 answer "(a) Consented phone only"); no production query run by the author (SELECT-only grant withheld for this dispatch); the column is new, so `contractors.sms_consent_phone` is expected absent -- pre-flight query in the pre-flight file
-- REPO COPY: none in supabase/migrations/ yet
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-1916 / D-383 (extends D-328; narrows D-131's SMS leg). Tier 3A: one additive, nullable column.
--
-- A contractor's consent box (contractor-join.html #smsConsent, contractor-pre-approval.html #agreeTcpaSms)
-- is a consent for ONE phone number: the one on the account when the box was ticked. Texts must go only to
-- that number, not to notification_phones added later in Settings. This column stores that number.
--
--   NULL = no consented number recorded = NO contractor SMS (fail closed). Every existing row is NULL;
--   production had 0 contractors with sms_opt_in = true when this was written (#1916 walk, 6158508341), so
--   nothing is withheld from anyone and no backfill is needed or attempted.
--
-- No default, no NOT NULL, no index, no grant (column inherits the table's existing privileges and RLS).
-- ORDER OF DEPLOY: apply this BEFORE deploying notify-contractors, process-dunning, send-contractor-nudge,
-- or publishing js/auth.js and contractor-pre-approval.html -- all of them select or write this column.

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS sms_consent_phone text DEFAULT NULL;

COMMENT ON COLUMN public.contractors.sms_consent_phone IS
  'gh-1916/D-383: the phone number on the account at the moment sms_opt_in was set (as typed; compared by its 10 digits). Contractor SMS is sent ONLY to this number. NULL = no consented number = no send. Written with sms_opt_in at contractor-join signup (js/auth.js) and at contractor-pre-approval onboarding.';
