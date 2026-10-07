-- STATUS (gh-1438, as of 2026-10-07T19:20:06Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2559_bidder_claims_view, step 1 of 3 (see the apply order below; the STATUS is the set's)
-- EVIDENCE: written 2026-10-06T20:16:10Z; proved forward and rollback on production inside one rolled-back block (supabase/tests/gh2559_bidder_claims_view_proof.sql). pg_class read the same day: no view named bidder_claim_summary exists. No ledger row exists for this set. Changed 2026-10-07 after REVIEW: FAIL 6025641188 and again after REVIEW: FAIL 6047719061 on #2578: location_city, location_zip and the two free-text columns. This text was run verbatim on a throwaway Postgres 16 with planted addresses and notes (scripts/gh2559-bidder-view-behaviour.py); it has NOT been run on production by the worker who changed it.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2559_bidder_claims_view
-- GitHub: #2559 (the claims-row half that PR #2569 split out; PR #2569 comment 6024529507). Decision: D-368
--   (Dustin, 2026-10-06, comment 6018744630, "Summary only"), extended by his answer of 2026-10-07
--   (comment 6038067961, question 2: "City and zip only (Recommended)").
-- Tier: ADDITIVE. It creates one read-only view and changes nothing that exists, so no contractor loses a read
--   when it is applied. (The policy narrowing in gh2559_claims_policy_narrow.sql is the Tier 3B part.)
-- Rollback: supabase/migrations_drafts/gh2559_bidder_claims_view_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh2559_bidder_claims_view_pre-flight.md (column table, apply order)
-- Proof (rolled back, role-switched): supabase/tests/gh2559_bidder_claims_view_proof.sql
--
-- APPLY ORDER (all three steps, each waits for the one before):
--   1. THIS FILE (additive; nothing changes for anyone).
--   2. Merge this PR, then PUBLISH the static pages and the React app (Netlify production is locked until
--      published). The pages read the view from that moment. They need step 1 to be live FIRST.
--   3. gh2559_claims_policy_narrow.sql (Tier 3B, 24-hour R-097 notice), only after step 2 is live, because it
--      stops a bidding contractor reading the base claims row and the old pages read it.
--
-- WHY A VIEW AND NOT COLUMN PRIVILEGES. One database login role (authenticated) serves homeowners and
-- contractors, so a column GRANT cannot give a contractor fewer columns than the homeowner; today every
-- active contractor can SELECT all 130 columns of every claim open for bids (adjuster name, email and phone,
-- ingest emails, payment and signing reference ids, referral and click ids, homeowner name, claim number,
-- estimate file name). The view is owned by postgres (so it reads claims past row security, like a security
-- definer function) and carries its own row filter and its own column list. It is the ONLY thing a bidder
-- can read of a claim before selection once gh2559_claims_policy_narrow.sql is applied.
--
-- WHICH ROWS (one filter; same eligibility as the live policies, plus the world match)
--   a. open for bids: ready_for_bids, status in (active, bidding, pending), the caller an ACTIVE contractor,
--      and c.is_test = ct.is_test (a test contractor sees only test claims, a real contractor only real
--      ones). The live claims policy "Contractors can view biddable claims" lets a test contractor also see
--      real claims; the live storage policy and this view do not. See the pre-flight, QUESTION 1.
--   b. a claim the caller has a quote on (any quote status), so a contractor's own pending bids keep their
--      location and damage type after the claim closes. Matches the live policy "Contractors can view
--      claims for their quotes" (no status test on the contractor, as there).
--   c. a claim the caller is selected on (always also (b)).
-- WHICH COLUMNS: the allow-list in the pre-flight table, derived from what every bidder page reads.
--   Identity and contact columns (homeowner_name, claim_number, adjuster_*, ingest_*, user_id, referral and
--   click ids, signing and payment ids, the street address) are NOT in it. Where a page showed the street
--   address, it now shows location_city and location_zip. (One path outside this view also carried the
--   street to a bidder, the get-hover-siding-data edge function; the same PR changes its code, and until
--   that function is DEPLOYED the street is not gone for a claim with a completed vendor job.) estimate_filename and measurements_filename are
--   returned ONLY to the contractor the homeowner selected (the storage policy refuses them to anyone else,
--   and a path holds the homeowner's user id); for every other caller they read null, and has_estimate /
--   has_measurements still say whether the file exists, which is what the opportunity cards show.
--
-- SECURITY. security_barrier = true so a function in a caller's WHERE clause cannot run on rows the view's
--   own filter has not yet removed. auth.uid() is evaluated once per statement. The view has no search_path
--   of its own to pin (a view has no body that resolves names at run time: every name below is schema
--   qualified and resolved at CREATE time). Grants: see the end of the file.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE VIEW public.bidder_claim_summary
WITH (security_barrier = true)
AS
SELECT
  c.id,
  c.status,
  c.ready_for_bids,
  c.created_at,
  c.trades,
  c.job_type,
  c.funding_type,
  c.damage_type,
  c.material_category,
  c.shingle_type,
  c.impact_class,
  c.designer_product,
  c.designer_manufacturer,
  c.existing_shingle_brand,
  c.existing_shingle_color,
  c.rcv_amount,
  c.acv_amount,
  c.deductible_amount,
  c.roof_squares,
  c.repair_squares,
  -- the one number the bidder pages read out of hover_measurements (squares); the rest of that object
  -- (who entered it, areas by pitch, lengths) is not exposed
  CASE WHEN jsonb_typeof(c.hover_measurements) = 'object'
        AND jsonb_typeof(c.hover_measurements -> 'squares') = 'number'
       THEN (c.hover_measurements ->> 'squares')::numeric END AS measured_squares,
  c.measurement_shape,
  -- the parsed summary of the uploaded estimate: carrier, date of loss, pricing database, sections and
  -- line items, summary totals (keys read from production 2026-10-06: carrier_name, pricing_database,
  -- sections, format_detected, date_of_loss, summary). Nothing in the database checks this object for
  -- the homeowner's identity: the parser is instructed not to output it (parse-loss-sheet), and that
  -- instruction is the only safeguard. A check is a named remaining part of #2559.
  c.parsed_line_items,
  c.contractor_scope_summary,
  c.urgency,
  c.urgency_deadline,
  -- free text typed by the homeowner (CEO ruling, PR #2578 comment 6045859470): the selected contractor
  -- reads it as typed; every other caller reads the redacted text (the "ft" join below). A repair claim's
  -- notes come from the repair intake, which does not label the box "Notes for Contractors", so they are
  -- withheld before selection.
  CASE WHEN c.selected_contractor_id = ct.id THEN c.urgency_reason ELSE ft.urgency END   AS urgency_reason,
  CASE WHEN c.selected_contractor_id = ct.id THEN c.homeowner_notes
       WHEN c.job_type = 'repair' THEN NULL
       ELSE ft.notes END                                                       AS homeowner_notes,
  c.roofing_bid_released_at,
  c.gutters_bid_released_at,
  c.siding_bid_released_at,
  c.windows_bid_released_at,
  c.bid_window_expires_at,
  (c.estimate_filename IS NOT NULL OR coalesce(c.has_estimate, false))       AS has_estimate,
  (c.measurements_filename IS NOT NULL OR coalesce(c.has_measurements, false)) AS has_measurements,
  -- location: city and zip only (Dustin, comment 6038067961). The street address is never returned.
  -- Both values come from the "loc" join below, which refuses anything that looks like a street line,
  -- a unit, a box or a lot.
  loc.city                                                                     AS location_city,
  loc.zip                                                                      AS location_zip,
  cp.carrier_name                                                              AS carrier_profile_name,
  -- the caller's own id, only when the caller is the selected contractor; null for every other caller
  CASE WHEN c.selected_contractor_id = ct.id THEN ct.id END                    AS selected_contractor_id,
  CASE WHEN c.selected_contractor_id = ct.id THEN c.estimate_filename END      AS estimate_filename,
  CASE WHEN c.selected_contractor_id = ct.id THEN c.measurements_filename END  AS measurements_filename
FROM public.claims c
JOIN public.contractors ct ON ct.user_id = (SELECT auth.uid())
LEFT JOIN public.carrier_profiles cp ON cp.id = c.carrier_id
-- loc: city and zip, fail closed.
--   city: the first of (property_city, the SECOND comma part of property_address when it has a comma) that
--     survives every test below, after a trailing ", ST 12345" is cut off it. A candidate is refused (NULL)
--     when it contains a digit, a line break or any character other than letters, space, dot, apostrophe
--     and hyphen; when it is longer than 40 characters; when its LAST word is a street type (Rd, Street,
--     Ave, Ln, Ct, Blvd, Way ...); or when it contains a unit word (Unit, Apt, Suite, Lot, Box, Bldg ...).
--     Never the first comma part, never an unsplit address.
--   zip: the five digits at the END of property_address, and only when a US state code stands directly
--     before them ("..., IN 46032" or "... IN 46032-1234"); else property_zip when it is exactly a zip.
--     A box number, lot number or house number is never a zip (review 6047719061 finding 2).
LEFT JOIN LATERAL (
  SELECT
    (SELECT s.city
       FROM (VALUES (1, c.property_city),
                    (2, CASE WHEN position(',' IN c.property_address) > 0
                             THEN split_part(c.property_address, ',', 2) END)) AS cand(ord, raw)
       CROSS JOIN LATERAL (
         SELECT nullif(btrim(regexp_replace(cand.raw, '(^|[\s,]+)[A-Za-z]{2}[\s,]*\d{5}(-\d{4})?\s*$', '')), '') AS city
       ) s
      WHERE s.city IS NOT NULL
        AND s.city ~ '^[A-Za-z][A-Za-z .''-]*$'
        AND length(s.city) <= 40
        AND s.city !~* '\m(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|run|pike|row|xing|crossing|sq|square|alley|aly)\.?\s*$'
        AND s.city !~* '\m(unit|apt|apartment|suite|ste|lot|box|bldg|building|floor|fl|rm|room|trlr|trailer|po)\M'
      ORDER BY cand.ord
      LIMIT 1)                                                                 AS city,
    coalesce(
      substring(c.property_address FROM '(?i)\m(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)[\s,]+(\d{5})(?:-\d{4})?\s*$'),
      substring(btrim(c.property_zip) FROM '^(\d{5})(?:-\d{4})?$'))           AS zip
) loc ON true
-- ft: the two free-text columns as a caller who is not the selected contractor reads them. In order:
--   1. the whole value becomes '[removed]' when it contains the claim's own street line (first comma part
--      of property_address, 5+ characters) or the claim's homeowner_name (4+ characters), any case;
--   2. every LINE holding a house number followed within five words by a street type, or a PO box, becomes
--      '[removed]';
--   3. every email address becomes '[removed]';
--   4. every run of seven or more digits, with only spaces, dots, dashes and brackets between them (a phone
--      number in any common layout), becomes '[removed]'.
-- It cannot recognise a name it was not given or an address written without a number. That limit is stated
-- in the pre-flight; the ruling asks for phone numbers, email addresses and street-number lines.
LEFT JOIN LATERAL (
  SELECT max(r.red) FILTER (WHERE r.k = 'n') AS notes,
         max(r.red) FILTER (WHERE r.k = 'u') AS urgency
    FROM (
      SELECT v.k,
             CASE
               WHEN v.raw IS NULL THEN NULL
               WHEN length(btrim(split_part(coalesce(c.property_address, ''), ',', 1))) >= 5
                    AND position(lower(btrim(split_part(c.property_address, ',', 1))) IN lower(v.raw)) > 0 THEN '[removed]'
               WHEN length(btrim(coalesce(c.homeowner_name, ''))) >= 4
                    AND position(lower(btrim(c.homeowner_name)) IN lower(v.raw)) > 0 THEN '[removed]'
               ELSE regexp_replace(
                      regexp_replace(
                        regexp_replace(v.raw,
                          '^.*(\m\d+[[:alnum:]-]*\s+(\S+\s+){0,4}(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|pike|xing|crossing|alley|aly)\M|p\.?\s*o\.?\s*box\s*\d+).*$',
                          '[removed]', 'gin'),
                        '[[:alnum:]._%+-]+\s*@\s*[[:alnum:]-]+(\.[[:alnum:]-]+)+', '[removed]', 'g'),
                      '(\+?\d[\s().-]*){7,}', '[removed] ', 'g')
             END AS red
        FROM (VALUES ('n', c.homeowner_notes), ('u', c.urgency_reason)) AS v(k, raw)
    ) r
) ft ON true
WHERE (   ct.status = 'active'
      AND c.ready_for_bids IS TRUE
      AND c.status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text])
      AND c.is_test = ct.is_test)
   OR c.selected_contractor_id = ct.id
   OR EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = c.id AND q.contractor_id = ct.id);

