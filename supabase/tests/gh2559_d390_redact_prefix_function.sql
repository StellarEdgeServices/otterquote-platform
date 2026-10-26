-- gh-2559 / D-390 proof NEGATIVE CONTROL: the function body as it stood at head 31b90853 (patterns, NO Unicode fold). Loaded over the fixed function by the proof,
-- to show the Unicode probes fail on it (they leaked), then the forward file is run again to restore the fixed function. Throwaway Postgres only.
CREATE OR REPLACE FUNCTION public.d390_redact_contact(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(p_text, '[[:alnum:]._%+-]+\s*@\s*[[:alnum:]-]+(\s*\.\s*[[:alnum:]-]+)*', '[removed]', 'g'), '[[:alnum:]._%+-]+\s*(?:[\(\[\{<]\s*at\s*[\)\]\}>]|\s+at\s+)\s*[[:alpha:]][[:alnum:]-]*(?:\s*(?:\.|[\(\[\{<]\s*dot\s*[\)\]\}>]|\s+dot\s+)\s*[[:alpha:]][[:alnum:]-]*)+', '[removed]', 'gi'), '\S+\s+at\s+\S+\s+dot\s+\S+', '[removed]', 'gi'), '\S*@\S*', '[removed]', 'g'), '\m\d{3}[/\\]\d{4}\M', '[removed]', 'g'), '\(?\d{3}\)?[^[:alnum:],\n]{1,3}\d{3}[^[:alnum:],\n]{1,3}\d{4}(?!\d)', '[removed]', 'g'), '(\+?\d[\s().-]*){7,}', '[removed] ', 'g');
$fn$;
