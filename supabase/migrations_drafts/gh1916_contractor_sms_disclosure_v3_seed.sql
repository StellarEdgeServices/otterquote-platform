-- STATUS (gh-1438, as of 2026-10-31): NOT APPLIED
-- FILE ROLE: forward file of set gh1916_contractor_sms_disclosure_v3_seed (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-31 under #1916 / #2875. No database was read or written to produce this file. Layer 1 (ledger 20261021013907
--   gh2875_d391_contractor_sms_numbers) is recorded applied (#2875 comment 6279160220 onward); that file states "sms_disclosure_versions gets NO row here".
-- REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh1916_contractor_sms_disclosure_v3_seed
-- GitHub: #1916 (contractor SMS opt-in), #2875 (D-391). Tier 3B (consent path). R-177: REVIEW + LEGAL-READ + CEO `R-177 SIGNED:` owed BEFORE this
--   is edited into final form and applied. Additive only: ONE INSERT into public.sms_disclosure_versions, nothing else.
-- Rollback: supabase/migrations_drafts/gh1916_contractor_sms_disclosure_v3_seed_rollback.sql
-- Pre-flight: supabase/migrations_drafts/gh1916_contractor_sms_disclosure_v3_seed_pre-flight.md
--
-- WHY THIS EXISTS. The contractor verify-a-number screen (js/contractor-sms-verify.js on contractor-pre-approval.html) renders the CURRENT row of
--   public.sms_disclosure_versions as its consent sentence, and contractor-sms-verify copies that same row onto each per-number consent record.
--   With no row, the screen offers nothing and no number can be verified (fail closed). This file is the row. Applying it is what turns the
--   opt-in ON, so it must not be applied before the wording is signed.
--
-- CANDIDATE WORDING, NOT RULED. The text below is the "Version A" disclosure from the legal read (In Flight/reports/ceo110-d391legal-20261018.md
--   section 1a, chosen by Dustin's "A", #2877 comment 6256672117 / D-391 Amendment 1), as reproduced in the wording pack (#2875 comment 6388102468,
--   piece 1), with the program-name phrase Dustin approved ("Approve all 3", recorded at #2875 comment 6478077931; Ben's RETRACTION 6478213024 limits
--   that approval to the three narrowed items). Two things are NOT ruled and are left as marked constants for the signer:
--     (1) BRAND SPELLING: the registered 10DLC campaign says "OtterQuote"; D-175 and every live surface say "Otter Quotes". Ben's recommendation
--         (#2875 comment 6388108919) is "Otter Quotes" with the campaign text corrected in the same Twilio edit. This draft uses "Otter Quotes".
--     (2) VERSION TAG: the wording pack says contractor-v3-[date it is signed]. The id below is a placeholder that the guard refuses.
--   The "SMS Terms" and "Privacy Policy" link URLs ARE stored in the text (LEGAL-READ 6545940873 note: the record must hold the consent language
--   as rendered, links included); the screen also renders them as anchors (sms-terms is the #3065 page, still to be published; the disclosure
--   must not go live before that page does).
--
-- EDIT BEFORE APPLYING (the DO block below refuses to run until you do): replace v_id with contractor-v3-YYYY-MM-DD (the signing date), confirm
--   v_brand, v_program and v_text against the signed wording, and change nothing else.

BEGIN;

DO $gate$
DECLARE
  -- >>> CLEARLY MARKED CONSTANTS: CANDIDATE, UNSIGNED <<<
  v_id      text := 'contractor-v3-DRAFT-UNSIGNED';
  v_program text := 'Otter Quotes Contractor Alerts';
  v_text    text := 'Text me at this number. I agree to receive automated texts from Otter Quotes (Otter Quotes Contractor Alerts) about my contractor account, '
                    'new job opportunities, bids, contracts, and payments. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. '
                    'Consent is not a condition of purchase. SMS Terms: https://otterquote.com/sms-terms Privacy Policy: https://otterquote.com/privacy.html';
BEGIN
  IF to_regclass('public.sms_disclosure_versions') IS NULL THEN
    RAISE EXCEPTION 'gh1916 gate: public.sms_disclosure_versions is missing (layer 1 gh2875_d391_contractor_sms_numbers not applied)';
  END IF;
  IF v_id ILIKE '%DRAFT%' OR v_id ILIKE '%UNSIGNED%' OR v_text LIKE '%[FILL%' OR v_program LIKE '%[FILL%' THEN
    RAISE EXCEPTION 'gh1916 gate: the disclosure is still a DRAFT. Replace v_id with the signed version tag and confirm the wording after R-177 SIGNED.';
  END IF;
  INSERT INTO public.sms_disclosure_versions (id, program_name, disclosure_text)
  VALUES (v_id, v_program, v_text)
  ON CONFLICT (id) DO NOTHING;
END
$gate$;

COMMIT;
