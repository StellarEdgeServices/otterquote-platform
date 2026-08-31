-- ROLLBACK for 20260831125120_gh1387_payment_method_verification_guards.sql
--
-- Run this to undo the gh-1387 guards. Note what rollback does and does not
-- restore, because the difference matters:
--
--   * The two CHECK constraints are dropped. That is the real, load-bearing
--     half of this rollback -- it restores the schema exactly.
--   * The test-mode Stripe ids are restored to the contractors rows for
--     forensic parity ONLY. They were never usable: every one of them resolves
--     in Stripe TEST mode and 404s against the live key this platform charges
--     with. Restoring them re-creates the broken state, it does not restore a
--     working one. has_payment_method is deliberately left FALSE even on
--     rollback, because setting it true would assert something untrue about
--     cards that cannot be charged.
--   * The three deleted contractor_payment_methods rows are recreated with
--     their original placeholder last_four ('••••') so the pre-migration state
--     is reproducible. Their original ids are preserved.
--
-- If you are rolling back because the CHECK constraint rejected a legitimate
-- write, prefer fixing the write. A row that cannot satisfy
-- "has_payment_method implies four real digits" is a row whose card cannot be
-- charged, and the constraint is the only thing that currently says so.

BEGIN;

ALTER TABLE public.claims
  DROP CONSTRAINT IF EXISTS claims_awarded_requires_selected_contractor;

ALTER TABLE public.contractors
  DROP CONSTRAINT IF EXISTS contractors_has_payment_method_requires_verified_method;

-- Restore the placeholder last4 on the live-mode row (undoes step 2).
UPDATE public.contractor_payment_methods
   SET last_four = '••••',
       brand     = 'CARD'
 WHERE stripe_payment_method_id = 'pm_1UAUSi0AJRnqIYPUPLqRhoXm';

-- Restore the three test-mode id sets (undoes step 1).
UPDATE public.contractors
   SET stripe_customer_id          = 'cus_V9MP3ZEkVF6xfj',
       stripe_payment_method_id    = 'pm_1U93hp0AJRnqIYPUdVEvdh2M',
       stripe_payment_method_last4 = '••••',
       stripe_payment_method_brand = 'CARD',
       updated_at                  = now()
 WHERE id = '986ce2b6-39fd-4a2c-aba4-a806c618c8c0';

UPDATE public.contractors
   SET stripe_customer_id          = 'cus_V77PSFUafK6nbC',
       stripe_payment_method_id    = 'pm_1U6tH60AJRnqIYPUkpbRtTBh',
       stripe_payment_method_last4 = '••••',
       stripe_payment_method_brand = 'CARD',
       updated_at                  = now()
 WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52';

UPDATE public.contractors
   SET stripe_customer_id          = 'cus_Usc7FE83jjD30r',
       stripe_payment_method_id    = 'pm_1TstNn0AJRnqIYPUk5xl6UkF',
       stripe_payment_method_last4 = '••••',
       stripe_payment_method_brand = 'CARD',
       updated_at                  = now()
 WHERE id = '8fa0d121-d7e1-4064-8da3-c1bf6d83a4be';

INSERT INTO public.contractor_payment_methods
  (id, contractor_id, stripe_payment_method_id, payment_type, last_four, brand, is_default, created_at)
VALUES
  ('e8e4d399-4fd3-4a66-8922-b151cf430fe8', '8fa0d121-d7e1-4064-8da3-c1bf6d83a4be',
   'pm_1TstNn0AJRnqIYPUk5xl6UkF', 'card', '••••', 'CARD', true, '2026-07-13 23:35:33.54858+00'),
  ('ecfaa02f-fa8d-44f1-9995-c39e3812dcae', 'ee452a12-c16e-4d30-9d2c-df8128fbce52',
   'pm_1U6tH60AJRnqIYPUkpbRtTBh', 'card', '••••', 'CARD', true, '2026-08-21 14:18:30.690843+00'),
  ('58342fef-3a4a-4847-9342-1c80fcb5004d', '986ce2b6-39fd-4a2c-aba4-a806c618c8c0',
   'pm_1U93hp0AJRnqIYPUdVEvdh2M', 'card', '••••', 'CARD', true, '2026-08-27 13:51:03.097907+00')
ON CONFLICT (id) DO NOTHING;

COMMIT;
