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
- **Order (MUST): apply this migration BEFORE process-dunning or send-sms is deployed.** Earlier text here said a deploy before the apply "cannot break the money path". That was wrong. With the columns missing, a held text makes the state-advance update (which carries the marker) fail; the row would not advance (reminder_count / next_reminder_at / dunning_status), the next 30-minute run would pick the same row up again, and the warning/reminder EMAIL would be re-sent every run (the gh-2105 loop).
- Defence added in the code (not a substitute for the order): `updateFailureWithMarker()` retries the SAME state-advance update WITHOUT the marker fields when the marker write is rejected for a missing column, and logs `sms_pending_marker_unavailable`. State always advances and the email never loops, but while the columns are missing a held text is NOT deferred (it is dropped, as before this change). The pending-text drain query also fails (non-fatal, logged) each run. Treat any `sms_pending_marker_unavailable` log line as "migration not applied".
- The code path that writes the marker runs only for a contractor with a textable number whose text was held by quiet hours (today: none, `contractor_sms_numbers` has 0 rows), so the exposure window is narrow, but do not rely on that.
- Rollback: `..._rollback.sql` drops both columns (deploy the previous process-dunning first).
- Verification after apply: SELECT column_name FROM information_schema.columns WHERE table_name='payment_failures' AND column_name LIKE 'sms_pending%'; expect 2 rows; SELECT count(*) FROM payment_failures WHERE sms_pending_kind IS NOT NULL; expect 0.
