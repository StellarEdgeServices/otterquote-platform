<!--
STATUS (gh-1438): APPLIED to production (yeszghaspzwwstvsrioa) under R-097 by CTO RUN 64 (claim cto-2026-10-08T16:29:34Z) as ledger version 20261008231142, name gh2559_claim_docs_summary_only; evidence #2559 comment 6070932320. The text below is the pre-apply pre-flight, kept as written.
FILE ROLE: pre-flight file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
EVIDENCE: no ledger row for this set; the live policy is the world-fenced text of ledger version 20261006171747 (pg_policies and the ledger read 2026-10-06, before and after every proof run). The forward and rollback CREATE POLICY statements are byte-identical to those at head c60b216f, which were run on production inside rolled-back blocks (supabase/tests/gh2559_claim_docs_summary_only_proof.sql; review 6024856617 finding 9). The cut-down files themselves were NOT re-run on production by the worker who cut them (no production write in that worker's grant); the reviewer of this head re-runs the proof.
REPO COPY: this file, moved from supabase/migrations_drafts/ after the apply; the forward file is supabase/migrations/20261008231142_gh2559_claim_docs_summary_only.sql and the rollback is supabase/migrations_rollbacks/20261008231142_gh2559_claim_docs_summary_only_rollback.sql.
Never move into supabase/migrations/ (the CLI would replay it).
-->
# Pre-Flight: gh2559_claim_docs_summary_only (cut down to the storage policy)

**Migration**: `supabase/migrations/20261008231142_gh2559_claim_docs_summary_only.sql` (APPLIED 2026-10-08, ledger version `20261008231142`)
**Author**: worker for Marty (CTO RUN 62, claim `cto-2026-10-07T17:47:04Z`, tid `cto62-gh2559`), on the draft by the CTO RUN 61 worker `cto61-rebuild-2569`
**GitHub**: Refs #2559 (item 3). **Decision**: D-368, extended by Dustin's answers of 2026-10-07 (comment 6038067961). **Tier**: 3B, 24-hour notice (R-097) on #2559.
**Replaces** the draft at head `c60b216f` (REVIEW: FAIL 6024856617) and its R-097 notice 6024524228, which is void:
that notice described a refusal at a homeowner's submit step that is no longer in the change.

## What it does (one change)

**Storage.** The policy "Contractors can view biddable claim docs" on `storage.objects` keeps only its
selected-contractor branch. The bidding branch is removed: **a bidding contractor reads no raw uploaded
object of the `claim-documents` bucket at all.** The summary is columns on `public.claims`, not storage.

**Cut from the previous head** (CEO ruling 6029315131 item A, review 6024856617 option A): the bid-open trigger
`claims_guard_bid_release`. Nothing in this set touches `public.claims`. The two conditions it was meant to
enforce (no bid opens on an unread estimate; no identity in a summary) stay on #2559 as a named remaining part
of that issue's closes-on. Without it, a claim whose estimate was never read into a summary can open for bids;
a bidder then has no summary panel for that claim and still no file.

**Settled by Dustin on 2026-10-07** (comment 6038067961, question 1, "Hide it (Recommended)"): the homeowner's
measurement report is hidden from a bidder before selection, as this draft already had it.

## Why a rule over the bucket cannot work: how files get into it today (unfiltered grep at main)

Command: `grep -rn "claim-documents"` over `*.html *.js *.ts *.tsx` and `supabase/functions` at main `9380a3af`,
every hit read. Every writer of an object in `{uid}/{claim}/` is the homeowner's own session:

| writer | path written | who |
|---|---|---|
| `dashboard.html` (estimate and measurements slots) | `{uid}/{claim}/{ts}-{name}` | homeowner, `upsert: true` |
| `react-app/.../(homeowner)/dashboard/actions.ts` `uploadClaimDocument(kind)` | same | homeowner |
| `trade-selector.html`, `react-app/app/trade-selector/page.tsx` | `{uid}/loss-sheets/...`, then moved to `{uid}/{claim}/...` | homeowner |
| `repair-intake.html`, `use-repair-intake-data.ts` (photos) | `{uid}/{claim}/repair-...` | homeowner |
| `js/video-upload-handler.js` | `videos/{uid}/{claim}/...` | homeowner (not under the old policy: second segment is not a claim id) |
| `admin-measurements.html` | `{admin_uid}/measurements/{claim}/{order}.pdf` | admin session (not under the old policy) |
| `supabase/functions/get-hover-pdf` (cache copy) | `{claim}/hover_measurements_{id}.pdf` | service role (not under the old policy: claim id is the FIRST segment) |

The only INSERT policies on the bucket are "Users can upload to own folder" (`foldername[1] = auth.uid()`) and
the homeowner video policy; the service role bypasses. So inside `{uid}/{claim}/` the homeowner chooses the
file, its name and the slot; **a file stored as "measurements" can be the estimate** (on the one real claim with an
estimate, the measurements slot holds a copy of it: two objects, same size, same eTag), and an upload to the
second path segment is hers to place under any claim id. No marker the homeowner's upload path cannot set exists
today in the folder the policy reads. The platform's own measurement files already live OUTSIDE it, and a bidder
got the vendor PDF through the `get-hover-pdf` edge function (service role). The migration does not touch that
function; the same PR changes its code so that it refuses a contractor who is not the selected one (below).
Production on 2026-10-06 (storage.objects, counts only): 27 objects, none named `hover_measurements_*`; 22 follow the `{uuid}/{uuid}/file` shape; 23 of 27 carry the uploader's own user id as first segment.

**Smallest server-only marker, if a bidder-readable raw file is ever wanted:** a platform-written object whose
FIRST path segment is the claim id. No client policy lets a user write there (the insert policy requires the first
segment to equal the caller's user id); proof rows W1 and W2 show a homeowner session refused at that prefix and
allowed at her own. **Not built here.** Safe default taken: no raw object for a bidder.

## What a bidder loses and keeps

| thing | before | after |
|---|---|---|
| uploaded insurance estimate, current or earlier uploads | reads | refused |
| the homeowner-uploaded **measurements file** (any upload in her folder, photos included) | reads | **refused (Dustin, comment 6038067961: "Hide it")** |
| parsed summary of the estimate (`parsed_line_items`, `contractor_scope_summary`, RCV/ACV/deductible; "Insurance Line Items" panel and card text) | reads | reads |
| platform measurement PDF produced by the vendor (through `get-hover-pdf`) | reads | **refused once the changed `get-hover-pdf` is DEPLOYED** (D-370, CEO ruling 6045857216); until that deploy, still reads. The admin-uploaded PDF was already refused to every contractor (`index.ts`, manual branch: primary admin and service role only) |
| measured quantities on the claim row (`roof_squares`, `repair_squares`, the squares figure of `hover_measurements`) | reads | reads |
| Hover design photos (`get-hover-siding-data`) | reads | reads (that function also returns the job's street address to a bidder today; PR #2578 changes it) |
| claim row personal columns (see below) | reads | **still reads** |

**Consequence to say plainly.** Where a homeowner uploaded her own measurements file and no measurement was
ordered through the platform, a bidder has no measurement document before selection (only the squares and shape she
typed). `parse-hover-measurements` runs at contract time (called by `create-docusign-envelope`), not at upload, so
there is no parsed measurement summary for a bidder either. Production today (claims table, 2026-10-06): 6 of the 10
claims open for bids have a measurements upload (sentinel names excluded). Dustin answered this on 2026-10-07 (comment 6038067961): hide it; a product gap found later goes back to him and is
not a reason to reopen the files.

## The measurement PDF: a function change in this PR, deployed separately

CEO ruling 6045857216 (D-370): before selection a bidding contractor does not open ANY measurement report on the
claim, whether the homeowner uploaded it (the storage policy above) or it was produced through the platform.
`supabase/functions/get-hover-pdf/pdf-source.ts` `canAccessClaim` now serves the claim's owner and the selected
contractor (record active) and nobody else; it used to serve any active contractor on a claim open for bids and any
contractor with a quote. Tests: `supabase/functions/get-hover-pdf/pdf-source.test.ts` (the served-bidder case of
main is now a refusal; five more cases). The pages offer the "Measurement PDF" button only to the selected contractor.

- **Merging this PR does not deploy the function.** The deploy is its own step with its own notice. Until then a
  bidder can still open a vendor-produced PDF. Production on 2026-10-07 (review 6047712432, SELECT): 0 completed
  orders with a vendor job id, 0 active real contractors, so nobody is served one today.
- **Open before that deploy (money; not decided here):** the opportunity card sells a bidder a "Detailed Measurement
  Report" (D-317, tier price). After the deploy a bidder who buys it cannot open it until selected. Not changed in
  this PR; put to the CEO on #2559.
- A bidder keeps the measured quantities (the squares on the card and the bid form).

## The claims row is PR #2578, not this change

A bidder can still read `claims.estimate_filename`, `homeowner_name`, `claim_number` and the other personal
columns of a claim open for bids through the claims policies "Contractors can view biddable claims" and
"Contractors can view claims for their quotes". That half of D-368 is PR #2578 (a bidder-safe view, the contractor
pages re-pointed to it, and a policy narrowing with its own 24-hour notice). **Until it ships, D-368 is not complete
and Contractor Agreement 6.2 is not met for the claim row.** Proof rows B4 and R5 show the three columns still
readable after this change.

## Not in this change, and why

- **The bid-open trigger**: cut (above).
- **The selected contractor's access**: unchanged (selection, not fee collection). The guard on
  `claims.selected_contractor_id` and `claims.platform_fee_charged`, and the fee leg, stay named on #2559 as its
  remaining parts; #2559 does not close without them (comment 6029315131, condition 4).

## Order of operations (pages first, then the rule; comment 6029315131 item B)

Conditions before step 2: this head has `REVIEW: PASS`, `LEGAL-READ: PASS` and the CEO's signature; the fresh
R-097 notice on #2559 that describes this cut-down change has run its 24 hours.

1. Publish the page changes in this PR: Loss Sheet and View Measurements offered only to the selected contractor
   (`contractor-opportunities.html`, `contractor-bid-form.html`, the React pages); the three sentences
   (`contractor-how-it-works.html`, `contractor-faq.html` twice) and the two card badges reworded so no page says a
   bidder can open the estimate. If the policy is applied first, every bidder's two buttons answer "Unable to open ...".
2. Run `supabase/tests/gh2559_claim_docs_summary_only_proof.sql` alone and confirm `VERDICT live: WIDE`.
3. Apply the forward file through the migration path so it gets a ledger row.
4. Run the proof file alone again and confirm `VERDICT live: NARROWED`.
5. File the forward file in `supabase/migrations/` under the ledger version, move the rollback and this pre-flight
   to `supabase/migrations_rollbacks/` and add the version to `migrations-reconciliation-baseline.json` (gh-1438).

## Lock and blast radius

`DROP POLICY` + `CREATE POLICY` take an ACCESS EXCLUSIVE lock on `storage.objects`; `lock_timeout = '5s'` makes the
migration fail instead of queueing. No rows are read, written or deleted. `public.claims` is not touched.
Effect on a homeowner: none. No homeowner read, write or submit is changed.

## Proof (production, rolled back, 2026-10-06, run at head `c60b216f`)

Forward-rollback mode, one statement, every write rolled back by the final RAISE. Fixtures are looked up at run time
(no identifier is in any file). The last column is the **same reads against the first draft's policy** (head
`2e130cde`) as the negative control for the rows it was failed on. **These numbers were measured with the previous
head's files, whose policy statements are byte-identical to this head's** (`diff` of the two forward files from
`BEGIN;` shows only the trigger removed; the same for the rollback). The eight trigger rows of that run are not
shown: the trigger is cut. The proof file at this head has those rows removed and was not re-run by its author.

```
                                                                    live   fwd   rollback   previous draft
B1 test bidder -> test open claim, ESTIMATE object                   1      0       1           0
B2 test bidder -> test open claim, MEASUREMENTS object               1      0       1           1
B3 test bidder -> claim row with its parsed summary                  1      1       1           1
B4 test bidder -> claim row, 3 personal columns (STILL READABLE)     1      1       1           1
R1 real bidder -> real open claim, ESTIMATE object                   1      0       1           0
R2 real bidder -> real open claim, MEASUREMENTS object (copy)        1      0       1           1  <- REVIEW FAIL item 1
R3 real bidder -> another real claim, MEASUREMENTS object            1      0       1           1
R4 real bidder -> claim row with its parsed summary                  1      1       1           1
R5 real bidder -> claim row, 3 personal columns (STILL READABLE)     1      1       1           1
X1 bidder -> estimate object the row no longer names                 1      0       1           0
E1 bidder -> object named in BOTH slots                              1      0       1           0
S1 selected contractor -> measurements object, claim closed          1      1       1           1
S2 selected contractor -> the claim's ESTIMATE object                1      1       1           1
S3 selected contractor -> claim row with its summary                 1      1       1           1
F1/F2 test bidder -> real claim's objects (world fence)              0      0       0           0
F3 real bidder -> test claim's object (world fence)                  0      0       0           0
O1/O2 claim owner -> own estimate object                             1      1       1           1
O3 homeowner -> another homeowner's estimate object                  0      0       0           0
P1 pending_approval contractor, whole bucket                         0      0       0           0
AD admin-email session, whole bucket                                 0      0       0           0
A1 anon, whole bucket                                                0      0       0           0
V1 service_role, whole bucket (27 + one proof insert per phase)     27     28      29          28
T-all / R-all bidder, whole bucket (oracle count)                  4 / 3  0 / 0   4 / 3       3 / 2
S-all selected contractor, whole bucket (oracle count)               5      2       5           5
W1 homeowner writes at {claim id}/...  (server-only prefix)          0      0       0           0
W2 homeowner writes under her own user id (control)                  1      1       1           1
storage policy: bidding leg / world fence / selected leg      yes/yes/yes   no/no/yes   yes/yes/yes
other 31 storage policies, md5            a7f86019...   a7f86019...   a7f86019...
8 public.claims policies, md5             d5113561...   d5113561...   d5113561...
VERDICT                                      WIDE        NARROWED    WIDE
```

The "real bidder" is a test contractor whose flag the block sets to real, inside the rolled-back block; production
has no active real contractor on 2026-10-06. Negative controls: the live column (the current policy: every raw
object reads) and the first-draft column (R2 and R3 stay readable: the byte-identical copy still opens). File and
summary contents were never read; rows were counted. An independent reviewer reproduced the storage rows by a
different route and reported "The storage half is correct and I could not break it" (comment 6024856617, finding 9).

**Production unchanged by the proof runs** (fingerprint before the first run and after the last: policy qual md5,
other storage policies, claims policies, claims triggers, claims and contractors row digests, claim-documents object
digest, ledger count and head): identical, ledger `213` rows, head `20261006171747`.

## Still open on #2559 after this change

- The claims row (PR #2578).
- The two conditions the cut trigger was meant to enforce, and what a homeowner is told on a refused submit if it is
  rebuilt (consent and trust wording; the CEO's first).
- The guard on `claims.selected_contractor_id` / `claims.platform_fee_charged`, and the fee leg.
- Unverified, the CTO's to check before this applies (comment 6038067961): that a contractor can price a job from the
  summary plus city and zip.

## Rollback

`supabase/migrations_rollbacks/20261008231142_gh2559_claim_docs_summary_only_rollback.sql` restores the world-fenced policy text that
is live today (ledger version 20261006171747), in one transaction. Then delete this set's ledger row. WARNING: it
re-opens the raw files to every bidder. Do not run it after `gh2559_claim_docs_world_fence_rollback.sql` (the
world-fence PR's rollback restores the unfenced text).
The client change does not need reverting for the rollback to be safe: with the wide policy and the new client a
bidder simply is not offered a button for a file it could read.
