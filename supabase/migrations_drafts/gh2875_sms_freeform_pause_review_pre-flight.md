<!-- STATUS (gh-1438, as of 2026-10-23): NOT APPLIED -->
# Pre-flight: gh2875_sms_freeform_pause_review (#2875, D-391 free-text opt-out flagger)

Tier 3B, consent path. Draft only: nothing here is applied until REVIEW: PASS, LEGAL-READ, CEO `R-177 SIGNED:`, the R-097 window and the CTO's recorded apply.

## Pre-flight measured 2026-10-23 (production yeszghaspzwwstvsrioa, SELECT only, Supabase MCP execute_sql)
- `to_regclass`: contractor_sms_numbers, sms_suppression_list, sms_disclosure_versions present; **sms_optout_review NULL**; is_admin_email() and both layer-1 functions present.
- `count(*)`: contractor_sms_numbers 0, sms_suppression_list 0.
- Ledger: `20261021013907:gh2875_d391_contractor_sms_numbers` (layer 1 applied).
- md5(pg_get_functiondef): contractor_textable_numbers(uuid) `9e531db5dda91d2028560e75d62c77cb`; contractor_sms_numbers_promote_primary() `9a29c4c6eca303a24b66630dd0db72ad`.

## Re-check immediately before apply
Same three queries; the two md5s must still match (if they differ, someone changed layer 1; re-base the function bodies first).

## After apply
- `select to_regclass('public.sms_optout_review')` not NULL; `select public.sms_number_paused('+15155550142')` = false.
- `has_function_privilege('authenticated','public.sms_number_paused(text)','EXECUTE')` = false; `has_table_privilege('authenticated','public.sms_optout_review','INSERT')` = false.
- Negative control: in a rolled-back transaction insert a pending row for a throwaway number, confirm `sms_number_paused` = true and that number is absent from `contractor_textable_numbers(<test contractor>)`; roll back.

## Blast radius
Adds one empty table and one function; redefines two layer-1 functions to add one AND NOT clause (no sender reads them yet, 0 verified numbers exist). Rollback restores the layer-1 bodies verbatim.
