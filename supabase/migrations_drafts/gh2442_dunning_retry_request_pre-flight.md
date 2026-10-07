<!-- STATUS (gh-1438, as of 2026-10-07T22:44Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: function and both columns absent, anon UPDATE/TRUNCATE/TRIGGER present, payment_failures 0 rows on production, read-only SELECT 2026-10-07 (gh-2442 SQL-only revision); see Proof below -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2442_dunning_retry_request (Tier 3B, NOT APPLIED)

Issue #2442. Decision **D-379** (2026-10-07): a contractor may request a retry of the saved payment method after a failed platform-fee charge, at most 3 times per failed payment for the life of that failure, and only until the homeowner notice goes out. Build ruling: comment 6025103626 (option A). Split order: PR #2579 comment 6029194857 (SQL only).

Forward: `gh2442_dunning_retry_request.sql`. Rollback: `gh2442_dunning_retry_request_rollback.sql`. Proof: `supabase/tests/gh2442_dunning_retry_request_proof.sql`. Scratch-database fixture: `supabase/tests/gh2442_replica_fixture.sql`. Concurrency harness: `supabase/tests/gh2442_concurrency_harness.py`.

This set is SQL only. No page calls the function and no job reads the columns. The page change and the `process-dunning` retry pass are a separate, later pull request.

## What changes
1. `payment_failures.retry_requested_at timestamptz` (nullable, no default). Existing rows read NULL.
2. `payment_failures.retry_request_count integer NOT NULL DEFAULT 0`, with `CHECK (retry_request_count BETWEEN 0 AND 3)` (constraint `payment_failures_retry_request_count_check`). Existing rows read 0.
3. `request_dunning_retry(p_failure_id uuid) returns jsonb`. SECURITY DEFINER, `search_path = public, pg_temp`, no dynamic SQL. It writes those two columns and nothing else.
4. EXECUTE on that function: revoked from PUBLIC and anon, granted to `authenticated`.
5. `REVOKE UPDATE, TRUNCATE, TRIGGER ON payment_failures FROM anon`.

## Grant ratchet
Item 4 is a new GRANT to `authenticated`. When this file is filed under `supabase/migrations/` at apply time, the `No new GRANT to anon/PUBLIC/authenticated` check (`scripts/permissions-ratchet.py`, scope `supabase/migrations/**`, so it does not read this directory and has not measured this grant) will flag it. The PR that files it needs the label `permissions-ratchet: reviewed`. REVOKE lines always pass.

## Every state the code can leave a row in
Enumerated from `supabase/functions` at `main` 7bc8a3cb (2026-10-07) by reading every insert and update on `payment_failures`. Three functions insert (`process-dunning/index.ts:1083`, `stripe-webhook/index.ts:1037`, `docusign-webhook/index.ts:1633`); only `process-dunning` updates.

| | `dunning_status` | `resolved_at` | written by | answer to the owner |
|---|---|---|---|---|
| S1 | `active` | NULL | the three inserts | accepted |
| S2 | `warning_sent` | NULL | `process-dunning/index.ts:1225-1227` | accepted |
| S3 | `homeowner_notified` | NULL | `process-dunning/index.ts:1298`, `:1341` | `not_retryable` / `homeowner_notified` |
| S4 | `resolved` | set | `process-dunning/index.ts:612` only (homeowner clicked "Move Forward") | `not_retryable` / `homeowner_proceeded` |
| S5 | `contractor_out` | set | `process-dunning/index.ts:662` only (homeowner chose a different contractor) | `not_retryable` / `contractor_out` |

The CHECK on `dunning_status` also allows `escalated` and `expired`; no code under `supabase/functions` writes either. Those, a NULL status, and any shape not in the table (for example `active` with `resolved_at` set) answer `not_retryable` / `other_closed`. The function tests `dunning_status` before `resolved_at`, because S4 and S5 both carry `resolved_at`.

"Accepted" means: `requested` (sets `retry_requested_at = now()`, adds 1 to the count); or `already_requested` if the stored request is less than 15 minutes old (writes nothing); or `not_retryable` / `limit_reached` if 3 requests are already recorded and the last is more than 15 minutes old (writes nothing).

Everyone else: another contractor, a homeowner, an unknown or NULL id, a login-less caller get error 42501 "payment failure not found" (same text for all, so ids cannot be probed); anon gets 42501 permission denied for function.

Every answer carries `status`, `reason`, `dunning_status` (the stored value, which the owner can already read through the policy `contractor_select_own_payment_failures`), `retry_requested_at` and `requests_remaining`.

## What `reason` means, and what it does not (LEGAL-READ 6045706206 finding 1, REVIEW 6047683096 finding 1)
`reason` repeats what the row says. It never says whether money is owed. The previous head (ad4b00c) called S4 and S5 both `resolved` and described that as a settled failure; that was wrong and is removed. `resolved` is written only at `:612`, the branch where the homeowner goes ahead while the platform fee is still unpaid, and no code marks a failure resolved because a payment succeeded. What a page may say to a contractor for each reason is not decided in this set: it belongs to the page pull request and its own LEGAL-READ. No customer-visible text is added by this set.

## When a request is accepted (D-379: only until the homeowner notice goes out)
Only in S1 and S2. The homeowner notice is the moment `process-dunning` sets `homeowner_notified` (S3). One edge, stated so nobody is surprised: the scheduled job runs every 30 minutes, so between the time a notice falls due (`homeowner_notify_at`) and the job's next run the row is still `warning_sent` and a request is still accepted. The request only records a time and a count.

## The cap (D-379: up to 3 per failed payment)
Held in two places: the function (`c_max_requests = 3`, tested and incremented under the row lock) and the table (`CHECK (retry_request_count BETWEEN 0 AND 3)`), so no writer of any role, including a service-role job, can store a count outside 0 to 3. Changing the number means changing both in a reviewed migration.

What the cap does not do (LEGAL-READ finding 3; CEO comment 6045861846):
- It counts requests on one `payment_failures` row. A service-role job can still set the count back to 0, or write `retry_requested_at` itself.
- `process-dunning` inserts a new `payment_failures` row when a charge fails (`index.ts:1083`). A retry pass that reused that code would start a fresh allowance of 3 after every decline. The limit that protects a card must also live in the retry pass, counted per quote, and that pass must skip hard declines.
- A `retry_requested_at` in the future would read `already_requested` until that time passes. No contractor can write the column; noted for whoever writes the retry pass.

## Rollback
Drops the function and both columns (the CHECK goes with its column). It does NOT give the logged-out role (anon) back the three write permissions the forward file removed. After a rollback the table's permissions differ from today's by exactly those three, on purpose.

## Not in this set, on purpose
- `authenticated` holds INSERT, UPDATE, DELETE and TRUNCATE on `payment_failures`, before this migration, after it and after its rollback. Row security does not govern TRUNCATE; the independent review ran a TRUNCATE as `authenticated` on scratch and it succeeded in all three states (comment 6047683096 finding 11). The CEO named that revoke as a separate protective change (6045861846). It is left out of this pull request.
- The `process-dunning` retry pass and the page. The legacy page's "Retry Payment Now" button stays exactly as it is on `main` (its direct write matches zero rows) until that later pull request.

## Risk
- Nothing consumes `retry_requested_at` yet, and no page calls the function. Applying this set changes nothing a contractor can see, with one invisible exception: the legacy page reads the table with `select('*')`, so the two new columns travel to the owning contractor's browser. They hold nothing the contractor did not cause.
- The function makes no Stripe call and sends no message.
- anon keeps SELECT and REFERENCES on the table (no anon policy exists; SELECT returns no rows). Not writes, left alone.
- The 15-minute window is measured from the stored `retry_requested_at`. When the retry pass later "consumes" a request it must not null the column, or the window resets; it needs its own consumed marker.
- `ADD COLUMN ... NOT NULL DEFAULT 0` and `ADD CONSTRAINT ... CHECK` each take a brief ACCESS EXCLUSIVE lock on `payment_failures`. The table has 0 rows (SELECT, 2026-10-07); a constant default does not rewrite the table and the CHECK validates 0 rows.

## Proof
**Where it ran.** A scratch PostgreSQL 16.2 built from `supabase/tests/gh2442_replica_fixture.sql`, which copies the live `payment_failures` definition, its 3 policies and its anon/authenticated grants as read from production (project yeszghaspzwwstvsrioa, PostgreSQL 17.6) by read-only SELECT on 2026-10-07. It did NOT run on production: this revision's author had no grant to run DDL there, even rolled back. A production run (one batch ending in a deliberate RAISE, so nothing persists) is the applier's step inside the apply window.

What the scratch database cannot show: anything that depends on production objects the fixture leaves out (other tables' triggers, extensions, the real `auth` schema) or on the difference between PostgreSQL 16 and 17. The function reads only `payment_failures`, `contractors.id`, `contractors.user_id` and `auth.uid()`.

**Negative control 1, migration absent** (proof file run alone):
```
[BEFORE] FIXTURES k1=a3e7743f k2login=75d4518e homeowner=aab94420
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
ROWS payment_failures before-run=0 inside-batch-end=2 (fixtures; the batch rolls back)
```
**Forward, then rollback** (one batch; 8-character id prefixes of scratch rows only). S3 to S5 are fixture rows in the shapes the code really writes; U1 to U6 are shapes nothing writes; K1 to K3 are the CHECK:
```
[BEFORE] FIXTURES k1=1139e409 k2login=13ed5e7f homeowner=764107aa
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
[AFTER] FIXTURES k1=1139e409 k2login=13ed5e7f homeowner=764107aa
[AFTER] F0 function present=t secdef=t config={"search_path=public, pg_temp"} anon_exec=f authenticated_exec=t
[AFTER] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[AFTER] O1 owner, active row: {"reason": null, "status": "requested", "dunning_status": "active", "requests_remaining": 2, "retry_requested_at": "2026-10-07T22:45:04.863273+00:00"} | other columns unchanged=t | retry_requested_at set=t | count=1
[AFTER] O2 owner again inside 15 min: {"reason": null, "status": "already_requested", "dunning_status": "active", "requests_remaining": 2, "retry_requested_at": "2026-10-07T22:45:04.863273+00:00"} | retry_requested_at unchanged=t | other columns unchanged=t | count=1
[AFTER] O3 owner, request 16 min old: {"reason": null, "status": "requested", "dunning_status": "active", "requests_remaining": 1, "retry_requested_at": "2026-10-07T22:45:04.863273+00:00"} | retry_requested_at moved forward=t | count=2
[AFTER] O4 owner, warning_sent row: {"reason": null, "status": "requested", "dunning_status": "warning_sent", "requests_remaining": 2, "retry_requested_at": "2026-10-07T22:45:04.863273+00:00"}
[AFTER] C1 owner, 3rd request: {"reason": null, "status": "requested", "dunning_status": "active", "requests_remaining": 0, "retry_requested_at": "2026-10-07T22:45:04.863273+00:00"} | count=3
[AFTER] C2 owner, same instant: {"reason": null, "status": "already_requested", "dunning_status": "active", "requests_remaining": 0, "retry_requested_at": "2026-10-07T22:45:04.863273+00:00"} | count=3
[AFTER] C3 owner, 16 min after the 3rd: {"reason": "limit_reached", "status": "not_retryable", "dunning_status": "active", "requests_remaining": 0, "retry_requested_at": "2026-10-07T22:29:04.863273+00:00"} | count=3 | retry_requested_at unchanged=t
[AFTER] C4 owner, 10 more tries each 16 min apart (L = limit_reached): LLLLLLLLLL | count=3
[AFTER] S3 homeowner_notified, resolved_at NULL (process-dunning:1298/:1341): not_retryable / homeowner_notified | nothing written=t
[AFTER] S4 resolved + resolved_at (process-dunning:612 homeowner Move Forward): not_retryable / homeowner_proceeded | nothing written=t
[AFTER] S5 contractor_out + resolved_at (process-dunning:662 different contractor): not_retryable / contractor_out | nothing written=t
[AFTER] U1 escalated, resolved_at NULL (no writer): not_retryable / other_closed | nothing written=t
[AFTER] U2 expired, resolved_at NULL (no writer): not_retryable / other_closed | nothing written=t
[AFTER] U3 NULL status, resolved_at NULL (no writer): not_retryable / other_closed | nothing written=t
[AFTER] U4 active + resolved_at (no writer): not_retryable / other_closed | nothing written=t
[AFTER] U5 warning_sent + resolved_at (no writer): not_retryable / other_closed | nothing written=t
[AFTER] U6 contractor_out, resolved_at NULL (no writer): not_retryable / contractor_out | nothing written=t
[AFTER] K1 superuser sets retry_request_count=4: REJECTED 23514 new row for relation "payment_failures" violates check constraint "payment_failures_retry_request_co
[AFTER] K2 superuser sets retry_request_count=-1: REJECTED 23514 new row for relation "payment_failures" violates check constraint "payment_failures_retry_request_co
[AFTER] K3 superuser sets retry_request_count=3: rows=1
[AFTER] X1 another contractor: REJECTED 42501 payment failure not found
[AFTER] X2 homeowner: REJECTED 42501 payment failure not found
[AFTER] X3 anon: REJECTED 42501 permission denied for function request_dunning_retry
[AFTER] X4 authenticated, no login claim: REJECTED 42501 payment failure not found
[AFTER] X5 owner, unknown id: REJECTED 42501 payment failure not found
[AFTER] X6 owner, NULL id: REJECTED 42501 payment failure not found
[AFTER] X-none: after X1-X6 the active row still has retry_requested_at null=t, count=0 and other columns unchanged=t
[AFTER] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[AFTER] D1b owner, direct table UPDATE of retry_requested_at and retry_request_count: rows=0 | still null=t | count=0
[AFTER] D2 anon, direct table UPDATE: REJECTED 42501 permission denied for table payment_failures | row unchanged=t
[ROLLED-BACK] FIXTURES k1=1139e409 k2login=13ed5e7f homeowner=764107aa
[ROLLED-BACK] F0 function present=f
[ROLLED-BACK] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[ROLLED-BACK] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[ROLLED-BACK] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[ROLLED-BACK] D2 anon, direct table UPDATE: REJECTED 42501 permission denied for table payment_failures | row unchanged=t
[ROLLED-BACK] R0 function count=0 | retry columns left=0 | anon UPDATE=f TRUNCATE=f TRIGGER=f
ROWS payment_failures before-run=0 inside-batch-end=15 (fixtures; the batch rolls back)
```
Scratch database after the batch: `rows=0 fn=0 cols=15 anon_update=true`.

**Negative control 2, the previous head's forward file (ad4b00c) under the same proof.** It mislabels both rows the code writes (S4 and S5 both read `resolved`), and it has no CHECK (K1 and K2 succeed):
```
[AFTER] S3 homeowner_notified, resolved_at NULL (process-dunning:1298/:1341): not_retryable / closed | nothing written=t
[AFTER] S4 resolved + resolved_at (process-dunning:612 homeowner Move Forward): not_retryable / resolved | nothing written=t
[AFTER] S5 contractor_out + resolved_at (process-dunning:662 different contractor): not_retryable / resolved | nothing written=t
[AFTER] U1 escalated, resolved_at NULL (no writer): not_retryable / closed | nothing written=t
[AFTER] U2 expired, resolved_at NULL (no writer): not_retryable / closed | nothing written=t
[AFTER] U3 NULL status, resolved_at NULL (no writer): not_retryable / closed | nothing written=t
[AFTER] U4 active + resolved_at (no writer): not_retryable / resolved | nothing written=t
[AFTER] U5 warning_sent + resolved_at (no writer): not_retryable / resolved | nothing written=t
[AFTER] U6 contractor_out, resolved_at NULL (no writer): not_retryable / closed | nothing written=t
[AFTER] K1 superuser sets retry_request_count=4: rows=1
[AFTER] K2 superuser sets retry_request_count=-1: rows=1
[AFTER] K3 superuser sets retry_request_count=3: rows=1
```
**Concurrency** (`python3 supabase/tests/gh2442_concurrency_harness.py`, same scratch server, committed transactions on separate connections). The two NEG lines are the negative controls: the function with its row lock removed, first with the CHECK in place, then with the CHECK removed as well:
```
PG PostgreSQL 16.2 
[CONC-1] start count=2, A holds its transaction open; B waiting on a lock=1; A=requested B=already_requested; final count=3
[NEG no row lock, CHECK present] start count=2, A holds its transaction open; B waiting on a lock=1; A=requested B=REJECTED 23514; final count=3
[NEG no row lock, CHECK removed] start count=2, A holds its transaction open; B waiting on a lock=1; A=requested B=requested; final count=4
[CONC-2] round 1 (24 simultaneous) {'already_requested': 23, 'requested': 1} count=1
[CONC-2] round 2 (24 simultaneous) {'already_requested': 23, 'requested': 1} count=2
[CONC-2] round 3 (24 simultaneous) {'already_requested': 23, 'requested': 1} count=3
[CONC-2] round 4 (24 simultaneous) {'not_retryable': 24} count=3
[CONC-2] round 5 (24 simultaneous) {'not_retryable': 24} count=3
[CONC-2] round 6 (24 simultaneous) {'not_retryable': 24} count=3
[CONC-3] REPEATABLE READ caller with a stale snapshot: REJECTED 40001; final count=3
```
**Negative control 3, a rollback that re-granted anon** (the rollback at commit 00f5442, shown in this file's history at ad4b00c): it left `anon UPDATE=t TRUNCATE=t TRIGGER=t`. The current rollback's R0 line above reads `f f f`.

## Still owed before anything is applied
1. A fresh REVIEW and LEGAL-READ at this pull request's new head, then Ben's R-177 signature, and the R-097 24-hour window posted on #2442 for this head.
2. At apply time: the proof run on production in its rolled-back form, the set filed under `supabase/migrations/` with the label `permissions-ratchet: reviewed`, and a recorded apply.
3. Not part of this set, and not started: the `process-dunning` retry pass and the page. They wait on the CEO's customer-facing sentence about the card fee (PR #2579 comment 6029194857, item 2) and on what the page may say for each `reason`.
