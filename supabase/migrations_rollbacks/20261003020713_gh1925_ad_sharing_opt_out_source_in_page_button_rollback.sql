-- Rollback for: 20261003011500_gh1925_ad_sharing_opt_out_source_in_page_button.sql
-- GitHub: #1925
-- REFUSES while any profile row has ad_sharing_opt_out_source = 'in_page_button': narrowing the CHECK would make those rows
-- invalid (VALIDATE would fail), and re-labelling them would destroy compliance evidence of HOW the person opted out.
-- Operator must first decide, in the open, what those rows should say. Roll back the static privacy.html change first, or it
-- will keep PATCHing 'in_page_button' and fail against the narrowed check.

BEGIN;

DO $rb$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.profiles WHERE ad_sharing_opt_out_source = 'in_page_button';
  IF n > 0 THEN
    RAISE EXCEPTION 'gh1925 rollback refused: % profile row(s) record source in_page_button (compliance evidence). Resolve deliberately first.', n;
  END IF;
END
$rb$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_ad_sharing_opt_out_source_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_ad_sharing_opt_out_source_check
  CHECK (ad_sharing_opt_out_source IS NULL
         OR ad_sharing_opt_out_source IN ('gpc_header', 'gpc_client', 'support_email')) NOT VALID;

ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_ad_sharing_opt_out_source_check;

COMMIT;
