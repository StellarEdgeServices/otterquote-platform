-- gh-2442 proof for gh2442_dunning_retry_pass_column. NOT RUN by the authoring session. Run in ONE batch on
-- production's PostgreSQL; it ends in a deliberate RAISE so nothing persists. Expect the NOTICE lines as written.
DO $p$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_failures' AND column_name IN ('retry_handled_at','retry_unknown_at','retry_unknown_attempt');
  RAISE NOTICE '[BEFORE] retry_* columns present = % (expect 0: negative control)', n;
  ALTER TABLE public.payment_failures ADD COLUMN IF NOT EXISTS retry_handled_at timestamptz, ADD COLUMN IF NOT EXISTS retry_unknown_at timestamptz, ADD COLUMN IF NOT EXISTS retry_unknown_attempt jsonb;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_failures' AND column_name IN ('retry_handled_at','retry_unknown_at','retry_unknown_attempt');
  RAISE NOTICE '[AFTER] retry_* columns present = % (expect 3)', n;
  ALTER TABLE public.payment_failures DROP COLUMN IF EXISTS retry_handled_at, DROP COLUMN IF EXISTS retry_unknown_at, DROP COLUMN IF EXISTS retry_unknown_attempt;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_failures' AND column_name IN ('retry_handled_at','retry_unknown_at','retry_unknown_attempt');
  RAISE NOTICE '[ROLLED-BACK] retry_* columns present = % (expect 0)', n;
  RAISE EXCEPTION 'gh2442 proof complete; deliberate rollback of everything';
END
$p$;
