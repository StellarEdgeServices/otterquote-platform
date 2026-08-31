-- gh-1387 — payment-method verification guards + remediation of the rows that
-- proved the defect.
--
-- WHAT WENT WRONG
-- ---------------
-- contractor-settings.html wrote every payment-method field itself, from the
-- browser. Nothing anywhere in the codebase ever wrote
-- contractors.has_payment_method -- the column had no writer at all -- and the
-- gate in get-contractor-info therefore fell back to "is stripe_payment_method_id
-- non-empty?", which is not evidence of anything. Three production contractors
-- rows hold a pm_/cus_ pair that resolves ONLY in Stripe TEST mode:
--
--   986ce2b6  PFW Roofing 1787836001   pm_1U93hp0AJRnqIYPUdVEvdh2M  (livemode=false, last4 4242)
--   ee452a12  Stohler Roofing, LLC     pm_1U6tH60AJRnqIYPUkpbRtTBh  (livemode=false)
--   8fa0d121  PFW Walk Roofing LLC     pm_1TstNn0AJRnqIYPUk5xl6UkF  (livemode=false)
--
-- On an id-only gate those contractors pass, the homeowner awards the job, the
-- envelope goes out, and the charge fails later against the live key.
--
-- Separately, stripe.retrievePaymentMethod() takes a CLIENT SECRET, not a
-- payment-method id, so the browser's lookup always threw; the catch swallowed
-- it and persisted the display placeholder '••••' into last_four. That was still
-- happening on 2026-08-31 against a genuine live-mode card
-- (pm_1UAUSi0AJRnqIYPUPLqRhoXm, livemode=true, real last4 6389).
--
-- WHAT THIS DOES
-- --------------
-- 1. Clears the three test-mode id sets so those contractors re-add a card
--    through the new verified path. They are all is_test fixtures; no customer
--    is affected. The ids are recorded above and in the rollback file, so
--    nothing is lost.
-- 2. Repairs the one placeholder last_four whose card IS verified live-mode.
-- 3. Adds contractors_has_payment_method_requires_verified_method: the flag may
--    only be true alongside a payment-method id and four real digits. Combined
--    with the code change -- verify-payment-method is now the only writer of
--    has_payment_method, and it only writes after re-reading the SetupIntent
--    with the charging key -- "flag is true" now means "Stripe confirmed this".
-- 4. Adds claims_awarded_requires_selected_contractor as NOT VALID: a claim in
--    awarded/selected must name a contractor. NOT VALID leaves the one historical
--    violation in place as evidence while still enforcing every future write --
--    which is precisely the "cannot recur silently" requirement.
--
-- THE ROW LEFT ALONE, DELIBERATELY
-- --------------------------------
-- claim f3bfb1f9-8d5a-42fb-9b35-11167957842a (is_test) is status=awarded with
-- selected_contractor_id NULL, contract_sent_at 2026-07-08, envelope
-- 5d1b7137-e281-800d-83e3-25bf211756ff -- and ZERO quotes. It cannot be repaired
-- into a valid awarded state because there is no bid and no contractor to point
-- at. Rewriting its status would destroy the only surviving trace of a July-era
-- failure that nobody has explained yet. It stays, and the NOT VALID constraint
-- is exactly the mechanism that lets it stay without licensing a repeat.
--
-- ROLLBACK: 20260831125120_gh1387_payment_method_verification_guards_rollback.sql
--
-- ALREADY APPLIED. Recorded in supabase_migrations.schema_migrations as version
-- 20260831125120 -- which is why this file carries that stamp and not the
-- 20260831130000 it was first written under. apply_migration assigns its own
-- timestamp at execution time, and a filename that disagrees with the recorded
-- version is not cosmetic: the runner would read this file as unapplied and
-- re-run it, and the ADD CONSTRAINT statements below would fail with
-- duplicate_object (42710), taking the whole migration run down with them.
-- gh-1253 lost a backfill to the mirror image of this mismatch (a file whose
-- version sorted BELOW the high-water mark was skipped in silence). Renamed to
-- match reality; do not "restore" the original stamp.

BEGIN;

-- ── 1. Retire the test-mode Stripe ids ───────────────────────────────────────
DELETE FROM public.contractor_payment_methods
 WHERE stripe_payment_method_id IN (
   'pm_1U93hp0AJRnqIYPUdVEvdh2M',
   'pm_1U6tH60AJRnqIYPUkpbRtTBh',
   'pm_1TstNn0AJRnqIYPUk5xl6UkF'
 );

UPDATE public.contractors
   SET has_payment_method          = false,
       stripe_payment_method_id    = NULL,
       stripe_payment_method_last4 = NULL,
       stripe_payment_method_brand = NULL,
       stripe_customer_id          = NULL,
       updated_at                  = now()
 WHERE id IN (
   '986ce2b6-39fd-4a2c-aba4-a806c618c8c0',
   'ee452a12-c16e-4d30-9d2c-df8128fbce52',
   '8fa0d121-d7e1-4064-8da3-c1bf6d83a4be'
 );

-- ── 2. Repair the verified live-mode row's placeholder last4 ─────────────────
-- Digits confirmed read-only against the live Stripe API on 2026-08-31.
UPDATE public.contractor_payment_methods
   SET last_four = '6389',
       brand     = 'MASTERCARD'
 WHERE stripe_payment_method_id = 'pm_1UAUSi0AJRnqIYPUPLqRhoXm';

-- ── 3. The flag may only be true when it is backed by a real method ──────────
ALTER TABLE public.contractors
  ADD CONSTRAINT contractors_has_payment_method_requires_verified_method
  CHECK (
    has_payment_method IS NOT TRUE
    OR (
      stripe_payment_method_id IS NOT NULL
      AND stripe_payment_method_id <> ''
      AND stripe_payment_method_last4 ~ '^[0-9]{4}$'
    )
  );

-- ── 4. An awarded claim must name its contractor ─────────────────────────────
-- NOT VALID: enforced on every future INSERT/UPDATE, not retroactively applied
-- to the f3bfb1f9 evidence row documented above.
ALTER TABLE public.claims
  ADD CONSTRAINT claims_awarded_requires_selected_contractor
  CHECK (
    status NOT IN ('awarded', 'selected')
    OR selected_contractor_id IS NOT NULL
  ) NOT VALID;

COMMIT;
