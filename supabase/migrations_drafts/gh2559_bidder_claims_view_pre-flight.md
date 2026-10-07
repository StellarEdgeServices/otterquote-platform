<!--
STATUS (gh-1438, as of 2026-10-07T19:20:06Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh2559_bidder_claims_view and set gh2559_claims_policy_narrow (the STATUS is the sets'; it describes the forward migrations)
EVIDENCE: no ledger row for either set; no view named bidder_claim_summary exists; the two contractor SELECT policies on public.claims are live (pg_class, pg_policy and the ledger read 2026-10-06, before and after every proof run). Forward and rollback of both were run on production inside one rolled-back block (supabase/tests/gh2559_bidder_claims_view_proof.sql) at head f4bdedce. After REVIEW: FAIL 6025641188 the view's location_city and location_zip expressions were changed (2026-10-07); the new expressions were measured read-only against public.claims (section "Location" below) and the changed view and the proof rows L1 to L4 were NOT re-run on production by the worker who changed them.
REPO COPY: none. When the forward files are applied, move this file to supabase/migrations_rollbacks/ under the first forward file's ledger version.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh2559_bidder_claims_view + gh2559_claims_policy_narrow (the claims-row half of D-368)

**Migrations**: `supabase/migrations_drafts/gh2559_bidder_claims_view.sql` (additive) and `supabase/migrations_drafts/gh2559_claims_policy_narrow.sql` (Tier 3B). NOT APPLIED.
**Author**: worker for Marty (CTO RUN 61, claim `cto-2026-10-06T15:13:52Z`, tid `cto61-claims-view`).
**GitHub**: Refs #2559. **Decision**: D-368 ("Summary only", Dustin, comment 6018744630). **Split out by**: PR #2569, comment 6024529507.

## The problem, measured

One database login role (`authenticated`) serves homeowners and contractors, so column privileges cannot separate them. Production
2026-10-06: `authenticated` has SELECT on all 130 columns of `public.claims`, and two contractor policies let a contractor read the whole row:
"Contractors can view biddable claims" (every active contractor, every claim open for bids) and "Contractors can view claims for their quotes"
(every contractor who has put in a bid, selected or not, open or closed). So a bidder reads the homeowner's name, the claim number, the
estimate file name, and the adjuster's name, email and phone, before being selected.

## What this set does

1. **`public.bidder_claim_summary`** (view, additive). Owned by postgres, so it reads `claims` past row security, and carries its own row filter and
   column list. It is the only thing a bidder can read of a claim before selection once step 3 is applied.
2. **The bidder call sites read the view** (this PR's page change: 3 static pages and the React app).
3. **`gh2559_claims_policy_narrow.sql`** (Tier 3B): the two contractor SELECT policies on `public.claims` are replaced by one, "Contractors can view claims
   they are selected on". A contractor reads the base row only when `claims.selected_contractor_id` is its own.

## APPLY ORDER (the page change must be live before the policy narrows)

| step | what | tier | waits for |
|---|---|---|---|
| 1 | apply `gh2559_bidder_claims_view.sql` | additive; nothing changes for anyone; rollback = `DROP VIEW` | review of this PR |
| 2 | merge this PR, then PUBLISH the static pages and the React app (Netlify production is locked until published) | deploy | step 1 live (the new pages read the view) |
| 3 | apply `gh2559_claims_policy_narrow.sql` | **3B**, R-097 24-hour notice | step 2 PUBLISHED; the notice window; REVIEW; LEGAL-READ; Ben's R-177 signature; Ben's answers to the open Q: lines on notice 6024524228 |

**Why this order, shown not argued.** Row `PGOLD` of the proof: the OLD opportunities-page query (`select * from claims ... ready_for_bids ...`) returns 10 rows
for a test bidder on production today and **0 rows after step 3**. Anyone still running the old page when step 3 lands sees an empty opportunities list and
an empty bid form. The new page query against the view returns 8 rows (row `PG1`) in every phase from step 1 on. If step 2 ships first the pages break
(the view does not exist); if step 3 ships first the pages break (the base row is gone). So: 1, then 2, then 3.

The static pages are served by Netlify and can be cached by a browser for a short while; the React app is a build. After step 2, wait until the published
deploy is the one answering (`_cto53_netlify.py` shows it) before step 3.

## Call-site enumeration (unfiltered grep at the branch base; every hit read)

Command: `grep -rnE "from\(['\"]claims['\"]\)" --include=*.html --include=*.js --include=*.ts --include=*.tsx .` (excluding node_modules, tests) and
`grep -rnE "claims(!|\(|:)" ...` for embeds. Of ~90 hits, those run by a CONTRACTOR session (the rest are homeowner, admin or partner pages that filter on the caller's
own `user_id`, or edge functions that use the service role):

| # | page | line (before) | what it read | now |
|---|---|---|---|---|
| 1 | `contractor-opportunities.html` | 536 | `from('claims').select('*')` open claims | `bidder_claim_summary`, 34 named columns |
| 2 | `contractor-bid-form.html` | 3507 | `claims.select('*, carrier_profiles(carrier_name)')` one claim | `bidder_claim_summary`, 19 named columns; carrier from `carrier_profile_name` |
| 3 | `contractor-dashboard.html` | 1258 | `from('claims').select('*')` for the "available" count | `bidder_claim_summary`, `id, trades, status` |
| 4 | `contractor-dashboard.html` | 1355 | `quotes ... claims(id, property_address, damage_type, ...)` embed | embed kept for won projects (selected: still readable); pending bids read city, zip, damage type from the view |
| 5 | `contractor-dashboard.html` | 2098 | `quotes ... claims:claim_id(id, user_id, property_address)` (messaging labels) | label = full address only once selected, else city and zip from the view; `user_id` no longer read |
| 6 | `react-app/.../opportunities/use-opportunities-data.ts` | 53 | `from('claims').select('*')` | `bidder_claim_summary`, same list as #1 |
| 7 | `react-app/.../bid/[claimId]/page.tsx` | 106 | `claims.select('*, carrier_profiles(carrier_name)')` | `bidder_claim_summary`, same list as #2 |
| 8 | `react-app/.../dashboard/use-dashboard-data.ts` | 112 and 170 | `from('claims')` count; quotes embed | as #3 and #4 |
| 9 | `react-app/.../dashboard/Messaging.tsx` | 54 | `quotes ... claims:claim_id(id, property_address)` | as #5 |

Not changed, and why: `contractor-dashboard.html:1670` (`payment_failures` joined to `claims(property_address)`): a payment failure belongs to a contractor who was
selected, so the base row stays readable to them. `contractor-about.html:625` is the HOMEOWNER viewing a contractor's page (filters `user_id = current user`).
`js/auth.js:1040` and `js/video-upload-handler.js:65` are homeowner paths. Edge functions use the service role.

Columns a page reads that DO NOT EXIST on `claims` (the page reads `undefined` today, nothing changes): `address_city`, `address_zip`, `address_state`, `selected_trades`,
`damage_description`, `insurance_carrier`, `material_product`. The pages used to derive city and zip from `property_address`; the view does NOT derive them the same way (the pages' rule returned the whole street line for an address with no comma). See "Location" below.

Policies and triggers elsewhere that read `claims` under the caller's row security were checked (pg_policy and pg_proc, 2026-10-06): only homeowner-side policies
(`messages`, `quotes`, `scope_records`, `adjuster_email_requests`: all `claims.user_id = auth.uid()`) and the storage policy for the selected contractor (kept readable by this
change). The `quotes` triggers that read `claims` are SECURITY DEFINER, except `quotes_guard_homeowner_columns`, which reads it only for the homeowner-owned test.
**No bidder write path depends on reading the base row.**

## Allow-list: every `claims` column, marked (130 columns)

Classes: **needed-to-price** and **needed-for-UI** = in the view. **identity-or-contact** = must NOT be exposed before selection. **unused** = no bidder page reads it (and not exposed).
"Read by": OH contractor-opportunities.html, OR React opportunities, BH contractor-bid-form.html, BR React bid form, DH contractor-dashboard.html, DR React dashboard, MS messaging.
Counts: needed-to-price 20, needed-for-UI 17, identity-or-contact 21, unused 72. The view has 41 output columns: the 37 needed columns (`hover_measurements` and `carrier_id` come out as the derived `measured_squares` and `carrier_profile_name`; `has_estimate` and `has_measurements` fold in the file-name test), the 2 derived location columns, and the 2 selected-only file names.

| claims column | class | in the view as | read by | what a bidder gets instead / note |
|---|---|---|---|---|
| `id` | needed-for-UI | id | OH OR BH BR DH DR MS | key; the card id and the job number (last 8) on the bid form |
| `user_id` | identity-or-contact | not in the view | BH BR | the bid form passed it to a notification insert to the homeowner that row security refuses today (0 rows ever written); it now passes null, no change in outcome; the homeowner's account id |
| `claim_number` | identity-or-contact | not in the view | - | the insurer's claim number |
| `status` | needed-for-UI | status | OH OR DH DR | filter: open claims are active, bidding or pending |
| `created_at` | needed-for-UI | created_at | OH OR | "filed" date on the card, sort order |
| `updated_at` | unused | not in the view | - |  |
| `carrier_id` | needed-to-price | carrier_profile_name (the carrier's name from carrier_profiles) | BH BR | "Carrier" on the bid form |
| `adjuster_id` | identity-or-contact | not in the view | - | the adjuster record |
| `adjuster_name` | identity-or-contact | not in the view | - | adjuster name |
| `adjuster_email` | identity-or-contact | not in the view | - | adjuster email |
| `adjuster_phone` | identity-or-contact | not in the view | - | adjuster phone |
| `ingest_email` | identity-or-contact | not in the view | - | forwarding address for the homeowner's insurance mail |
| `material_category` | needed-to-price | material_category | BH | material line on the bid form |
| `shingle_type` | needed-to-price | shingle_type | BH | material line on the bid form |
| `impact_class` | needed-to-price | impact_class | BH | material line on the bid form |
| `designer_product` | needed-to-price | designer_product | BH | material line on the bid form |
| `designer_manufacturer` | needed-to-price | designer_manufacturer | BH | material line on the bid form |
| `metal_type` | unused | not in the view | - |  |
| `metal_material` | unused | not in the view | - |  |
| `color_brand` | unused | not in the view | - |  |
| `color_name` | unused | not in the view | - |  |
| `color_selected_at` | unused | not in the view | - |  |
| `color_addendum_signed` | unused | not in the view | - |  |
| `hover_order_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `hover_status` | unused | not in the view | - |  |
| `hover_paid` | unused | not in the view | - |  |
| `hover_rebated` | unused | not in the view | - |  |
| `has_estimate` | needed-for-UI | has_estimate (true if the flag is set OR an estimate file exists) | OH OR | the "Insurance Estimate" badge on the card |
| `has_measurements` | needed-for-UI | has_measurements (true if the flag is set OR a measurements file exists) | OH OR | the "Measurements" badge on the card |
| `has_material_selection` | unused | not in the view | - |  |
| `ready_for_bids` | needed-for-UI | ready_for_bids | OH OR DH DR | filter: open for bids |
| `bids_submitted_at` | unused | not in the view | - |  |
| `selected_contractor_id` | needed-for-UI | selected_contractor_id (the caller's own id, else null) | OH OR BH BR | decides whether the file buttons show (PR #2569) |
| `contract_signed_at` | unused | not in the view | - |  |
| `docusign_envelope_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `deductible_amount` | needed-to-price | deductible_amount | OH OR | deductible on the card |
| `deductible_collected` | unused | not in the view | - |  |
| `deductible_stripe_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `platform_fee_charged` | unused | not in the view | - |  |
| `platform_fee_amount` | unused | not in the view | - |  |
| `platform_fee_stripe_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `estimate_filename` | identity-or-contact | estimate_filename (selected contractor only, else null) | OH OR BH BR | storage path holds the homeowner's user id; a bidder sees has_estimate and the parsed summary instead |
| `measurements_filename` | identity-or-contact | measurements_filename (selected contractor only, else null) | OH OR BH BR | same; a bidder sees has_measurements instead |
| `date_of_loss` | unused | not in the view | - |  |
| `damage_type` | needed-for-UI | damage_type | OH OR BH BR DH DR | "Damage" on the card and form |
| `job_type` | needed-to-price | job_type | OH OR BH BR | insurance_rcv / retail; drives the fee base |
| `rcv_amount` | needed-to-price | rcv_amount | OH OR BH BR | insurer RCV: estimated value on the card, the fee base, the form total |
| `acv_amount` | needed-to-price | acv_amount | OH OR | ACV payout on the card |
| `roof_squares` | needed-to-price | roof_squares | OH OR | squares on the card |
| `repair_squares` | needed-to-price | repair_squares | OH OR | squares on the card |
| `existing_shingle_brand` | needed-to-price | existing_shingle_brand | OH OR | "existing shingle" on the card |
| `existing_shingle_product` | unused | not in the view | - |  |
| `existing_shingle_color` | needed-to-price | existing_shingle_color | OH OR | "existing shingle" on the card |
| `urgency` | needed-for-UI | urgency | OH OR | card |
| `urgency_deadline` | needed-for-UI | urgency_deadline | OH OR | card |
| `urgency_reason` | needed-for-UI | urgency_reason | OH OR | card. Free text typed by the homeowner (QUESTION 2) |
| `homeowner_notes` | needed-for-UI | homeowner_notes | OH OR | "Homeowner Notes" block on the card. Free text typed by the homeowner (QUESTION 2) |
| `referral_code` | identity-or-contact | not in the view | - | who referred the homeowner |
| `referral_id` | identity-or-contact | not in the view | - | referral record |
| `policy_type` | unused | not in the view | - |  |
| `funding_type` | needed-to-price | funding_type | OH OR BH BR | insurance vs cash; drives the form |
| `trades` | needed-to-price | trades | OH OR BH BR DH DR | which trades the claim needs; trade filter and bid wizard |
| `repair_type` | unused | not in the view | - |  |
| `repair_description` | unused | not in the view | - |  |
| `repair_shingle_count` | unused | not in the view | - |  |
| `roof_age_years` | unused | not in the view | - |  |
| `material_id_method` | unused | not in the view | - |  |
| `material_id_status` | unused | not in the view | - |  |
| `itel_order_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `itel_status` | unused | not in the view | - |  |
| `ai_id_confidence` | unused | not in the view | - |  |
| `trade_intents` | unused | not in the view | - |  |
| `color_confirmation_envelope_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `contract_sent_at` | unused | not in the view | - |  |
| `contract_signed_by` | identity-or-contact | not in the view | - | who signed |
| `selected_bid_amount` | unused | not in the view | - |  |
| `deductible_collected_at` | unused | not in the view | - |  |
| `homeowner_name` | identity-or-contact | not in the view | - | the homeowner's name |
| `contract_declined_at` | unused | not in the view | - |  |
| `contract_voided_at` | unused | not in the view | - |  |
| `color_confirmed_at` | unused | not in the view | - |  |
| `property_address` | identity-or-contact | location_city and location_zip (derived: the second comma part only when a comma exists, the five digits at the end); the street is not returned | OH OR BH BR MS DH DR | pages showed the street (bid form, messaging labels) or parsed city and zip from it; they now show "City, IN zip" (D-074) |
| `ingest_email_address` | identity-or-contact | not in the view | - | same |
| `parsed_line_items` | needed-to-price | parsed_line_items | BH BR | THE SUMMARY: carrier, date of loss, pricing database, sections, line items, totals (keys read 2026-10-06). Shown in the "Insurance Line Items" panel and used to price |
| `contractor_scope_summary` | needed-to-price | contractor_scope_summary | OH OR | THE SUMMARY text on the card |
| `loss_sheet_parsed_at` | unused | not in the view | - |  |
| `project_confirmation` | identity-or-contact | not in the view | - | signed project confirmation data |
| `project_confirmation_envelope_id` | unused | not in the view | - | payment, signing or vendor reference id; must not be exposed |
| `referral_source` | identity-or-contact | not in the view | - | referral source |
| `referral_agent_id` | identity-or-contact | not in the view | - | the referring agent |
| `contractor_switched_at` | unused | not in the view | - |  |
| `contractor_switch_count` | unused | not in the view | - |  |
| `siding_bid_released_at` | needed-for-UI | siding_bid_released_at | OH OR BH | which trades are open for bids (D-165) |
| `roofing_bid_released_at` | needed-for-UI | roofing_bid_released_at | OH OR | which trades are open for bids (D-165) |
| `gutters_bid_released_at` | needed-for-UI | gutters_bid_released_at | OH OR | which trades are open for bids (D-165) |
| `windows_bid_released_at` | needed-for-UI | windows_bid_released_at | OH OR | which trades are open for bids (D-165) |
| `bid_window_expires_at` | needed-for-UI | bid_window_expires_at | OH OR | bid countdown on the card |
| `bid_window_notified_at` | unused | not in the view | - |  |
| `property_state` | unused | not in the view | - |  |
| `switch_reason_survey` | identity-or-contact | not in the view | - | the homeowner's answers about why they switched contractor |
| `completion_date` | unused | not in the view | - |  |
| `video_url` | identity-or-contact | not in the view | - | path of the homeowner's uploaded video |
| `profile_prompt_sent_at` | unused | not in the view | - |  |
| `is_test` | unused | not in the view | - |  |
| `carrier_name` | unused | not in the view | - |  |
| `hover_measurements` | needed-to-price | measured_squares (the squares number only) | OH | squares the measurement-upgrade price is set from; the rest of the object (who entered it, lengths, areas by pitch) is not exposed |
| `project_confirmation_signed_at` | unused | not in the view | - |  |
| `referrer_updates_opt_out` | unused | not in the view | - |  |
| `measurement_shape` | needed-to-price | measurement_shape | OH OR | basic / full, drives the upgrade offer |
| `live_charge_authorized_at` | unused | not in the view | - |  |
| `live_charge_authorized_by` | identity-or-contact | not in the view | - | who authorised a charge |
| `loss_sheet_reviewed_at` | unused | not in the view | - |  |
| `utm_source` | unused | not in the view | - | marketing attribution |
| `utm_medium` | unused | not in the view | - | marketing attribution |
| `utm_campaign` | unused | not in the view | - | marketing attribution |
| `utm_content` | unused | not in the view | - | marketing attribution |
| `utm_term` | unused | not in the view | - | marketing attribution |
| `fbclid` | unused | not in the view | - | marketing attribution |
| `gclid` | unused | not in the view | - | marketing attribution |
| `first_touch_landing_path` | unused | not in the view | - | marketing attribution |
| `first_touch_referrer` | unused | not in the view | - | marketing attribution |
| `first_touch_at` | unused | not in the view | - | marketing attribution |
| `property_city` | unused | FIRST source for location_city; the address is the fallback | - |  |
| `property_zip` | unused | fallback for location_zip when the address has none | - |  |
| `signed_contract_price` | unused | not in the view | - |  |
| `signed_price_raw` | unused | not in the view | - |  |
| `signed_price_verdict` | unused | not in the view | - |  |
| `signed_price_reason` | unused | not in the view | - |  |
| `signed_price_checked_at` | unused | not in the view | - |  |
| `out_of_state_alerted_at` | unused | not in the view | - |  |

## The view

Eligibility, one filter: (a) open for bids (`ready_for_bids`, status active, bidding or pending) AND the caller is an ACTIVE contractor AND `c.is_test = ct.is_test`;
OR (b) the caller is selected on the claim; OR (c) the caller has a quote on the claim (any status; this keeps the caller's own pending bid readable after the claim closes).
- **World match.** The storage policy for contractors carries `c.is_test = ct.is_test`; the **live claims policy does not** (it lets a test contractor read real claims). The view uses
  the strict match. Effect, measured (proof rows `T-all` and `T-view`): a test contractor reads 10 claims through the old page query today and 8 through the view; the 2 it loses are real claims.
  A real contractor loses nothing (2 and 2). See QUESTION 1.
- **`security_barrier = true`**, so a function in a caller's WHERE clause cannot see rows the view's own filter has not removed. Names are schema-qualified. A view has no body that resolves
  names at run time, so there is no `search_path` to pin; the filter uses `(SELECT auth.uid())`.
- **Grants: the minimum, and no GRANT statement.** Supabase's default privileges already give a new relation in `public` to `anon`, `authenticated` and `service_role`. The file REVOKEs everything
  except what is needed: `REVOKE ALL FROM PUBLIC, anon`, and `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER FROM authenticated`. Measured ACL after the forward file (proof):
  `{postgres=arwdDxtm/postgres,authenticated=rm/postgres,service_role=arwdDxtm/postgres}`: `r` is SELECT; `m` is MAINTAIN, which Postgres 17 adds to default table privileges (it lets VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH run; on a view it does nothing a reader can use).
  An assertion at the end of the file fails the migration if authenticated lacks SELECT or anon/authenticated hold anything more.
  **Label**: the permissions ratchet (`No new GRANT to anon/PUBLIC/authenticated`) looks for `GRANT` statements in `supabase/migrations/**` lines a PR adds. This file has none and sits in
  `migrations_drafts/` (outside the ratchet's scope by construction), so **no label is needed on this PR**. When the forward file is later filed in `supabase/migrations/`, it still has no GRANT; if a reviewer prefers an
  explicit `GRANT SELECT ... TO authenticated` (so the access does not depend on the default), that line needs the label `permissions-ratchet: reviewed` on the filing PR.
- Raw file names go to the selected contractor only (a path holds the homeowner's user id). Everyone else reads null, and has_estimate / has_measurements still say a file exists.

## What a bidding contractor stops seeing, still sees, what could go wrong

- **Stops seeing, before selection**: the homeowner's name, the claim number, the estimate and measurements file names, the adjuster's name, email and phone, the ingest email addresses, referral and click ids, payment and signing reference ids, and the street address (the bid form and the messaging labels used to show it; they show city and zip).
- **Still sees**: the whole summary: carrier, date of loss, line items and totals, scope summary, RCV, ACV, deductible, squares, trades, damage type, material, urgency, the homeowner's notes, release and bid-window dates, whether an estimate and measurements exist. A selected contractor reads exactly what it reads today.
- **What could go wrong**: (1) a page still running the old code after step 3 shows an empty list (hence the order); (2) a test contractor no longer sees real claims (QUESTION 1); (3) the dashboard's "Won" project list and messaging labels for a bid that is lost lose their full address (they show city and zip: lost bids never were entitled to it).
- **Rollback**: `gh2559_claims_policy_narrow_rollback.sql` restores the two policies byte for byte from live (text read from `pg_policy`); `gh2559_bidder_claims_view_rollback.sql` drops the view. Order: narrowing first, then the view. Both were run in the proof.

## Proof (one self-rolling-back block on production, role-switched reads)

`supabase/tests/gh2559_bidder_claims_view_proof.sql`: a single DO block ending in RAISE; fixtures looked up at run time, no id in the file. It prints the matrix five times (live, after the view, after view + narrowing, after the narrowing's rollback, after the view's rollback) and a VERDICT per column. Result: all five phases AS EXPECTED, 0 mismatches, 55 rows each. Production unchanged: the fingerprint (claims policies md5, storage policies md5, claims triggers, ledger count and latest version, md5 of the claims, contractors and quotes tables, md5 of every public table/view ACL) is identical before and after.
Key rows (live / after view / after view + narrowing): a bidder reading the BASE row of a claim it is only bidding on or eligible for `1 / 1 / 0` (B1, B2, Q1, Q3, R1, R6, Q4); the same bidder through the VIEW `-2 (view absent) / 1 / 1`; raw file names through the view for a non-selected bidder `0`; the selected contractor reads the base row `1 / 1 / 1` and gets its file path (S6, positive control); owner, admin, service role unchanged; anon refused (`-3`); the old opportunities query `10 / 10 / 0`, the new `-2 / 8 / 8`.
**Negative control**: the same file run with no migration text prints the live matrix only: every view row answers `-2`, every bidder base row `1`, `PGOLD` 10, and its VERDICT line reads `live matrix=AS EXPECTED`; the first version of this proof, run against the forward migration, failed on one row (O2, a homeowner who is also a contractor reads the view by contractor identity), which showed the expectation was wrong and was corrected (the proof fixture is now a homeowner with no contractor account).

## Location (changed after REVIEW: FAIL 6025641188 and again after REVIEW: FAIL 6047719061)

Dustin, 2026-10-07 (comment 6038067961 on #2559, question 2): "City and zip only (Recommended)". The rule the view
applies, fail closed (a value it is not sure of is returned as NULL and the page shows "Unknown"):

- `location_city` = the first of (`property_city`, the SECOND comma part of `property_address` when the address has
  a comma) that passes every test, after a trailing ", ST 12345" is cut off it. Refused: a value with a digit, a line
  break or any character other than letters, space, dot, apostrophe and hyphen; longer than 40 characters; whose
  last word is a street type (Rd, Street, Ave, Ln, Ct, Blvd, Way ...); or that contains a unit word (Unit, Apt,
  Suite, Lot, Box, Bldg ...). Never the first comma part, never an unsplit address.
- `location_zip` = the five digits at the end of `property_address`, only when a US state code stands directly before
  them; else `property_zip` when it is exactly a zip. A box, lot, road or house number is never a zip.

**Behavioural proof, throwaway Postgres 16 (pgserver), this view file run verbatim:**
`tools/gh2559-bidder-view-behaviour.py` plants 21 address shapes and 12 note shapes on open real claims and reads them
as a contractor who is only bidding. This head: `rows read by the bidder: 36 | leaks: 0 | other failures: 0`.
Negative control, the same plants against the view file of head `37391cfe`: `leaks: 65 | other failures: 12`
(the four `location_city` shapes, the box and lot numbers as zip, and every note).

Production, measured read-only on 2026-10-07 with the FIRST fix (head `37391cfe`), old expressions beside it:
city equals the stored address 2 real claims old, 0 new; zip is the house number 1 old, 0 new (30 claims, counts
only). The rule at this head is stricter than that one and was not re-measured on production.

Known limits, stated: (1) a street name with no type word, typed as the second comma part or into the city column
("4417, Larkspur Hollow, Carmel"), is returned as the city; nothing distinguishes it from a town. (2) A real town
whose name ends in a street-type word or holds a unit word is shown as "Unknown".

## Free text: `homeowner_notes` and `urgency_reason` (CEO ruling 6045859470)

The selected contractor reads both as typed. Every other caller reads them redacted: the whole value is replaced
when it holds the claim's own street line or homeowner name; a line with a house number and a street type, or a PO
box, is replaced; email addresses are replaced; any run of seven or more digits (a phone number in any common layout)
is replaced. The replacement text is `[removed]`. A repair claim's notes (`job_type = 'repair'`) are withheld from a
bidder altogether: the repair intake writes to the same column without the "Notes for Contractors" label, and the
ruling says label it or hide it. **Cost: a bidder on a repair claim does not see the homeowner's description of the
problem until selected.** Labelling the repair intake instead is homeowner-facing copy and is put to the CEO.
It cannot recognise a name it was not given or an address written without a number.

## The street address outside the view: `get-hover-siding-data`

The edge function returned the vendor job's full address as `job_address` to any active contractor on a claim open
for bids, and the bid form printed it. In this PR: the function gives `job_address` to the service role, the claim's
owner and the selected contractor only (`job-address.ts`, with tests), and the bid form (static and React) no longer
prints or caches it for anyone. **The function change is code only: it is NOT DEPLOYED by merging and needs its own
notice.** The pages stop printing on publish, so the page half does not wait for the deploy; until the deploy the
address is still in the function's response for a bidder who calls it directly. Production 2026-10-07 (review
6047719061, SELECT): 0 vendor orders with a job id, so nothing is returned today.

**What protects `parsed_line_items`.** Nothing in the database. The parser is instructed not to output the
homeowner's identity (`supabase/functions/parse-loss-sheet`); a check is a named remaining part of #2559.

## QUESTIONS (recommended defaults)

1. **World match.** The view applies the storage policy's `c.is_test = ct.is_test`, stricter than the live claims policy. A test contractor therefore stops seeing the 2 real claims it sees today (a real contractor loses nothing). Recommended: keep strict (it is the rule D-368's storage half already carries). If test contractors must keep seeing real claims for walk-throughs, say so and the view's first branch becomes `(NOT c.is_test OR ct.is_test)`.
2. **Free text. ANSWERED** (CEO, 6045859470): bidders keep seeing them with phone numbers, email addresses and street-number lines blanked; the selected contractor sees them as typed; repair-intake notes are labelled or hidden. Built as the section "Free text" above (hidden, not labelled).
3. **Copy. ANSWERED.** The React bid form's "Address" label becomes "Location" and shows "City, IN zip" (the static form already showed city and zip). Dustin, 2026-10-07 (comment 6038067961 on #2559, question 2): "City and zip only (Recommended)"; the option he chose reads "The bid form's Address field becomes Location."
4. **Dead write.** The bid form's "bid updated" notification to the homeowner has never written a row (row security refuses a contractor inserting for another user; 0 such rows exist). Not fixed here; it is a different bug.
