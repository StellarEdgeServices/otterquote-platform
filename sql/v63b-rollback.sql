-- ROLLBACK for v63b_d204_cert_verification_quality

DROP VIEW IF EXISTS public.cert_verification_quality;

ALTER TABLE public.contractors
  DROP COLUMN IF EXISTS cert_status;
