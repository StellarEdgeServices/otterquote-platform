<!-- STATUS (gh-1438, as of 2026-10-19T22:51:02Z): NOT APPLIED -->
# Pre-flight: gh2875_d391_contractor_sms_numbers (#2875, D-391 layer 1)

Tier 3B. Draft only: nothing here is applied until `tier:3b-approved` (R-097 notice #2875 comment 6256733805, window closes
2026-10-19T23:54:07Z), a fresh-context REVIEW: PASS at the PR head, and the CTO's recorded apply.

## What it adds
Five tables (`sms_disclosure_versions`, `contractor_sms_numbers`, `contractor_sms_number_preferences`, `sms_suppression_list`,
`contractor_sms_staff_actions`), two trigger functions, and the sender read `contractor_textable_numbers(uuid)` (service_role only).
No existing object is altered. No row is written (the disclosure version table stays empty until the legal wording is signed).

## Checks before apply (production, read-only)
1. `select to_regclass('public.contractor_sms_numbers'), to_regclass('public.sms_suppression_list'), to_regclass('public.sms_disclosure_versions'), to_regclass('public.contractor_sms_number_preferences'), to_regclass('public.contractor_sms_staff_actions');` -> all NULL (measured NULL for the first two, 2026-10-19).
2. `select to_regprocedure('public.is_admin_email()');` -> not NULL (measured present 2026-10-19).
3. The proof passes at the PR head: `PGBIN=... bash supabase/tests/gh2875_d391_contractor_sms_numbers_proof_run.sh` -> `EXIT=0`.

## Checks after apply
- Check 1 returns five regclasses; `select count(*) from public.contractor_sms_numbers` = 0.
- As `authenticated`: `insert into public.contractor_sms_numbers ...` -> 42501 (P1 of the proof, against production with a throwaway
  is_test contractor only, or skip and rely on `has_table_privilege('authenticated','public.contractor_sms_numbers','INSERT')` = false).
- `select has_function_privilege('authenticated','public.contractor_textable_numbers(uuid)','EXECUTE')` = false.

## Blast radius
None at apply: no sender reads these tables yet (layer 4 switches them). After layer 4, a contractor with no row here gets no text,
which is the D-391 rule (AMENDMENT 1: texts are optional; e-mail is the fallback).

## Rollback
`gh2875_d391_contractor_sms_numbers_rollback.sql` drops all objects. Safe only while the tables are empty: once a verification or
opt-out row exists, it is a consent record with a retention duty (LEGAL-READ 6256074958); export before dropping, or do not drop.
