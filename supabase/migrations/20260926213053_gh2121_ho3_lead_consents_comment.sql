-- gh-2121 (HO-3), PR #2226 REVIEW N9: the lead_consents table comment (from
-- 20260923211259_gh2122_leads_details_consent.sql) says it is "Written only
-- by record_lead_details() via the record-lead-details Edge Function". That
-- is no longer true: create-lead-measurement-order also writes a row there,
-- for the ho3_measure_terms consent key (PR #2226 REVIEW L1). Update the
-- comment to name both writers instead of editing the original migration.
COMMENT ON TABLE public.lead_consents IS
  'gh-2122 / D-299: per-submission TCPA consent evidence for router leads (exact rendered text, given/not given, page URL, server-observed IP and user agent, non-PII payload summary). Written by record_lead_details() via the record-lead-details Edge Function (service role), and, since gh-2121 (HO-3, PR #2226), by create-lead-measurement-order for the ho3_measure_terms key. RLS on with no policy: anon and authenticated cannot read or write it.';
