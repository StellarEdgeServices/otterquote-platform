<!-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2559_claims_bid_open_guard (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: drafted with read-only database access 2026-10-19 (trigger list, column list, census below); behaviour run on a throwaway Postgres 16 (tools/gh2559-bid-open-guard-behaviour.py, 114 results as expected) -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2559_claims_bid_open_guard (Tier 3B, NOT APPLIED)

Issue #2559; binding amendment Ben, #2569 comment 6029315131 A and B.4 (CLOSE-REVIEW 6171768416 and 6275976815 both fail #2559 on its absence). Forward: `gh2559_claims_bid_open_guard.sql`. Rollback: `gh2559_claims_bid_open_guard_rollback.sql`. Proof: `supabase/tests/gh2559_claims_bid_open_guard_proof.sql`.

## What the amendment means, and the narrowest reading built
"No bid opens on an unread estimate; no identity in a summary" are the two conditions of the bid-release trigger Ben cut out of #2569 (`claims_guard_bid_release`, heads `2e130cde` / `c60b216f`, which failed REVIEW 6024856617 on five findings). So:
- **"a bid opens"** = the claim opens for bidding: `claims.ready_for_bids` false/NULL to true (the two submit paths are `dashboard.html` `submitForBids` and `react-app/app/(homeowner)/dashboard/actions.ts` `submitForBids`). It is NOT a contractor creating a quote, and it is NOT a contractor "opening" an estimate: no table records a contractor reading an estimate (grep for estimate_viewed / acknowledged: 0 hits), and since #2569 a bidder can read no raw upload.
- **"unread estimate"** = the claim carries an uploaded estimate (`estimate_filename` set or `has_estimate`) and it has not been read into the summary a bidder prices from: `loss_sheet_parsed_at` NULL, or `parsed_line_items` not an object with a non-empty `sections` array or a `summary.rcv`.
- **"identity in a summary"** = `parsed_line_items` or `contractor_scope_summary` (the two summary columns `bidder_claim_summary` returns) repeats the owner's name (`claims.homeowner_name` or `profiles.full_name`), the street line of `property_address`, or `claim_number`. Matching rules are in the forward file header.

## What changes
1. `public.gh2559_estimate_is_read(jsonb, timestamptz)` and `public.gh2559_summary_identity_hit(jsonb, text, text[], text, text)`: pure, IMMUTABLE, `search_path = public, pg_temp`, EXECUTE revoked from PUBLIC, anon, authenticated.
2. `public.claims_guard_bid_open()`: trigger function, SECURITY DEFINER (it reads `profiles.full_name`, which a homeowner's own RLS may hide), `search_path = public, pg_temp`, EXECUTE revoked likewise.
3. Trigger `claims_guard_bid_open`, BEFORE INSERT OR UPDATE OF (ready_for_bids, estimate_filename, has_estimate, loss_sheet_parsed_at, parsed_line_items, contractor_scope_summary, homeowner_name, claim_number, property_address), `WHEN (NEW.ready_for_bids IS TRUE)`. Never changes NEW. It sorts after `claims_guard_award_columns` and before `claims_guard_measurement_shape`.
4. No existing function, trigger, policy or row is touched.

## How it avoids the five findings that sank the cut trigger (REVIEW 6024856617)
| finding | here |
|---|---|
| 1 submit within about a minute of upload is refused | the same refusal exists (it is the condition), but the submit paths now WAIT silently for `loss_sheet_parsed_at` (up to 90 s, polling 3 s) before writing, with no new text; if the read never lands the database decides and the existing generic line shows |
| 2 name and claim-number checks compare empty columns | names come from `claims.homeowner_name` AND `profiles.full_name` (31 of 34 claims have a profile name; `homeowner_name` 9; `claim_number` 0) |
| 3 walk-around on an already open claim | identity is re-checked whenever the summary or the identity columns change on an open claim (including service_role writes by parse-loss-sheet) |
| 4 an empty parse passes | NULL-safe predicate; `{}`, `{"error":...}`, `sections: []` without rcv are all "unread" |
| 5 substring false positives and misses | whole-word, folded matching; numbers are never matched as names or streets; claim numbers need 6+ characters with a digit |

## Live state read 2026-10-19 (read-only SELECT, project yeszghaspzwwstvsrioa)
- `public.claims` triggers (14): none gates opening. `pg_proc` matches for `%bid_release%` / `%bid_open%`: 0 (negative control for "nothing implements it today").
- 34 claims, 14 open for bids; **4 of the 14 open claims have an estimate and no `loss_sheet_parsed_at`** (grandfathered: the trigger fires on opening, and on open claims only when a summary or identity column changes, so these are not touched until one of those columns changes).
- Re-run at apply time and paste: `SELECT count(*) FROM pg_trigger WHERE tgrelid='public.claims'::regclass AND tgname='claims_guard_bid_open';` (expect 0 before, 1 after) and the open-with-unparsed census: `SELECT id, is_test FROM claims WHERE ready_for_bids AND (estimate_filename IS NOT NULL OR has_estimate) AND loss_sheet_parsed_at IS NULL;`.
- Identity census before apply (read-only, using the forward file's helper on a throwaway copy, NOT on production): for each open claim, would `gh2559_summary_identity_hit(parsed_line_items, contractor_scope_summary, ARRAY[homeowner_name, full_name], property_address, claim_number)` be non-NULL? Marty to run it on a restored copy or read the rows and apply the rule by hand; a non-NULL on an open claim means the next parse write to it is refused.

## Apply order
1. Merge and PUBLISH the `dashboard.html` and React `actions.ts` change in this PR first (the submit waits for the read). Applying the trigger first would refuse a submit made within seconds of the upload.
2. R-097 24-hour notice, REVIEW + LEGAL-READ (consent) and Ben's signature, then apply the forward file; file it under its ledger version.
3. Proof: `supabase/tests/gh2559_claims_bid_open_guard_proof.sql` as a forced rollback on production. Expected: D1 to D7 `BEFORE ACCEPTED | AFTER REJECTED 23514 [gh2559-bid-open] | ROLLBK ACCEPTED`; C1 to C5 ACCEPTED in all three columns; `trigger after final rollback: 0`.

## Consequences a reviewer should weigh (consent / trust, Tier 3B)
- A claim whose estimate the parser cannot read (blank scan, error marker, no sections and no total) can never open for bids while that file stays attached. The refusal text is a PLACEHOLDER in the function and a `null` constant in both clients: the homeowner sees only the existing "Failed to submit your project" line. **Ben's wording is required before apply.**
- parse-loss-sheet (service_role) writing a summary that repeats the owner's name onto an already open claim is refused (its write fails; the old summary stays). Whether it should instead scrub or withdraw the claim is Q3.
- Residual: a name of one word, an address with no house number, or an identity written in a language or spelling the folding does not reach (a nickname, a transliteration) is not caught; one middle word between first and last name is allowed, so two common words can collide ("Park, ridge cap ... "). The parser instruction (parse-loss-sheet) and the D-390 redaction (#2880) remain the other safeguards.

## Open questions (recorded, not decided)
- **Q1** Does "no bid opens on an unread estimate" mean the claim-opening reading built here, or a per-contractor acknowledgement before a quote can be created? Nothing in the schema supports the second (no read record, no bidder-readable file), so it would be a new table, a new bid-form step and contractor-facing copy.
- **Q2** An estimate replaced on an already open claim by an unparsed one is NOT refused (it would block a homeowner's upload, and the parser then rewrites the summary, which condition 2 checks).
- **Q3** For an already open claim whose newly parsed summary carries identity: refuse the write (built), scrub it, or withdraw the claim from bidding.
- **Q4** What the homeowner is told on a refused submit (Ben, 6029315131 A).
- **Q5** The four grandfathered open claims with an unparsed estimate: leave, or re-parse.

## Rollback
`gh2559_claims_bid_open_guard_rollback.sql`: drops the trigger and the three functions. No data is changed either way. Proved on a throwaway Postgres (ROLLBK column all ACCEPTED, 0 functions left) and in the proof file's third phase.
