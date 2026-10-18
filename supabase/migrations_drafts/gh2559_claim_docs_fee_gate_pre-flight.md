<!-- STATUS (gh-1438, as of 2026-10-15T21:26:09Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2559_claim_docs_fee_gate -->
<!-- EVIDENCE: production read-only SELECTs 2026-10-15 by the cto68-d386 builder; the proof was run on a throwaway Postgres 16 (mock schema, production policy text), not on production (see "Proof") -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2559_claim_docs_fee_gate (Tier 3B, NOT APPLIED)

Issue #2559 (the fee leg). Decision D-386 (Dustin, #2696 comment 6084050178, "Approve default (Recommended)"; Contractor Agreement 6.2):
"The Homeowner's phone number and email address, and the Homeowner's full insurance estimate, are released to Contractor only after the Platform Fee has been successfully collected."
Companion copy: PR #2796 (it says the same thing in the contractor pages; it must not merge before this is live).

## What it does (one change)

The storage policy "Contractors can view biddable claim docs" (SELECT, `authenticated`, bucket `claim-documents`) keeps its one branch, the
contractor the homeowner selected, and adds `AND c.platform_fee_charged IS TRUE`. Before: the selected contractor opens every file in the claim's
folder at selection. After: only once the claim's platform fee has been collected. Nothing else changes.

## The fee signal and why it is the right one

`public.claims.platform_fee_charged` (boolean, DEFAULT false, nullable; hence `IS TRUE`).
- Written true only on a confirmed success: `docusign-webhook` (synchronous card success, same update that sets `status = 'contract_signed'`) and
  `stripe-webhook` `payment_intent.succeeded` (an ACH fee that settles later). A pending or processing payment leaves it false.
- Not writable from a browser: trigger `claims_guard_platform_fee_charged` (gh-2491, live; ledger `20261015205709`) refuses `anon`/`authenticated` non-admin
  writes with 42501. The sibling guards on `selected_contractor_id` (gh-2626) and the Stripe columns (gh-2710) are in the ledger too.
- It is the signal `get_message_counterpart()` already uses to release the homeowner's name to the selected contractor (live), so the platform has one
  definition of "fee collected".

## Whole folder, not "the estimate" only

The policy cannot tell the estimate from the other objects in `{homeowner_uid}/{claim_id}/`: the homeowner chooses the file, the name and the slot, and on
the one real claim with an estimate the "measurements" slot holds a byte-identical copy of it (see the header of the applied `gh2559_claim_docs_summary_only`).
Opening any other file at selection would open the estimate. So the loss sheet, measurements file and photos follow the estimate to fee collection. This is
Ben's stated default (#2559 comment 6199982599). If a product reason appears for opening something earlier, it needs a platform-written marker object
(first path segment = claim id), not a label the homeowner sets.

## SELECTs to run on production before the apply (read-only) and after

```sql
-- 1. the live policy (expect before: selected leg only, no platform_fee_charged; after: selected leg AND platform_fee_charged IS TRUE)
select policyname, cmd, roles::text, qual from pg_policies
 where schemaname='storage' and tablename='objects' and policyname='Contractors can view biddable claim docs';

-- 2. who loses access when it lands: claims with a selected contractor, an estimate, and the fee not collected (expect 0 on 2026-10-15)
select count(*) filter (where not c.is_test) as real_claims, count(*) as all_claims
  from public.claims c
 where c.selected_contractor_id is not null and c.platform_fee_charged is not true and c.estimate_filename is not null;

-- 3. the fee signal is guarded (expect one row, enabled 'O')
select tgname, tgenabled from pg_trigger where tgrelid='public.claims'::regclass and tgname='claims_guard_platform_fee_charged';

-- 4. negative control: every other storage.objects policy is untouched (md5 equal before and after)
select count(*), md5(string_agg(policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n' order by policyname))
  from pg_policies where schemaname='storage' and tablename='objects' and policyname <> 'Contractors can view biddable claim docs';
```

Measured 2026-10-15 (counts only, read-only): 0 real claims have a selected contractor; 0 claims of any kind have a selected contractor and an estimate;
0 active real contractors (9 active test contractors); 28 objects in `claim-documents`. **The change removes access from nobody today.** It bites the first
real claim that is selected before its fee is collected, which is every real claim by design (the fee is charged when the homeowner signs).

## Who sees what, BEFORE and AFTER

| reader | fee not collected | fee collected |
|---|---|---|
| selected contractor | BEFORE: opens every file in the folder. AFTER: refused | allowed (both) |
| any other contractor (bidder, or selected on another claim) | refused (both) | refused (both) |
| claim owner (homeowner) | allowed (both) | allowed (both) |
| service role | unchanged | unchanged |

## Phone and email (D-386 also names them): found, NOT changed here

They are not this object. No contractor-readable policy or view carries them: `profiles` is owner-read only (`profiles_user_read`), `public.claims` has no
phone or email column, and `bidder_claim_summary` selects neither. They reach the selected contractor only through edge functions on the service role,
and the release is NOT fee-gated today:
- `create-docusign-envelope` writes the homeowner's `profiles.phone` into the contract template field `customer_phone` and the homeowner's email as the
  signer address when the envelope is created, i.e. at selection, before the fee. That contradicts D-386 for the phone number (and the email, as signer).
- `contractor-how-it-works.html` / `contractor-faq.html` say "the homeowner's contact information is released the moment the contract is fully signed",
  which is also not "after the fee is collected" (the fee is charged on the same signing event, so the two nearly coincide for a card).
A fix is a change to the envelope-creation function (an external-side-effect edge function, Tier 3B, with its own notice) or a decision that the phone/email on the
contract documents is covered by "name and address appear on the contract documents" (D-386's first sentences). That is a product/legal call for #2559, not part of
this storage change.

## Bidder view (`public.bidder_claim_summary`): reviewed, not changed

It exposes the claim's raw file PATHS (`estimate_filename`, `measurements_filename`) to the selected contractor, not file contents; opening one goes
through the storage policy above, so the path alone opens nothing after this change. It also exposes the parsed line-item summary (`parsed_line_items`,
`contractor_scope_summary`, RCV/ACV/deductible), which D-368 already lets every bidder read. Rewriting the 200-line view to hide the paths until the fee is a
larger, separable change; the cost of leaving it is that the contractor page still shows a Loss Sheet button that answers "Unable to open" until the fee.

## What would break (follow-ups, not in this PR)

- `contractor-opportunities.html` and `contractor-bid-form.html` show "Loss Sheet" / "View Measurements" to the selected contractor from selection; between
  selection and fee they will fail to open the signed URL. The pages should say "available once the platform fee is collected" (copy/UI PR, with PR #2796's sentence).
- The edge functions that touch these objects (`parse-loss-sheet`, `parse-hover-measurements`, `get-hover-pdf`, and the admin list `get-homeowner-list`) use the service role, not this policy; unaffected.
- No edge function signs a URL for a contractor to these objects (grep of `createSignedUrl` and `claim-documents` in `supabase/functions`: only the admin list signs, for admins), so nothing bypasses the gate. The contractor pages sign client-side, through this policy.

## Proof

`supabase/tests/gh2559_claim_docs_fee_gate_proof.sql`: one DO block, forced RAISE at the end, three phases (live, after forward, after rollback), `is_test` fixtures
only found at run time, fails closed (ERRCODE P0U02) if a fixture is missing or not `is_test`, inserts nothing. Cases: selected contractor with fee false (BEFORE 1, AFTER 0), with
fee NULL (1, 0), with fee true (1, 1); a non-selected bidder with fee false and true (0, 0); the claim owner with fee false and true (1, 1); whole-bucket oracle counts for
the selected contractor; service role unchanged; anon 0. Other storage policies, claims policies and claims triggers have equal md5 in every phase.

Run in this session on a throwaway Postgres 16 with a mock schema (the live policy text, production's gh2491 trigger body): LIVE, then GATED, then LIVE again;
the live-policy md5 equals production's. The same file was NOT run on production by this builder (see the PR body for why). A reviewer with the go-ahead runs it
alone on production, then checks that nothing persisted with the fingerprint query in the PR body.

## Apply and undo

Apply: after REVIEW + LEGAL-READ + the R-097 notice window, from the device shell (Management API), recorded in the ledger; run the proof alone before and after.
Undo: `gh2559_claim_docs_fee_gate_rollback.sql` (restores the selected-contractor-only policy; re-opens files to the selected contractor at selection).
Apply order with PR #2796: this first (or in the same window), then the copy; the copy must not go live before the behaviour.
Lock: `DROP POLICY` + `CREATE POLICY` take an ACCESS EXCLUSIVE lock on `storage.objects` briefly; `lock_timeout = '5s'` fails the migration instead of queueing. No rows are read, written or deleted.
