-- STATUS (gh-1438, as of 2026-11-15): NOT APPLIED
-- EVIDENCE: no trigger on public.quotes references `declarations` (pg_trigger/pg_proc SELECT, #1339 comment 6674161939, 2026-11-05); the 14 triggers on public.quotes read back 2026-11-15 (SELECT, project yeszghaspzwwstvsrioa) carry none of this name.
-- REPO COPY: none.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md. Tier 3A (R-097): needs the R-097 notice and a recorded apply; throwaway proof is supabase/tests/gh1339_quotes_declarations_proof_run.sh.
-- gh-1339 rollback: removes the Section 2 declarations guard. Additive migration, so nothing else changes.
DROP TRIGGER IF EXISTS quotes_require_section2_declarations ON public.quotes;
DROP FUNCTION IF EXISTS public.enforce_quote_section2_declarations();