COMMENT ON VIEW public.bidder_claim_summary IS
  'gh-2559 / D-368: what a contractor may read of a claim before selection (summary, no homeowner identity or contact). Owner-run; filters its own rows by auth.uid(). Raw file paths only for the selected contractor. Allow-list: supabase/migrations_drafts/gh2559_bidder_claims_view_pre-flight.md.';

-- GRANTS: none written here, on purpose. Supabase's default privileges on public already give a new
-- relation to anon, authenticated and service_role (ALL). This file REVOKES everything that is not read
-- access for the one role that needs it. Net effect: authenticated holds SELECT only, service_role keeps
-- its default, anon and PUBLIC hold nothing. There is no GRANT statement, so the permissions ratchet
-- (scripts/permissions-ratchet.py, "No new GRANT to anon/PUBLIC/authenticated") has nothing to flag.
-- The assertion below fails the migration if the defaults are not what this file assumes.
REVOKE ALL ON public.bidder_claim_summary FROM PUBLIC;
REVOKE ALL ON public.bidder_claim_summary FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.bidder_claim_summary FROM authenticated;

DO $assert$
DECLARE
  v_acl text;
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.bidder_claim_summary', 'SELECT') THEN
    RAISE EXCEPTION 'gh2559: authenticated cannot SELECT the view (default privileges changed?); a GRANT is needed and the PR needs the label "permissions-ratchet: reviewed"' USING ERRCODE = 'P0A01';
  END IF;
  IF has_table_privilege('anon', 'public.bidder_claim_summary', 'SELECT')
     OR has_table_privilege('anon', 'public.bidder_claim_summary', 'INSERT')
     OR has_table_privilege('authenticated', 'public.bidder_claim_summary', 'INSERT')
     OR has_table_privilege('authenticated', 'public.bidder_claim_summary', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.bidder_claim_summary', 'DELETE') THEN
    RAISE EXCEPTION 'gh2559: the view has more access than SELECT for authenticated' USING ERRCODE = 'P0A02';
  END IF;
  SELECT relacl::text INTO v_acl FROM pg_class WHERE oid = 'public.bidder_claim_summary'::regclass;
  RAISE NOTICE 'gh2559 view acl: %', v_acl;
END
$assert$;

COMMIT;
