<!--
STATUS (gh-1438, as of 2026-10-06T19:50:52Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh2559_claim_docs_summary_only (the STATUS is the set's; it describes the forward migration)
EVIDENCE: no ledger row for this set; the live policy is the world-fenced text of ledger version 20261006171747 and public.claims has no bid-release trigger (pg_policies, pg_trigger and the ledger read 2026-10-06, before and after every proof run). Forward and rollback were run on production inside one rolled-back block (supabase/tests/gh2559_claim_docs_summary_only_proof.sql).
REPO COPY: none. When the forward file is applied, move this file to supabase/migrations_rollbacks/ under the forward file's ledger version.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh2559_claim_docs_summary_only (rebuilt after REVIEW: FAIL)

**Migration**: `supabase/migrations_drafts/gh2559_claim_docs_summary_only.sql` (NOT APPLIED)
**Author**: worker for Marty (CTO RUN 61, claim `cto-2026-10-06T15:13:52Z`, tid `cto61-rebuild-2569`)
**GitHub**: Refs #2559 (item 3). **Decision**: D-368. **Tier**: 3B, 24-hour notice (R-097) on #2559.
**Replaces** the draft at head `2e130cde` (REVIEW: FAIL 6023922644, LEGAL-READ: FAIL 6022290887, Ben's return 6022309354) and
its R-097 notice 6022045021, which is void.

## What it does (two parts, one transaction)

1. **Storage.** The policy "Contractors can view biddable claim docs" on `storage.objects` keeps only its
   selected-contractor branch. The bidding branch is removed: **a bidding contractor reads no raw uploaded
   object of the `claim-documents` bucket at all.** The summary is columns on `public.claims`, not storage.
2. **Bid-release gate.** A trigger on `public.claims` refuses the change that opens a claim for bids
   (`ready_for_bids` going from not-true to true) when an estimate file is on the claim and either the estimate
   was not read into a summary, or the stored summary repeats the claim's own homeowner name, street address or
   claim number. Claims already open, and claims with no estimate file, are not touched.

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
gets the vendor PDF through the `get-hover-pdf` edge function (service role), which this change does not touch.
Production on 2026-10-06 (storage.objects, counts only): 27 objects, none named `hover_measurements_*`; 22 follow the `{uuid}/{uuid}/file` shape; 23 of 27 carry the uploader's own user id as first segment.

**Smallest server-only marker, if a bidder-readable raw file is ever wanted:** a platform-written object whose
FIRST path segment is the claim id. No client policy lets a user write there (the insert policy requires the first
segment to equal the caller's user id); proof rows W1 and W2 show a homeowner session refused at that prefix and
allowed at her own. **Not built here.** Safe default taken: no raw object for a bidder.

## What a bidder loses and keeps

| thing | before | after |
|---|---|---|
| uploaded insurance estimate, current or earlier uploads | reads | refused |
| the homeowner-uploaded **measurements file** (any upload in her folder, photos included) | reads | **refused (new loss versus the previous draft and versus today)** |
| parsed summary of the estimate (`parsed_line_items`, `contractor_scope_summary`, RCV/ACV/deductible; "Insurance Line Items" panel and card text) | reads | reads |
| platform measurement PDF (vendor or admin-uploaded, through `get-hover-pdf`) | reads | reads |
| Hover design photos (`get-hover-siding-data`), homeowner-entered squares and shape on the claim row | reads | reads |
| claim row personal columns (see below) | reads | **still reads** |

**Consequence to say plainly.** Where a homeowner uploaded her own measurements file and no measurement was
ordered through the platform, a bidder has no measurement document before selection (only the squares and shape she
typed). `parse-hover-measurements` runs at contract time (called by `create-docusign-envelope`), not at upload, so
there is no parsed measurement summary for a bidder either. Production today (claims table, 2026-10-06): 6 of the 10
claims open for bids have a measurements upload (sentinel names excluded). If bidders need that file, the follow-up is parsing it into a summary at upload. That is
Ben's question on #2559.

## Item (b), the claims row: SPLIT into its own follow-up PR (not done here, and not silent)

A bidder can read `claims.estimate_filename`, `homeowner_name`, `claim_number` through the claims policies
"Contractors can view biddable claims" and "Contractors can view claims for their quotes". Measured: it is wider than
three columns. `authenticated` holds column SELECT on all **130** columns (information_schema, 2026-10-06), and both
contractor pages and the dashboard read the row with `select('*')`. Besides the three, a bidder can read
`adjuster_name/email/phone`, `ingest_email`, `ingest_email_address`, `deductible_stripe_id`, `platform_fee_stripe_id`,
`docusign_envelope_id` and two other envelope ids, `referral_*`, `utm_*`, `fbclid`, `gclid`, `first_touch_*`,
`live_charge_authorized_by`, `contract_signed_by`, `user_id`, plus `property_address` (Ben's open question).

**Why it is not in this PR.** Column privileges cannot do it: `authenticated` is one role for the homeowner, the
admin session and every contractor, and the homeowner pages read the same row with `select('*')`, so revoking the
three columns breaks homeowners. RLS cannot hide columns. The mechanism that fits is an allow-list view for
contractors plus dropping and narrowing two policies and re-pointing every contractor read, in two stacks:

| contractor read of `claims` (main) | columns it uses | re-point needed |
|---|---|---|
| `contractor-opportunities.html` 536, `select('*')` list | 37 mapped (list in REVIEW comment on #2559) | yes |
| `react-app/.../opportunities/use-opportunities-data.ts` 53, `select('*')` | same 37 | yes |
| `contractor-bid-form.html` 3507, `select('*, carrier_profiles(carrier_name)')` | trades, selected_trades, id, user_id, parsed_line_items, rcv_amount, job_type, funding_type, damage_type, material_category, shingle_type, impact_class, designer_product, designer_manufacturer, property_address, siding_bid_released_at, measurements_filename, estimate_filename, selected_contractor_id | yes (and the carrier embed) |
| `react-app/.../bid/[claimId]/page.tsx` 106, same shape | same | yes |
| `contractor-dashboard.html` 1258 and `react-app/.../dashboard/use-dashboard-data.ts` 112, `select('*')` count and trade filter | selected_trades, trades, bid counts | yes |
| embeds from `quotes`: `contractor-dashboard.html` 1355 and 2098, `use-dashboard-data.ts` 170, `Messaging.tsx` 54 | id, property_address, damage_type, material_category, shingle_type, rcv_amount, completion_date, status, contract_signed_at, user_id | yes, or they return null once the quotes policy is narrowed |
| edge functions | service role | no |

Eight call sites, two stacks, two policy changes and an embed whose view relationship cannot be tested before the
view exists. That is its own Tier 3B change with its own 24-hour notice. The mechanism the follow-up should take:
one `security_invoker = false` view over `claims` with an allow-list of columns, the same row predicate as the two
policies, the three columns (and the other personal columns) masked to NULL unless the viewer is the selected
contractor; both contractor policies on the base table dropped or narrowed to the selected contractor; the six
reads above re-pointed. **Until it ships, D-368 is not complete and Contractor Agreement 6.2 is not met for the
claim row.** Proof rows B4 and R5 show the three columns still readable after this change.

## Conditions from Ben's return that ARE in this change

- **Unparsed estimate** (gate part a): refused unless `loss_sheet_parsed_at` is set and the summary has line-item
  sections or a total RCV (summary-only estimates are legal: the parser returns empty sections and the totals).
  Production (claims table, 2026-10-06): 3 stored summaries, with 14, 1 and 0 line items; the one with 0 is a not-open
  claim; 0 claims open for bids hold an estimate file without a summary.
- **Summary repeats the claim's own name, street or claim number** (gate part b): case-insensitive substring test
  over `contractor_scope_summary` and `parsed_line_items`; values shorter than 4 (street: 5) characters are skipped.
  It catches the full value, not a surname alone or a re-spelled address. Production: 0 of 3 stored summaries match,
  and no claim has a claim number recorded, so that arm is exercised by fixture only (row G6).
- **Not in this change, and why**: the selected contractor's access is unchanged (selection, not fee collection;
  Ben's call: the release must key on a server-set fee fact, and `selected_contractor_id` / `platform_fee_charged`
  are both writable by the claim's owner today).

## Order of operations (do not apply before step 1 is live)

1. Publish the client change in this PR (Loss Sheet and View Measurements offered only to the selected contractor on
   `contractor-opportunities.html`, `contractor-bid-form.html`, and the React pages). If the policy is applied first,
   every bidder's two buttons answer "Unable to open ...".
2. After the R-097 window on #2559 closes and `tier:3b-approved` is on the issue: run
   `supabase/tests/gh2559_claim_docs_summary_only_proof.sql` alone and confirm `VERDICT live: WIDE`.
3. Apply the forward file through the migration path so it gets a ledger row.
4. Run the proof file alone again and confirm `VERDICT live: NARROWED`.
5. File the forward file in `supabase/migrations/` under the ledger version, move the rollback and this pre-flight
   to `supabase/migrations_rollbacks/` and add the version to `migrations-reconciliation-baseline.json` (gh-1438).

## Lock and blast radius

`DROP POLICY` + `CREATE POLICY` take an ACCESS EXCLUSIVE lock on `storage.objects`; the trigger takes SHARE ROW
EXCLUSIVE on `public.claims`; `lock_timeout = '5s'` makes the migration fail instead of queueing. No rows are read,
written or deleted. The trigger function is not granted to any role (REVOKE from PUBLIC, anon, authenticated).
Effect on a homeowner: only the submit-for-bids update can be refused, and it surfaces through the existing
"Failed to submit your project" path. Wording shown to her is Ben's question on #2559.

## Proof (production, rolled back, 2026-10-06)

Forward-rollback mode, one statement, every write rolled back by the final RAISE. Fixtures are looked up at run time
(no identifier is in any file). The last column is the **same reads against the previous draft's policy** (head
`2e130cde`) as the negative control for the rows it was failed on.

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
G1 open a claim whose estimate never parsed                          1      0       1           1
G2 parsed estimate with line-item sections                           1      1       1           1
G3 parsed summary-only estimate (no sections, RCV)                   1      1       1           1
G4 summary repeats the homeowner name                                1      0       1           1
G5 summary repeats the street address                                1      0       1           1
G6 summary repeats the claim number                                  1      0       1           1
G7 claim with no estimate file                                       1      1       1           1
G8 claim already open, estimate unparsed, written again              1      1       1           1
storage policy: bidding leg / world fence / selected leg      yes/yes/yes   no/no/yes   yes/yes/yes
other 31 storage policies, md5            a7f86019...   a7f86019...   a7f86019...
8 public.claims policies, md5             d5113561...   d5113561...   d5113561...
claims triggers: count / all-but-gate md5   11 / c6d066f8...   12 / c6d066f8...   11 / c6d066f8...
VERDICT                                      WIDE        NARROWED    WIDE
```

The "real bidder" is a test contractor whose flag the block sets to real, inside the rolled-back block; production
has no active real contractor on 2026-10-06. Negative controls: the live column (the current policy and no gate:
G1, G4, G5, G6 go through; every raw object reads) and the previous-draft column (R2 and R3 stay readable: the
byte-identical copy still opens). Gate rows G1 to G6 run under the owner-less superuser; the trigger fires for any
writer. File and summary contents were never read; rows were counted.

**Production unchanged by the proof runs** (fingerprint before the first run and after the last: policy qual md5,
other storage policies, claims policies, claims triggers, claims and contractors row digests, claim-documents object
digest, ledger count and head): identical, ledger `213` rows, head `20261006171747`, gate function absent.

## Not in this change (each named on #2559)

- Selected-contractor timing (selection versus fee collection) and the guard on `claims.selected_contractor_id` /
  `claims.platform_fee_charged`: Ben.
- Item (b), the claims-row allow-list view: follow-up PR, table above.
- `claims.property_address` (needed to price, and identifying): Ben's open question; not changed.
- Wording a homeowner sees when the gate refuses her submit: Ben.
- The two real claims with an estimate or measurements upload (one owned by a beta-domain account, one by a
  company-domain account): whether they are genuine jobs or test data is Ben's call (flag `is_test`); not written here.
- Contractor-facing copy (public, Ben): `contractor-how-it-works.html` "Each opportunity shows ... the homeowner's
  insurance estimate", `contractor-faq.html` the two sentences on the insurance estimate, and the cards' badges
  "Insurance Estimate" and "Measurements" which now mean "summary available" / "a file exists".

## Rollback

`supabase/migrations_drafts/gh2559_claim_docs_summary_only_rollback.sql` drops the trigger and its function and
restores the world-fenced policy text that is live today (ledger version 20261006171747), in one transaction. Then
delete this set's ledger row. WARNING: it re-opens the raw files to every bidder. Do not run it after
`gh2559_claim_docs_world_fence_rollback.sql` (the world-fence PR's rollback restores the unfenced text).
The client change does not need reverting for the rollback to be safe: with the wide policy and the new client a
bidder simply is not offered a button for a file it could read.
