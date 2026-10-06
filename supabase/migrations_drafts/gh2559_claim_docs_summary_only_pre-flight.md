<!--
STATUS (gh-1438, as of 2026-10-06T17:32:56Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
EVIDENCE: no ledger row for this set; live policy is the world-fenced text of ledger version 20261006171747 (pg_policies read 2026-10-06, after the rolled-back proof). Forward and rollback were run on production inside one rolled-back block (supabase/tests/gh2559_claim_docs_summary_only_proof.sql).
REPO COPY: none. When the forward file is applied, move this file to supabase/migrations_rollbacks/ under the forward file's ledger version.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh2559_claim_docs_summary_only

**Migration**: `supabase/migrations_drafts/gh2559_claim_docs_summary_only.sql` (NOT APPLIED)
**Author**: worker for Marty (CTO RUN 61, claim `cto-2026-10-06T15:13:52Z`, tid `cto61-items-2559`)
**GitHub**: Refs #2559 (item 3). **Decision**: D-368. **Tier**: 3B, 24-hour notice (R-097) on #2559.

## What it does

One policy on `storage.objects` is dropped and recreated in one transaction:
"Contractors can view biddable claim docs". On its bidding branch a contractor may now read exactly
one object of a claim that is open for bids: the object the claim row names in
`claims.measurements_filename`, and only when that object is not also `claims.estimate_filename`.
The selected-contractor branch, the world fence (`c.is_test = ct.is_test`), the role, the command and
every other policy are unchanged.

## What a bidder loses and keeps

| thing | where it lives | bidder before | bidder after |
|---|---|---|---|
| uploaded insurance estimate (current) | `claim-documents`, `{uid}/{claim}/…`, named by `claims.estimate_filename` | reads | refused |
| earlier uploads of the estimate or measurements (superseded objects in the same folder) | same folder, named by no column | reads | refused |
| uploaded measurements file (current) | same folder, named by `claims.measurements_filename` | reads | reads |
| parsed summary of the estimate | `claims.parsed_line_items`, `claims.contractor_scope_summary` (columns, not storage) | reads | reads |
| measurement PDF from the measurement vendor | `get-hover-pdf` edge function, not this policy | reads | reads |
| repair-intake photos (`{claim}/repair-…`) and videos (`videos/{uid}/{claim}/…`) | same bucket, other path shapes | not reachable through this policy (the second path segment is not the claim id) | unchanged |

## Order of operations (do not apply before step 1 is live)

1. Publish the client change in this PR (the Loss Sheet button is offered only to the selected
   contractor: `contractor-opportunities.html`, `contractor-bid-form.html`, and the React pages
   `react-app/app/contractor/opportunities/`, `react-app/app/contractor/bid/[claimId]/`). If the policy
   is applied first, every bidder's Loss Sheet button answers "Unable to open the loss sheet."
2. After the R-097 window on #2559 has closed and `tier:3b-approved` is on the issue: run
   `supabase/tests/gh2559_claim_docs_summary_only_proof.sql` alone and confirm `VERDICT live: WIDE`.
3. Apply the forward file through the migration path so it gets a ledger row.
4. Run the proof file alone again and confirm `VERDICT live: NARROWED`.
5. File the forward file in `supabase/migrations/` under the ledger version and move the rollback and
   this pre-flight to `supabase/migrations_rollbacks/` (gh-1438 rule).

## Lock and blast radius

`DROP POLICY` + `CREATE POLICY` take an ACCESS EXCLUSIVE lock on `storage.objects` for the length of
the transaction (two catalog statements). `lock_timeout = '5s'` makes the migration fail instead of
queueing behind a long upload. No rows are read, written or deleted. No function, grant, table or
column changes.

## Proof (production, rolled back, 2026-10-06)

Forward-rollback mode of the proof file, one statement, every write rolled back by the final RAISE:

```
                                                              live   after forward   after rollback
B1 test bidder -> test open claim ESTIMATE object               1          0               1
B2 test bidder -> test open claim MEASUREMENTS object           1          1               1
B3 test bidder -> claim row with its parsed summary             1          1               1
R1 real bidder -> real open claim ESTIMATE object               1          0               1
R2 real bidder -> real open claim MEASUREMENTS object           1          1               1
R3 real bidder -> another real open claim MEASUREMENTS          1          1               1
R4 real bidder -> real claim row with its parsed summary        1          1               1
X1 test bidder -> estimate object the row no longer names       1          0               1
E1 test bidder -> one object named in BOTH slots                1          0               1
S1 selected contractor -> measurements, claim closed for bids   1          1               1
S2 selected contractor -> the claim's ESTIMATE object           1          1               1
F1 / F2 test bidder -> real open claim objects (world fence)    0          0               0
O1 / O2 claim owner -> own estimate object                      1          1               1
O3 homeowner -> another homeowner's estimate object             0          0               0
AD admin-email session, whole bucket                            0          0               0
T-all test bidder, whole bucket                                 4          3               4
R-all real bidder, whole bucket                                 3          2               3
V1 service_role, whole bucket                                  27         27              27
A1 anon, whole bucket                                           0          0               0
other 31 storage.objects policies, md5                   a7f86019…  a7f86019…       a7f86019…
8 public.claims policies, md5                            d5113561…  d5113561…       d5113561…
VERDICT                                                      WIDE    NARROWED            WIDE
```

Policy re-read after that block: `narrowed=false, fenced=true` (production unchanged by the proof).
The "real bidder" is a test fixture whose flag the proof sets to real inside the rolled-back block;
production has no active real contractor on 2026-10-06.

## Not in this change (each named on #2559)

- Moving the selected-contractor branch from "selected" to "fee collected" (Contractor Agreement
  section 6.2). Needs a guard on `claims.selected_contractor_id` and `claims.platform_fee_charged`
  first: both are writable by the claim's owner from the browser today.
- A gate that stops a claim opening for bids on an estimate that has not parsed into line items.
- A deterministic check that the stored summary does not contain the claim's own name, street address
  or claim number (today the parser is only instructed to omit them).
- `claims.homeowner_name` and the full `claims.property_address` are readable by any active contractor
  on a claim open for bids through the `public.claims` policies. This migration does not touch them.
- A homeowner can upload her estimate into the measurements slot; the policy cannot tell by content.

## Rollback

`supabase/migrations_drafts/gh2559_claim_docs_summary_only_rollback.sql` restores the world-fenced
policy text that is live today (ledger version 20261006171747). One transaction, same lock. Then
delete this set's ledger row. The client change does not need reverting for the rollback to be safe:
with the wide policy and the new client, a bidder simply is not offered a button for a file it could
read.
