-- gh-3237 check: p18_slug_is_reserved() is true for both names after gh3237_reserved_slugs_add is applied. Read-only (SELECT only), safe
-- on production after the apply. Phase-aware for the throwaway proof: psql -v phase=before|after (default after).
-- Output: "name|expected|actual|PASS or FAIL" per row, then "FAILING=<n>".
\set ON_ERROR_STOP on
\if :{?phase}
\else
  \set phase after
\endif
WITH expect AS (
  SELECT 'partner-agreement-v3' AS slug UNION ALL SELECT 'ref-bind' UNION ALL SELECT 'Partner-Agreement-V3'
), rows AS (
  SELECT 'reserved: ' || e.slug AS name,
         CASE WHEN :'phase' = 'after' THEN 'true' ELSE 'false' END AS expected,
         public.p18_slug_is_reserved(e.slug)::text AS actual
    FROM expect e
  UNION ALL
  SELECT 'control: partner-agreement stays reserved', 'true', public.p18_slug_is_reserved('partner-agreement')::text
  UNION ALL
  SELECT 'control: an unserved name is not reserved', 'false', public.p18_slug_is_reserved('jane-smith-realty')::text
)
SELECT name || '|' || expected || '|' || actual || '|' || CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END FROM rows
UNION ALL
SELECT 'FAILING=' || count(*) FILTER (WHERE expected IS DISTINCT FROM actual) FROM rows;
