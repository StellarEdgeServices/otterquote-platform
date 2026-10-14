<!--
STATUS (gh-1438, as of 2026-10-14T15:07:42Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh1916_contractors_sms_consent_phone (the STATUS is the set's; it describes the forward migration)
EVIDENCE: written by gh-1916 (D-383); no production query was run by the author, the SELECTs below are for the applier
REPO COPY: none in supabase/migrations/ (forward draft: supabase/migrations_drafts/gh1916_contractors_sms_consent_phone.sql)
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh1916_contractors_sms_consent_phone

**Refs** #1916, D-383 (issue #2732). **Tier 3A** (one additive nullable column). **Not applied.**

## What it does
`ALTER TABLE public.contractors ADD COLUMN IF NOT EXISTS sms_consent_phone text DEFAULT NULL` plus a column comment. No row is read or rewritten.

## Pre-flight SELECTs (read-only; run before applying)
```sql
-- 1. the column must not exist yet
SELECT count(*) AS col_exists FROM information_schema.columns
 WHERE table_schema='public' AND table_name='contractors' AND column_name='sms_consent_phone';   -- expect 0
-- 2. who is opted in today (expect 0 real; any row here keeps NULL consent phone = no send, by design)
SELECT count(*) total, count(*) FILTER (WHERE sms_opt_in IS TRUE) opted_in FROM public.contractors;  -- #1916 6158508341 read 15 | 0
```
## Post-apply SELECT
```sql
SELECT count(*) FILTER (WHERE sms_consent_phone IS NOT NULL) AS with_phone, count(*) AS total FROM public.contractors;  -- expect 0 | 15 (or current total)
```
## Order of deploy (matters)
1. Apply the migration. 2. Deploy `notify-contractors`, `process-dunning`, `send-contractor-nudge` (each selects the column; a SELECT of a missing column errors). 3. Publish `js/auth.js` and `contractor-pre-approval.html` (each writes the column; a write to a missing column errors the whole contractor insert/update). Never in the other order.

## Behaviour after deploy
A contractor with `sms_opt_in = true` and a NULL `sms_consent_phone` (all rows consented before this column) gets no text and the refusal is logged. Email is unaffected.

## Open (not decided by D-383, not assumed here)
Whether a contractor who changes the consented number must re-consent. As built, a later phone change does NOT move the consented number: texts keep going to the old number until the contractor consents again at a surface that writes a new `sms_consent_phone`; no such re-consent surface exists yet. Left for the legal read to flag and Dustin to rule.

## Residual risk
The column is client-writable under the contractor's own RLS, like `sms_opt_in`. A contractor could write any number into it. Same trust level as the existing consent columns; a column freeze in `contractors_freeze_privileged_columns()` is a possible follow-up (Tier 3B), not in this set.
