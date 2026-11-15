-- gh-1339 rollback: removes the Section 2 declarations guard. Additive migration, so nothing else changes.
DROP TRIGGER IF EXISTS quotes_require_section2_declarations ON public.quotes;
DROP FUNCTION IF EXISTS public.enforce_quote_section2_declarations();
