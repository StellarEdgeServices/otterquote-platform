-- Proof for gh2310 Gap 1. BEGIN ... ROLLBACK only; inlines the migration's predicate rather than \i-ing it, because the migration COMMITs. Run against production read/rollback or a branch.
BEGIN;
SELECT count(*) AS target_before FROM public.profiles WHERE email ILIKE '%@otterquote-internal.test' AND is_test=false;      -- expect 26 (measured 2026-09-28)
SELECT count(*) AS offdomain_true_before FROM public.profiles WHERE email NOT ILIKE '%@otterquote-internal.test' AND is_test=true;  -- negative control, 17
UPDATE public.profiles SET is_test=true WHERE email ILIKE '%@otterquote-internal.test' AND is_test=false;  -- same predicate as the migration (its own COMMIT is deliberately not included here)
SELECT count(*) AS target_after FROM public.profiles WHERE email ILIKE '%@otterquote-internal.test' AND is_test=false;       -- expect 0
SELECT count(*) AS offdomain_true_after FROM public.profiles WHERE email NOT ILIKE '%@otterquote-internal.test' AND is_test=true;   -- must equal offdomain_true_before
SELECT count(*) AS offdomain_false_after FROM public.profiles WHERE email NOT ILIKE '%@otterquote-internal.test' AND is_test=false; -- must equal 42 (unchanged)
ROLLBACK;
