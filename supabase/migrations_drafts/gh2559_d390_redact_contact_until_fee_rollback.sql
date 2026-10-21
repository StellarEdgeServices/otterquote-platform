-- STATUS (gh-1438, D-390): NOT APPLIED -- rollback of gh2559_d390_redact_contact_until_fee
-- DO NOT RUN FROM THIS DIRECTORY. Restores public.bidder_claim_summary to the fee-gated text (the applied ledger 20261008231303 view plus the #2931 gate on the
-- estimate_filename and measurements_filename CASEs; the selected contractor reads the notes as typed), then drops the thread view, the restrictive policy and the function. Order matters: the view is restored BEFORE the function is
-- dropped. No data is touched. Run in one transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS d390_homeowner_text_prefee ON public.messages;
DROP VIEW IF EXISTS public.contractor_thread_messages;

CREATE OR REPLACE VIEW public.bidder_claim_summary
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
  -- damage_type is a free-text box on the two insurance intake forms (placeholder "e.g. Wind, Hail"). It is returned
  -- only when it is made of damage words and joining punctuation (the closed list below, at most 60 characters);
  -- anything else reads 'Other' (every bidder page prints "Other" as it stands; NULL would print "Unknown",
  -- "Not specified", "-" or, on the dashboard, "Roofing", which says something the homeowner did not). A blank or NULL stays NULL.
  CASE WHEN c.damage_type IS NULL OR btrim(c.damage_type) = '' THEN NULL
       WHEN length(c.damage_type) <= 60
        AND c.damage_type ~* '^\s*((hail|wind|storm|tree|trees|fire|water|leak|leaks|roof|roofing|siding|gutter|gutters|window|windows|age|aging|wear|ice|snow|tornado|hurricane|lightning|flood|impact|partial|replacement|repair|damage|other|unknown|and)\s*|[&/,+.\u2013\u2014-]\s*)+$'
       THEN c.damage_type
       ELSE 'Other' END                                                         AS damage_type,
  c.material_category,
  c.shingle_type,
  c.impact_class,
  c.designer_product,
  c.designer_manufacturer,
  -- brand and colour: typed text on the repair intake and the homeowner dashboard. Read through the same Unicode fold as
  -- the notes ("fx" below), then refused (NULL) when they hold an @, a web address with or without a scheme (a dot
  -- followed by letters), the words at / dot / call / text / cell / phone / mail / code / gate / contact, a seven-digit
  -- run or a phone-shaped run, a digit together with a street-type or unit word, or more than 60 characters.
  -- NOT caught, and said so in the pre-flight: a plain name or a word with no digit ("Rosalind Ketterby").
  CASE WHEN fx.brand ~* '@|https?:|www\.|\d{7}|\d{3}[^[:alnum:]]+\d{3}|[[:alnum:]-]\.[[:alpha:]]{2,}|\m(at|dot|call|text|cell|phone|email|e-mail|mail|code|gate|lockbox|contact|wife|husband)\M|\d.*\m(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|cir|trl|hwy|pkwy|unit|apt|lot|box)\M|\m(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|cir|trl|hwy|pkwy|unit|apt|lot|box)\M.*\d' OR length(fx.brand) > 60 THEN NULL ELSE fx.brand END AS existing_shingle_brand,
  CASE WHEN fx.color ~* '@|https?:|www\.|\d{7}|\d{3}[^[:alnum:]]+\d{3}|[[:alnum:]-]\.[[:alpha:]]{2,}|\m(at|dot|call|text|cell|phone|email|e-mail|mail|code|gate|lockbox|contact|wife|husband)\M|\d.*\m(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|cir|trl|hwy|pkwy|unit|apt|lot|box)\M|\m(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|pl|place|cir|trl|hwy|pkwy|unit|apt|lot|box)\M.*\d' OR length(fx.color) > 60 THEN NULL ELSE fx.color END AS existing_shingle_color,
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
  CASE WHEN c.measurement_shape IN ('basic', 'full') THEN c.measurement_shape END AS measurement_shape,
  -- the parsed summary of the uploaded estimate: carrier, date of loss, pricing database, sections and
  -- line items, summary totals (keys read from production 2026-10-06: carrier_name, pricing_database,
  -- sections, format_detected, date_of_loss, summary). Nothing in the database checks this object for
  -- the homeowner's identity: the parser is instructed not to output it (parse-loss-sheet), and that
  -- instruction is the only safeguard. A check is a named remaining part of #2559.
  c.parsed_line_items,
  c.contractor_scope_summary,
  c.urgency,
  c.urgency_deadline,
  -- urgency_reason (free text the homeowner types) is NOT in this view: no bidder page shows it (checked in
  -- contractor-opportunities.html, contractor-bid-form.html, contractor-dashboard.html and the React app),
  -- so it is left out rather than filtered (review 6050015567: a pattern filter is the wrong tool for a
  -- column nobody reads).
  -- homeowner_notes is free text typed by the homeowner (CEO ruling, PR #2578 comment 6045859470): the
  -- selected contractor reads it as typed; every other caller reads the redacted text (the "ft" join below).
  -- A repair claim's notes come from the repair intake, which does not label the box "Notes for
  -- Contractors", so they are withheld before selection.
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
  CASE WHEN c.selected_contractor_id = ct.id AND c.platform_fee_charged IS TRUE THEN c.estimate_filename END      AS estimate_filename,
  CASE WHEN c.selected_contractor_id = ct.id AND c.platform_fee_charged IS TRUE THEN c.measurements_filename END  AS measurements_filename
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
        AND s.city !~* '\m(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|run|pike|row|xing|crossing|sq|square|alley|aly)\.?(\s+(n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)\.?)?\s*$'
        AND s.city !~* '\m(unit|apt|apartment|suite|ste|lot|box|bldg|building|floor|fl|rm|room|trlr|trailer|po)\M'
      ORDER BY cand.ord
      LIMIT 1)                                                                 AS city,
    coalesce(
      substring(c.property_address FROM '(?i)\m(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)[\s,]+(\d{5})(?:-\d{4})?\s*$'),
      substring(btrim(c.property_zip) FROM '^(\d{5})(?:-\d{4})?$'))           AS zip
) loc ON true
-- idn: what identifies THIS claim's homeowner, worked out once per row for the redaction below.
--   house        the house number of the claim's own address (leading digits of the first comma part)
--   street_words the tokens of that first part (letters and digits) that hold a letter, are three characters
--                or more, and are not one of the words excluded at line 207 ("123 N Main St Apt 4"
--                gives main; "1420 E 96th St" gives 96th)
--   name_long / name_short / name_caps  the words, three letters or more, of profiles.full_name (where
--                production keeps the homeowner's name; claims.homeowner_name is empty on every real claim) and
--                of claims.homeowner_name, folded (fx). Letters only, so each list is safe inside a pattern.
--   name_nl      the runs of characters outside ASCII in that name (Cyrillic, Greek, CJK, Arabic ...), two characters or more
--                (one character for Han, kana and Hangul): removed from a note as exact text, since there is no Latin spelling to fold to.
--                long = six letters or more (removed wherever they stand), short = three to five (removed as
--                whole words), caps = the short ones capitalised (removed when glued to another capital).
LEFT JOIN public.profiles pr ON pr.id = c.user_id
-- fx: one Unicode fold (review 6051111207 finding 2), applied to everything compared below, on BOTH sides, so a name
--   or street typed with accents, in a decomposed form, in full-width letters or digits, with zero-width characters,
--   or with letters that have no accent decomposition (l-stroke, o-slash, dotless i, d-stroke, sharp s, ae) meets its
--   plain-letter form: NFKD, then the combining marks that follow a Latin letter and the zero-width / direction /
--   variation characters are removed, a short table folds the letters NFKD leaves alone, then NFC (so Cyrillic,
--   Greek, kana and Hangul come back composed and an exact occurrence of a non-Latin name still matches).
--   nm = profile + claim name; st = the first part of the claim's address; notes = the notes (first 2000 characters);
--   brand / color = the two catalogue text columns.
LEFT JOIN LATERAL (
  SELECT normalize(replace(replace(replace(replace(replace(replace(replace(translate(regexp_replace(regexp_replace(normalize(coalesce(pr.full_name, '') || ' ' || coalesce(c.homeowner_name, ''), NFKD), U&'([A-Za-z])[\0300-\036F]+', '\1', 'g'), U&'[\00AD\034F\180E\200B-\200F\202A-\202E\2060-\2064\FE00-\FE0F\FEFF]', '', 'g'), U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126', 'lLoOidDdhH'), U&'\00DF', 'ss'), U&'\00E6', 'ae'), U&'\00C6', 'AE'), U&'\0153', 'oe'), U&'\0152', 'OE'), U&'\00FE', 'th'), U&'\00DE', 'Th'), NFC) AS nm,
         normalize(replace(replace(replace(replace(replace(replace(replace(translate(regexp_replace(regexp_replace(normalize(split_part(coalesce(c.property_address, ''), ',', 1), NFKD), U&'([A-Za-z])[\0300-\036F]+', '\1', 'g'), U&'[\00AD\034F\180E\200B-\200F\202A-\202E\2060-\2064\FE00-\FE0F\FEFF]', '', 'g'), U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126', 'lLoOidDdhH'), U&'\00DF', 'ss'), U&'\00E6', 'ae'), U&'\00C6', 'AE'), U&'\0153', 'oe'), U&'\0152', 'OE'), U&'\00FE', 'th'), U&'\00DE', 'Th'), NFC) AS st,
         normalize(replace(replace(replace(replace(replace(replace(replace(translate(regexp_replace(regexp_replace(normalize(left(c.homeowner_notes, 2000), NFKD), U&'([A-Za-z])[\0300-\036F]+', '\1', 'g'), U&'[\00AD\034F\180E\200B-\200F\202A-\202E\2060-\2064\FE00-\FE0F\FEFF]', '', 'g'), U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126', 'lLoOidDdhH'), U&'\00DF', 'ss'), U&'\00E6', 'ae'), U&'\00C6', 'AE'), U&'\0153', 'oe'), U&'\0152', 'OE'), U&'\00FE', 'th'), U&'\00DE', 'Th'), NFC) AS notes,
         normalize(replace(replace(replace(replace(replace(replace(replace(translate(regexp_replace(regexp_replace(normalize(c.existing_shingle_brand, NFKD), U&'([A-Za-z])[\0300-\036F]+', '\1', 'g'), U&'[\00AD\034F\180E\200B-\200F\202A-\202E\2060-\2064\FE00-\FE0F\FEFF]', '', 'g'), U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126', 'lLoOidDdhH'), U&'\00DF', 'ss'), U&'\00E6', 'ae'), U&'\00C6', 'AE'), U&'\0153', 'oe'), U&'\0152', 'OE'), U&'\00FE', 'th'), U&'\00DE', 'Th'), NFC) AS brand,
         normalize(replace(replace(replace(replace(replace(replace(replace(translate(regexp_replace(regexp_replace(normalize(c.existing_shingle_color, NFKD), U&'([A-Za-z])[\0300-\036F]+', '\1', 'g'), U&'[\00AD\034F\180E\200B-\200F\202A-\202E\2060-\2064\FE00-\FE0F\FEFF]', '', 'g'), U&'\0142\0141\00F8\00D8\0131\0111\0110\00F0\0127\0126', 'lLoOidDdhH'), U&'\00DF', 'ss'), U&'\00E6', 'ae'), U&'\00C6', 'AE'), U&'\0153', 'oe'), U&'\0152', 'OE'), U&'\00FE', 'th'), U&'\00DE', 'Th'), NFC) AS color
) fx ON true
LEFT JOIN LATERAL (
  SELECT CASE WHEN length(substring(fx.st FROM '^\s*(\d+)')) <= 12 THEN substring(fx.st FROM '^\s*(\d+)') END AS house,
         (SELECT string_agg(DISTINCT cap.w, '|') FROM (SELECT t.w AS w
                    FROM regexp_split_to_table(lower(fx.st), '[^a-z0-9]+') WITH ORDINALITY AS t(w, n)
                   WHERE length(t.w) BETWEEN 3 AND 40 AND t.w ~ '[a-z]'
                     AND t.w !~ '^(st|str|street|ave|av|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pl|place|cir|circle|ter|terrace|pkwy|parkway|hwy|highway|trl|trail|loop|pike|xing|crossing|alley|aly|north|south|east|west|unit|apt|apartment|suite|ste|lot|box|bldg|building|floor|room|trlr|trailer)$'
                   GROUP BY 1 ORDER BY min(t.n) LIMIT 40) AS cap) AS street_words,
         (SELECT string_agg(DISTINCT cap.w, '|')
            FROM (SELECT t.w AS w
                    FROM regexp_split_to_table(lower(fx.nm), '[^a-z]+') WITH ORDINALITY AS t(w, n)
                   WHERE length(t.w) BETWEEN 6 AND 40
                   GROUP BY 1 ORDER BY min(t.n) LIMIT 40) AS cap)                                  AS name_long,
         (SELECT string_agg(DISTINCT cap.w, '|')
            FROM (SELECT t.w AS w
                    FROM regexp_split_to_table(lower(fx.nm), '[^a-z]+') WITH ORDINALITY AS t(w, n)
                   WHERE length(t.w) BETWEEN 3 AND 5
                   GROUP BY 1 ORDER BY min(t.n) LIMIT 40) AS cap)                                   AS name_short,
         (SELECT string_agg(DISTINCT initcap(cap.w), '|')
            FROM (SELECT t.w AS w
                    FROM regexp_split_to_table(lower(fx.nm), '[^a-z]+') WITH ORDINALITY AS t(w, n)
                   WHERE length(t.w) BETWEEN 3 AND 5
                   GROUP BY 1 ORDER BY min(t.n) LIMIT 40) AS cap)                                  AS name_caps,
         (SELECT string_agg(DISTINCT cap.w, '|')
            FROM (SELECT t.m[1] AS w
                    FROM regexp_matches(lower(fx.nm), '([^\x01-\x7f\u3000-\u303f]+)', 'g') WITH ORDINALITY AS t(m, n)
                   WHERE length(t.m[1]) <= 40 AND (length(t.m[1]) >= 2 OR t.m[1] ~ U&'[\4E00-\9FFF\3040-\30FF\AC00-\D7AF]')
                   GROUP BY 1 ORDER BY min(t.n) LIMIT 40) AS cap)  AS name_nl
) idn ON true
-- idn cap (review 6066637484, Major 1). The address, the profile name and the claim number are text a homeowner writes, and
--   above they become regular expressions. A 100000-letter word, or an address of thousands of words, made the pattern
--   compiler fail ("regular expression is too complex", after about 36 seconds), which failed the whole statement and
--   emptied every bidder's list. The cap is applied to the TOKENS, after the text is split, and not to the raw string:
--   a cut through the middle of a word would leave a fragment that is no longer the whole word, so it could neither match
--   the note nor be dropped, and the cut could land inside a street name that is a real street. So: a token longer than 40
--   characters is dropped whole (no street or personal-name word in ordinary use comes near 40 characters; a longer run is not a word),
--   and at most the first 40 distinct tokens in the order they were typed are kept (a street line has under ten).
--   A house number longer than 12 digits is treated as no house number (the street-word rule then applies, which removes
--   more, never less). The claim number is cut to its first 100 characters before it is escaped (a literal prefix, so it
--   can only remove more of a note). The kept tokens are then sorted and joined exactly as before, so for any real address
--   or name the patterns are character for character what they were (when this cap was added, every planted claim of
--   tools/gh2559-bidder-view-behaviour.py was read through this file and through the file before it: every column of every
--   row was identical).
-- idn5: the claim's own street-name words of FIVE LETTERS OR MORE (CEO ruling 6063622505, item 1): the words in
--   idn.street_words (so never one of the words excluded at line 207) that hold five or more letters
--   ("2718 Juniper Bend Ct Unit 3" gives juniper; "1420 E 96th St" gives none). Used below with no house number needed.
LEFT JOIN LATERAL (
  SELECT string_agg(DISTINCT w, '|') AS own5
    FROM regexp_split_to_table(idn.street_words, '[|]') AS w
   WHERE length(regexp_replace(w, '[^a-z]', '', 'g')) >= 5
) idn5 ON true
-- ft: the two free-text columns as a caller who is not the selected contractor reads them
-- (CEO ruling 6045859470; review 6049068071 finding 1). Every replacement is the text '[removed]'.
--   WHOLE VALUE replaced when it holds the claim's own house number and one of its street words (with or
--     without "St": "house is 123 N Main, blue door"; an ordinal such as "96th" is a street word), or, for an
--     address with no house number, a street word.
--   WHOLE VALUE also replaced, with or without a house number in the note, when it holds one of the claim's own
--     street-name words of five letters or more (idn5; CEO ruling 6063622505): "blue house on Juniper Bend".
--   Otherwise, in this order, each match replaced where it stands:
--    a. the claim number (and, applied last, the homeowner's name words: first name alone, last name
--       alone, any order);
--    b. email addresses, also written with spaces or as "x at y dot com"; anything holding an @; web addresses;
--    c. phone numbers: three, three and four digits with ANY separators that are not letters, digits or a
--       comma (slash, dash of any kind, no-break space, underscore), and any run of seven or more digits
--       with spaces, dots, dashes or brackets between them;
--    d. street lines: a county-grid address ("9021 N 500 W"); the whole LINE holding a number followed within
--       five words by a street type (for road, way, place, drive, lane, court, trail ... only when it reads like a street line, so
--       "3 tab shingles, steep drive" and "2 story, the only way up" stay); capitalised words followed by a capitalised street type, with or without
--       a number before or after ("Larkspur Hollow Rd #9021"); a number of three to six digits followed by
--       capitalised words ("9021 Fox Run", "9021 Broadway"); a number of one or two digits followed by
--       capitalised words ending in a street or place type ("8 Otter Ridge"); none of these fires when the number is followed by a
--       unit, a roofing brand or a wind rating ("2400 Square Feet", "3000 SF", "2009 GAF Timberline", "150 MPH");
--    e. a number after the word code, pin or combination; a claim or policy number.
-- Not redacted, on purpose, because the same shape is an ordinary job description (pre-flight, RESIDUALS):
-- digit groups with words or a line break between them, a street written in lower case with no type word,
-- a name of one or two letters, and a name or address this row does not hold.
LEFT JOIN LATERAL (
  SELECT r.red AS notes
    FROM (
      SELECT CASE
               WHEN v.raw IS NULL THEN NULL
               WHEN idn.street_words IS NOT NULL AND idn.house IS NOT NULL
                    AND v.raw ~ ('\m' || idn.house || '\M') AND v.raw ~* ('\m(' || idn.street_words || ')\M') THEN '[removed]'
               WHEN idn.street_words IS NOT NULL AND idn.house IS NULL
                    AND v.raw ~* ('\m(' || idn.street_words || ')\M') THEN '[removed]'
               WHEN idn5.own5 IS NOT NULL
                    AND v.raw ~* ('\m(' || idn5.own5 || ')\M') THEN '[removed]'
               ELSE
      regexp_replace(
      regexp_replace(
      regexp_replace(regexp_replace(
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(
      regexp_replace(regexp_replace(
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(regexp_replace(
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      regexp_replace(
        v.raw,
        -- a. the claim number, when the row has one of four characters or more
        CASE WHEN length(btrim(coalesce(c.claim_number, ''))) >= 4
             THEN regexp_replace(left(btrim(c.claim_number), 100), '([^[:alnum:]])', '\\\1', 'g') ELSE '\A\Z\A' END, '[removed]', 'gi'),
        -- b. email and web
        '[[:alnum:]._%+-]+\s*@\s*[[:alnum:]-]+(\s*\.\s*[[:alnum:]-]+)*', '[removed]', 'g'),
        '[[:alnum:]._%+-]+\s*(?:[\(\[\{<]\s*at\s*[\)\]\}>]|\s+at\s+)\s*[[:alpha:]][[:alnum:]-]*(?:\s*(?:\.|[\(\[\{<]\s*dot\s*[\)\]\}>]|\s+dot\s+)\s*[[:alpha:]][[:alnum:]-]*)+', '[removed]', 'gi'),
        '\S+\s+at\s+\S+\s+dot\s+\S+', '[removed]', 'gi'),
        '\S*@\S*', '[removed]', 'g'),
        '(https?://\S+|www\.\S+|\S+\.(com|net|org|edu|gov|mil|io|co|us|info|biz|me|app|dev|ai|xyz|online|site|tech|uk|ca|homes|home|house|realty|space|page|link|blog|live|pro)(/\S*)?(?![[:alnum:]])|\S+\.[[:alpha:]]{2,}/\S*)', '[removed]', 'gi'),
        'https?://\S+', '[removed]', 'gi'),
        -- c. phone
        '\m\d{3}[/\\]\d{4}\M', '[removed]', 'g'),
        '\(?\d{3}\)?[^[:alnum:],\n]{1,3}\d{3}[^[:alnum:],\n]{1,3}\d{4}(?!\d)', '[removed]', 'g'),
        '(\+?\d[\s().-]*){7,}', '[removed] ', 'g'),
        -- d. street
        '\m\d+\s+[NSEWnsew]\.?\s+\d+\s+[NSEWnsew]\M\.?', '[removed]', 'g'),
        '\m\d{3,6}[A-Za-z]?[ \t]+((north|south|east|west|n|s|e|w)\.?[ \t]+)?\d+(st|nd|rd|th)\M', '[removed]', 'gi'),
        '\m\d{1,2}[ \t]+(north|south|east|west|n|s|e|w)\.?[ \t]+\d+(st|nd|rd|th)\M', '[removed]', 'gi'),
        '\m\d{1,2}[ \t]+\d{2,3}(st|nd|rd|th)\M', '[removed]', 'gi'),
        -- the whole LINE goes when a number is followed within five words by a street type that is not also an everyday word
        '^.*(\m\d+[[:alnum:]-]*\s+([^\s.;!?]+\s+){0,4}(st|str|street|ave|av|avenue|rd|blvd|boulevard|ln|pkwy|parkway|hwy|highway|trl|xing|aly|cir|ct|pl|ter|dr)\M|p\.?\s*o\.?\s*box\s*\d+).*$', '[removed]', 'gin'),
        -- ... and for the words that are also ordinary (road way place drive lane court trail loop circle terrace crossing alley pike) only when
        --     it reads like a street line: a number, then capitalised words with no punctuation, then the word capitalised; or a house number of
        --     three to six digits then one to three plain words, or of one or two digits then one or two plain words, then the word in any case
        --     (the first word is not a unit of measure or a roofing word, and no comma or full stop may stand between)
        '^.*\m\d+[[:alnum:]-]*[ \t]+([A-Z0-9][^\s.,;:!?]*[ \t]+){0,5}(Road|Way|Place|Drive|Lane|Court|Trail|Loop|Circle|Terrace|Crossing|Alley|Pike|ROAD|WAY|PLACE|DRIVE|LANE|COURT|TRAIL|LOOP|CIRCLE|TERRACE|CROSSING|ALLEY|PIKE)\M.*$', '[removed]', 'gn'),
        '^.*\m(\d{3,6}[A-Za-z]?[ \t]+(?!(?:sq|sqft|sf|lf|ft|feet|foot|inch|inches|square|squares|layer|layers|year|years|yr|yrs|mph|story|stories|tab|shingle|shingles|vent|vents|bundle|bundles|piece|pieces|linear|skylight|skylights|window|windows|door|doors|tree|trees|pipe|pipes|boot|boots|chimney|chimneys|dormer|dormers|roof|roofs|bid|bids|gutter|gutters|downspout|downspouts)\M)([A-Za-z0-9''’-]+[ \t]+){1,3}|\d{1,2}[A-Za-z]?[ \t]+(?!(?:sq|sqft|sf|lf|ft|feet|foot|inch|inches|square|squares|layer|layers|year|years|yr|yrs|mph|story|stories|tab|shingle|shingles|vent|vents|bundle|bundles|piece|pieces|linear|skylight|skylights|window|windows|door|doors|tree|trees|pipe|pipes|boot|boots|chimney|chimneys|dormer|dormers|roof|roofs|bid|bids|gutter|gutters|downspout|downspouts)\M)([A-Za-z0-9''’-]+[ \t]+){1,2})(road|way|place|drive|lane|court|trail|loop|circle|terrace|crossing|alley|pike)\M.*$', '[removed]', 'gin'),
        '(\m\d+[A-Za-z]?[ \t]+)?(([A-Z][[:alpha:]''’-]*|[A-Z][a-z]{0,2}\.)[ \t]+){1,8}(St|Str|Street|Ave|Av|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Trl|Trail|Loop|Pike|Xing|Crossing|Alley|Aly|ST|STR|STREET|AVE|AV|AVENUE|RD|ROAD|DR|DRIVE|LN|LANE|CT|COURT|BLVD|BOULEVARD|WAY|PL|PLACE|CIR|CIRCLE|TER|TERRACE|PKWY|PARKWAY|HWY|HIGHWAY|TRL|TRAIL|LOOP|PIKE|XING|CROSSING|ALLEY|ALY)\M\.?([ \t,]*#?[ \t]*\d+\M)?', '[removed]', 'g'),
        -- (not when the next word is a unit, a roofing brand or a wind rating: "2400 Square Feet", "3000 SF", "2009 GAF Timberline")
        '\m\d{3,6}[A-Za-z]?[ \t]+(?!(?:ATLAS|Atlas|BUNDLE|BUNDLES|Bundle|Bundles|CERTAINTEED|CORNING|CertainTeed|Corning|DURATION|Duration|FEET|FOOT|FT|Feet|Foot|Ft|GAF|IKO|INCH|INCHES|Inch|Inches|LANDMARK|LAYER|LAYERS|LF|LINEAR|Landmark|Layer|Layers|Linear|MALARKEY|MPH|Malarkey|OAKRIDGE|OWENS|Oakridge|Owens|PABCO|PIECE|PIECES|Pabco|Piece|Pieces|SF|SQ|SQFT|SQUARE|SQUARES|Sq|Sqft|Square|Squares|TAB|TAMKO|TIMBERLINE|Tab|Tamko|Timberline|YEAR|YEARS|Year|Years)\M)([A-Z][[:alpha:]''’-]*\.?[ \t,]+){0,7}[A-Z][[:alpha:]''’-]+', '[removed]', 'g'),
        '\m\d{1,2}[A-Za-z]?[ \t]+(([A-Z][[:alpha:]''’-]*|[A-Z][a-z]{0,2}\.)[ \t]+){1,4}(St|Str|Street|Ave|Av|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Cir|Circle|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Trl|Trail|Loop|Pike|Xing|Crossing|Alley|Aly|Ridge|Bend|Cove|Trace|Point|Run|Pass|Row|Square|Path|Walk|View|Hill|Hills|Glen|Grove|Park|Landing|Knoll|Bluff|Vista|Creek|Commons|Close|Hollow|Meadow|Meadows|Woods|Lake|Springs)\M', '[removed]', 'g'),
        -- e. codes and claim or policy numbers
        '\m((gate|door|garage|alarm|access|entry|lock\s*box|key\s*pad)\s*)?(code|pin|combo|combination)\s*:?\s*(is\s+)?#?\d{3,8}\M', '[removed]', 'gi'),
        '\m(claim|policy)\s*(no\.?|number|num|id|#)?\s*:?\s*#?[[:alnum:]-]*\d[[:alnum:]-]*', '[removed]', 'gi'),
        -- a. the homeowner's name words, last so that an email address is still whole when rule b reads it
        CASE WHEN idn.name_long IS NULL THEN '\A\Z\A' ELSE '(' || idn.name_long || ')(''?s)?' END, '[removed]', 'gi'),
        CASE WHEN idn.name_short IS NULL THEN '\A\Z\A' ELSE '(?<![a-z])(' || idn.name_short || ')(''?s)?(?![a-z])' END, '[removed]', 'gi'),
        CASE WHEN idn.name_caps IS NULL THEN '\A\Z\A' ELSE '(?<![a-z])(' || idn.name_caps || ')(?=[A-Z])|(?<=[a-z])(' || idn.name_caps || ')(?![a-z])' END, '[removed]', 'g'),
        -- a. a name in a script with no Latin letters (Cyrillic, Greek, CJK, Arabic ...): an exact occurrence of each token
        CASE WHEN idn.name_nl IS NULL THEN '\A\Z\A' ELSE '(' || idn.name_nl || ')' END, '[removed]', 'gi')
             END AS red
        -- the homeowner forms cap these at 500 characters; a bidder is given at most the first 2000, so a
        -- value written past the form cannot make the patterns above expensive
        FROM (VALUES (fx.notes)) AS v(raw)
    ) r
) ft ON true
WHERE (   ct.status = 'active'
      AND c.ready_for_bids IS TRUE
      AND c.status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text])
      AND c.is_test = ct.is_test)
   OR c.selected_contractor_id = ct.id
   OR EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = c.id AND q.contractor_id = ct.id);

DROP FUNCTION IF EXISTS public.d390_redact_contact(text);

DO $assert$
BEGIN
  IF pg_get_viewdef('public.bidder_claim_summary'::regclass) LIKE '%d390_redact_contact%' THEN
    RAISE EXCEPTION 'gh2559 d390 rollback: bidder view still calls the function' USING ERRCODE = 'P0D09';
  END IF;
  IF to_regprocedure('public.d390_redact_contact(text)') IS NOT NULL OR to_regclass('public.contractor_thread_messages') IS NOT NULL THEN
    RAISE EXCEPTION 'gh2559 d390 rollback: objects remain' USING ERRCODE = 'P0D0A';
  END IF;
END
$assert$;

COMMIT;
