<!--
STATUS (gh-1438, as of 2026-11-16): NOT APPLIED
FILE ROLE: pre-flight file of set 20261116030000_gh3762_dunning_sms_pending_marker
EVIDENCE: payment_failures has no column named sms% and 2 rows (information_schema / count SELECTs, project yeszghaspzwwstvsrioa, 2026-11-16)
REPO COPY: none
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3762 dunning SMS pending marker

- Tier 3A: two new nullable columns, no default, no rewrite, no drop. Danger patterns (DROP, ALTER TYPE, NOT NULL, RLS, grants): none.
- Why: PR #3774 REVIEW B1. Quiet hours (08:00-20:00 contractor local) would otherwise DROP the D-130 reminder and 8 AM warning texts. The marker defers only the text; email, state advance and next_reminder_at are unchanged.
- Order: apply this migration, THEN deploy process-dunning. The Edge Function writes the columns only when a text was actually refused (a contractor with a textable number), so a deploy before the apply cannot break the money path, but the drain query would log a non-fatal error each run.
- Rollback: `..._rollback.sql` drops both columns (deploy the previous process-dunning first).
- Verification after apply: SELECT column_name FROM information_schema.columns WHERE table_name='payment_failures' AND column_name LIKE 'sms_pending%'; expect 2 rows; SELECT count(*) FROM payment_failures WHERE sms_pending_kind IS NOT NULL; expect 0.
