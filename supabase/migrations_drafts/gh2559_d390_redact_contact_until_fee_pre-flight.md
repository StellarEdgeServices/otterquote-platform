# Pre-flight: gh2559_d390_redact_contact_until_fee (D-390)

Status: NOT APPLIED. Tier 3B. Decision: D-390 (Dustin, #2841 comment 6255785270, "Redact until fee (Recommended)"; both surfaces, scope note 6254337125).
Drafted by CTO RUN 70 worker `cto70-d390`. Forward: `gh2559_d390_redact_contact_until_fee.sql`. Rollback: `gh2559_d390_redact_contact_until_fee_rollback.sql`.
Proof: `supabase/tests/gh2559_d390_redact_proof_run.sh` (throwaway Postgres only).

## 1. Where a homeowner-typed phone or e-mail reaches the selected contractor before the fee (found by reading the code on main 2c063a8)

| # | surface | path | before this PR | after this PR |
|---|---|---|---|---|
| 1 | notes box on the contractor's pages | `claims.homeowner_notes` through `public.bidder_claim_summary`; its selected-contractor branch returned the raw column (comment in the view: "the selected contractor reads it as typed") | as typed | redacted until `platform_fee_charged IS TRUE` (view re-created, one clause) |
| 2 | Scope of Work PDF | `create-docusign-envelope` printed `claims.homeowner_notes` (and `project_confirmation.homeownerNotes`) under NOTES. The envelope is created at selection, before the fee | as typed | redacted through `public.d390_redact_contact` until the fee; if the call fails the function refuses to build the envelope (creates and sends nothing; no marker text is printed). The four free-text keys of `project_confirmation` (`homeownerNotes`, `workNotBeingDone`, `projectNotes`, `exclusions`) are all wrapped |
| 3 | message thread, pages | `contractor-dashboard.html` and `react-app/.../Messaging.tsx` read `public.messages` | as typed | read `public.contractor_thread_messages` (redacted body) |
| 4 | message thread, PostgREST | a selected contractor can call `/messages` directly | as typed | restrictive policy `d390_homeowner_text_prefee`: no homeowner-sent row through the table before the fee |
| 5 | new-message e-mail to the contractor | `send-message-notification` put the first 200 characters of the homeowner's message in the e-mail, at status "selected" (before the fee) | as typed | preview built from the redacted body; if the call fails the preview is `[removed]`, the success-path token |

## 2. Design

* One function, `public.d390_redact_contact(text)`: the phone and e-mail patterns of the bidder rule (rules b and c of the `ft` join in `20261008231303_gh2559_bidder_claims_view.sql`), copied verbatim; `tests/gh2559-d390-regex-parity.py` asserts each of the 7 patterns occurs verbatim in the applied view file. The web-address patterns of rule b are NOT copied (D-390 names phone and e-mail only).
* The fee signal is `claims.platform_fee_charged IS TRUE` (D-386's signal; client sessions cannot write it, trigger `claims_guard_platform_fee_charged`). NULL and false both redact.
* The browser never receives the unredacted text pre-fee on the surfaces above: the views and edge functions redact in the database or the edge function; the restrictive policy removes the table path.
* Execution: Postgres checks EXECUTE on a function called inside a view as the CALLER. The first proof run failed with `permission denied for function d390_redact_contact` for `authenticated` after a REVOKE; the file therefore leaves the default EXECUTE for `authenticated` (pure function, no table access), revokes `anon` and PUBLIC, writes no GRANT, and asserts the ACL.
* Homeowner: unchanged (owner reads her own rows and notes). Bidders: the bidder branch of the view is untouched; the proof compares an md5 of a bidder's notes before and after (identical). Service role: bypasses RLS, unchanged.

## 3. Apply order and dependency

1. **PR #2777 first** (gh2619 thread scope; adds `claims.contractor_released_at` and the split policies). The gate here raises `P0D01`/`P0D02` if either is missing, so the thread view can never be wider than the thread policy. Production read 2026-10-18: `claims.contractor_released_at` absent, 3 policies on `public.messages` (the pre-#2777 set).
2. Publish the page change and deploy the two edge functions with the apply. Until the pages are published a selected contractor sees NO homeowner message before the fee (the old pages read the table, which the restrictive policy empties of homeowner rows). After the fee the old pages work again.
3. The forward file is idempotent (CREATE OR REPLACE, DROP POLICY IF EXISTS); the proof runs it twice.

## 4. Pre-flight SELECTs (counts only; production, read-only, 2026-10-18)

```
claims total                                           31
claims with notes                                       6
claims, notes with phone/e-mail shape, all              0
claims, same, real (is_test not true)                   0
claims, same, real, selected, fee not charged           0
claims, urgency_reason with the shape, real             0
claims, project_confirmation notes with the shape       0
claims selected and fee not charged (any)               2
claims selected, real                                   0
messages total / homeowner-sent                         4 / 3
homeowner-sent with the shape, all / real               1 / 0
homeowner-sent with the shape, real, selected, no fee   0
policies on public.messages                             3
claims.contractor_released_at present                   0
```
Blast radius today: no real claim or message changes what any contractor sees. The one matching message is on a test claim.

## 5. RESIDUALS (not closed here; each named)

1. **Base claims row.** The selected contractor can still read `claims.homeowner_notes`, `claims.urgency_reason` and `claims.project_confirmation` (its `homeownerNotes`, `workNotBeingDone`, `projectNotes` and `exclusions` keys) through PostgREST `/claims` (one login role serves homeowner and contractor; RLS cannot hide a column; the storage and message policies read `claims` under the caller's RLS so the selected-contractor SELECT policy cannot simply be dropped). No page reads them from the base row. Follow-up #2881. The proof row P14 records this as "still as typed". Closing it needs a split of the notes into a table the contractor policy does not reach, or definer helpers in those policies: a separate decision.
2. Web addresses and other contact channels ("find me on Facebook") are not redacted; D-390 names phone and e-mail. Same posture as D-371: best-effort pattern matching.
3. The Scope of Work goes to the homeowner too; she sees the redacted notes on her own copy before the fee (her own typed notes are unchanged on every other screen).
4. `project_notes` in `autoPopulateFields` (project-confirmation DocuSign fields) is not changed; that document is created after the contract. Unverified against production timing.
5. A contractor-typed message that repeats the homeowner's number is shown as typed (the rule is about homeowner-typed text).

## 6. Verification after apply (Marty)

`SELECT policyname, permissive, cmd FROM pg_policies WHERE tablename='messages' ORDER BY 1;` expects `d390_homeowner_text_prefee | RESTRICTIVE | SELECT`; `SELECT pg_get_viewdef('public.bidder_claim_summary'::regclass) LIKE '%d390_redact_contact%';` expects true; then rolled-back role-switched probes on an is_test claim as in the proof file.
