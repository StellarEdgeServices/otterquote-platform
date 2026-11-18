<!--
STATUS (gh-1438, as of 2026-11-18T21:13:35Z): APPLIED to production as ledger version 20261118193522 (gh3199_admin_email_template_review_read; #3199 comment 6989532009); this file is not run
FILE ROLE: pre-flight file of set gh3199_admin_email_template_review_read (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-15 under #3199; production read-only SELECTs and one READ ONLY transaction rolled back (project yeszghaspzwwstvsrioa). Applied 2026-11-18 on Dustin's chat word "Go A-H." (14:30 ET) by Ben, CEO RUN 155 (claim ceo-2026-11-18T18:18:18Z); pg_policy on public.contractor_templates after apply held 4 policies (#3199 comment 6989532009).
REPO COPY: forward supabase/migrations/20261118193522_gh3199_admin_email_template_review_read.sql (filed by PR #3801); this pre-flight is in supabase/migrations_rollbacks/.
Pre-flight record; the forward migration is already applied. The body below is the pre-apply text, unchanged, except that the "NOT APPLIED" line is struck. Open items 1 and 2 below are NOT resolved by the apply (Ben's ruling 6898572391: separate follow-up PR under #3199).
-->
# Pre-flight: gh3199_admin_email_template_review_read (Tier 3B, RLS change)

~~NOT APPLIED. Refs #3199. REVIEW owed. Tier 3B (RLS change): R-097 notice owed before apply. No notice has been posted by this PR.~~ APPLIED 2026-11-18 (ledger 20261118193522).

## The defect (verified 2026-11-15)
- The admin page `react-app/app/admin/template-review/page.tsx` loads with the browser client (`supabase.from('contractor_templates').select('*, contractors:contractor_id(...)')`) and writes verdicts with direct `.update(...)` calls. No edge function, no service role. RLS therefore applies to both.
- `pg_policy` on `public.contractor_templates` (RLS enabled, not forced): `contractor_templates_self` (ALL, own rows) and `contractor_templates_admin` (ALL, `contractors.template_review_role = 'admin'`). Neither honours `is_admin_email()`.
- `select count(*) from contractors where template_review_role='admin'` = 0. `admin_emails` has 2 rows.
- Simulation (read-only, rolled back): `BEGIN READ ONLY; SET LOCAL ROLE authenticated; set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","email":"dustinstohler1@gmail.com"}', true); SELECT ...; ROLLBACK;` returned `is_admin_email = true, visible_rows = 0, needs_review_visible = 0, proof_row_visible = 0` (proof row 297d480b-15c0-4b3e-85c8-62f319814be2, status submitted_for_admin_review).
- Page gate: `RequireAdmin tier="reviewer"` lets in ADMIN_EMAILS or template_review_role='admin' (client side), so an ADMIN_EMAILS admin reaches an empty queue.

## What it does
Adds `contractor_templates_admin_email_select` (FOR SELECT) and `contractor_templates_admin_email_update` (FOR UPDATE, USING and WITH CHECK), role `authenticated`, predicate `public.is_admin_email()`. No INSERT or DELETE policy. Existing policies untouched. Other tables already use the same predicate for admin policies (claims, leads, hover_orders, payout_approvals, partner_fee_events, contractor_sms_numbers).

## Why the UPDATE policy is included
Approve and Reject are client UPDATEs. Without it they match zero rows and the page raises its gh2105 zero-row alert. The column guard `trg_templates_privileged_guard` calls `request_is_privileged()`, which already includes `is_admin_email()`, so it will let an admin write verdict columns.

## Open items for the reviewer / Ben (found while reading, NOT fixed here to keep this the smallest change)
1. `contractor_templates_freeze_verdict` (BEFORE INSERT OR UPDATE) exempts only the hardcoded email `dustinstohler1@gmail.com` and `template_review_role='admin'` contractors. The second admin_emails entry (`dustin@otterquote.com`) is not exempt: with the UPDATE policy in place its Approve/Reject would match the row, then the trigger would restore OLD.status and OLD.reviewed_by, so the update would appear to succeed and persist no verdict. Decide before apply: (a) extend that trigger's exemption to `is_admin_email()` in this or a sibling migration, or (b) accept that only dustinstohler1@gmail.com approves.
2. The page's embedded `contractors:contractor_id(company_name, email, contact_name)` is read through the contractors RLS, whose admin policies are hardcoded to `dustinstohler1@gmail.com`. For the other admin email the queue would list rows with company shown as `(unknown)`. Not changed here.

## Order
Independent of every other pending draft. Depends on gh3009 (`public.is_admin_email()` reading `admin_emails`), which is applied.

## Post-apply verification (read-only; run after apply)
```sql
BEGIN READ ONLY;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","email":"dustinstohler1@gmail.com"}', true);
SELECT public.is_admin_email() AS admin, (SELECT count(*) FROM public.contractor_templates) AS visible_rows,
       (SELECT count(*) FROM public.contractor_templates WHERE id='297d480b-15c0-4b3e-85c8-62f319814be2') AS proof_row_visible;   -- expect true, >= 13, 1
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated","email":"someone-else@example.test"}', true);
SELECT public.is_admin_email() AS admin, (SELECT count(*) FROM public.contractor_templates) AS visible_rows;   -- negative control: expect false, 0
ROLLBACK;
```
Negative control for the write side: the same non-admin claims running `UPDATE public.contractor_templates SET admin_notes = 'x'` inside the READ ONLY transaction must raise (read-only) or match 0 rows; do not run it outside a rolled-back transaction.

## Rollback
`gh3199_admin_email_template_review_read_rollback.sql` drops both policies and checks that exactly the 2 original policies remain.
