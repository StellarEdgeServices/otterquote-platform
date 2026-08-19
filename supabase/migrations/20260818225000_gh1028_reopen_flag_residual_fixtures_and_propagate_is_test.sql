-- gh-1028 (reopened): adversarial-verifier findings, issue comment 5334687276.
-- Tier 3A, additive/idempotent, Dustin-approved 2026-08-18 ruling (flag + exclude,
-- do NOT delete) still governs.
--
-- Item 2 — flag the 2 residual internal-fixture `quotes` rows that were still
-- is_test=false and were 100% of cert_verification_quality.total_bids_post_d199
-- (live value = 2 before this migration): "Video Walk Test Roofing LLC"
-- (ca91add4-1019-49d5-9682-2e8ebe1e0c3c) and "PFW Walk Roofing LLC"
-- (e6261cb3-1132-4ce4-bb31-4231f3a801c7). These are pre-flight-walk / video-walk
-- QA fixtures, not the E2E harness (different account, different predicate) and
-- not real production bids. Identified by a stable predicate — the owning
-- profile's email matches the dustinstohler1+... internal-fixture pattern already
-- used elsewhere in this repo to flag E2E fixture accounts — not a hardcoded id
-- list (id list shown above only as documentation of what the predicate matched).
--
-- Item 4 — is_test did not propagate on write. log_bid_submitted() /
-- log_bid_accepted() inserted into activity_log without stamping is_test from the
-- source quotes row, so the *next* test-sourced bid would land unflagged and the
-- closes-on invariant ("every reporting view returns the same numbers with and
-- without the harness rows removed") only held as a point-in-time snapshot, not
-- going forward. Both triggers now carry NEW.is_test through.
--
-- Verified live before applying: this predicate matches exactly 2 quotes rows
-- (SELECT count(*) FROM quotes q JOIN contractors c ON c.id=q.contractor_id
--  JOIN profiles p ON p.id=c.user_id WHERE p.email ILIKE 'dustinstohler1+%'
--  AND NOT q.is_test) -> 2. After this migration, quotes.is_test=false count is 0
-- (all 4 rows in the entire quotes table are internal fixtures; there is no
-- production quote data yet).

UPDATE public.quotes q
   SET is_test = true
  FROM public.contractors c
  JOIN public.profiles p ON p.id = c.user_id
 WHERE q.contractor_id = c.id
   AND p.email ILIKE 'dustinstohler1+%'
   AND NOT q.is_test;

CREATE OR REPLACE FUNCTION public.log_bid_submitted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO activity_log (user_id, event_type, title, metadata, is_test)
  SELECT ct.user_id,
         'bid_submitted',
         'Bid submitted for ' || COALESCE(c.property_address, 'a project'),
         jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price),
         COALESCE(NEW.is_test, false)
  FROM claims c
  JOIN contractors ct ON ct.id = NEW.contractor_id
  WHERE c.id = NEW.claim_id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'log_bid_submitted trigger error: %', SQLERRM;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_bid_accepted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'awarded' AND (OLD.status IS NULL OR OLD.status != 'awarded') THEN
    INSERT INTO activity_log (user_id, event_type, title, metadata, is_test)
    SELECT ct.user_id,
           'bid_accepted',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'),
           jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price),
           COALESCE(NEW.is_test, false)
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
  END IF;
  RETURN NEW;
END;
$function$;
