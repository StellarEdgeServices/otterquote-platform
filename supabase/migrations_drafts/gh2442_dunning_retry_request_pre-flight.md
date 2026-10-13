<!-- STATUS (gh-1438, as of 2026-10-07T23:53Z): NOT APPLIED -->
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
3. `request_dunning_retry(p_failure_id uuid) returns jsonb`. SECURITY DEFINER, `search_path = public, pg_temp`, no dynamic SQL. It writes those two columns and nothing else, and only on the row it was called with.
4. EXECUTE on that function: revoked from PUBLIC and anon, granted to `authenticated`.
5. `REVOKE UPDATE, TRUNCATE, TRIGGER ON payment_failures FROM anon`.

## Grant ratchet
Item 4 is a new GRANT to `authenticated`. When this file is filed under `supabase/migrations/` at apply time, the `No new GRANT to anon/PUBLIC/authenticated` check (`scripts/permissions-ratchet.py`, scope `supabase/migrations/**`, so it does not read this directory and has not measured this grant) will flag it. The PR that files it needs the label `permissions-ratchet: reviewed`. REVOKE lines always pass.

## "A failed payment" is the quote, not the row (REVIEW 6049015214, finding 1)
On `main` 7bc8a3cb one failed charge writes two `payment_failures` rows for the same quote:
- **the webhook row**: `stripe-webhook/index.ts:1037` or `docusign-webhook/index.ts:1633` inserts quote, contractor, claim, amount and error only. `dunning_status` takes its default `active`; `next_reminder_at`, `warning_at` and `homeowner_notify_at` stay NULL. No code ever updates this row, so it stays `active` for ever.
- **the scheduled row**: the webhook then calls `process-dunning`, which inserts a second row at `index.ts:1083` with the schedule filled in. Only this row moves through the states.

When `process-dunning` charges an alternate saved method successfully it returns before `:1083` (`index.ts:958`, "Dunning not initiated"). The webhook row is then the only row, still `active`, for a fee that was collected.

That double insert is a defect on `main`. **It is not fixed in this set; it gets its own issue.** The function is written to be correct with or without it: every test is made over the group of the caller's rows that share the called row's `quote_id` and `contractor_id` (a row with no `quote_id` is a group of one). One row per quote, two, or more all answer the same way, whichever row a page sends.

- **One cutoff.** If any row of the group has left the open states, every row of the group refuses.
- **One count.** The cap is tested against the sum of `retry_request_count` over the group.
- **One window.** The 15 minutes run from the latest `retry_requested_at` in the group.
- **A dunning sequence must exist.** At least one row of the group must carry a schedule (`homeowner_notify_at` not NULL). A webhook row on its own refuses with reason `no_dunning_schedule`. That covers the alternate-method case and the seconds before `process-dunning` has inserted its row.

## Every state the code can leave a row in
Enumerated from `supabase/functions` at `main` 7bc8a3cb (2026-10-07) by reading every insert and update on `payment_failures`: 3 inserts, and 7 updates, all in `process-dunning/index.ts`.

| | `dunning_status` | `resolved_at` | schedule | written by |
|---|---|---|---|---|
| W | `active` | NULL | NULL | the webhook row: `stripe-webhook/index.ts:1037`, `docusign-webhook/index.ts:1633`; never updated |
| S1 | `active` | NULL | set | `process-dunning/index.ts:1083` (the scheduled row) |
| S2 | `warning_sent` | NULL | set | `process-dunning/index.ts:1225-1227` |
| S3 | `homeowner_notified` | NULL | set | `process-dunning/index.ts:1298`, `:1341` |
| S4 | `resolved` | set | set | `process-dunning/index.ts:612` only (homeowner clicked "Move Forward") |
| S5 | `contractor_out` | set | set | `process-dunning/index.ts:662` only (homeowner chose a different contractor) |

The CHECK on `dunning_status` also allows `escalated` and `expired`; no code under `supabase/functions` writes either. Those, a NULL status, and any shape not in the table (for example `active` with `resolved_at` set) count as closed, reason `other_closed`.

The groups that can therefore exist for one quote, and the answer, which is the same for every row of the group:

| group | answer to the owner |
|---|---|
| W alone | `not_retryable` / `no_dunning_schedule` |
| W + S1, or S1 alone | accepted |
| W + S2, or S2 alone | accepted |
| W + S3, or S3 alone | `not_retryable` / `homeowner_notified` |
| W + S4, or S4 alone | `not_retryable` / `homeowner_proceeded` |
| W + S5, or S5 alone | `not_retryable` / `contractor_out` |

When more than one row of a group is closed the reason is taken in this order: `contractor_out`, `homeowner_proceeded`, `homeowner_notified`, `other_closed`. `dunning_status` is tested before `resolved_at`, because S4 and S5 both carry `resolved_at`.

"Accepted" means: `requested` (sets `retry_requested_at = now()` and adds 1 to the count, on the called row); or `already_requested` if the quote's latest request is less than 15 minutes old (writes nothing); or `not_retryable` / `limit_reached` if 3 requests are already recorded for the quote and the last is more than 15 minutes old (writes nothing).

Everyone else: another contractor, a homeowner, an unknown or NULL id, a login-less caller get error 42501 "payment failure not found" (same text for all, so ids cannot be probed); anon gets 42501 permission denied for function.

Every answer carries `status`, `reason`, `dunning_status` (the stored status of the row that decided the answer, which the owner can already read through the policy `contractor_select_own_payment_failures`), `retry_requested_at` (the quote's latest request) and `requests_remaining` (for the quote).

## What `reason` means, and what it does not
`reason` repeats what the rows say. It never says whether money is owed. `resolved` is written only at `:612`, the branch where the homeowner goes ahead while the platform fee is still unpaid, and no code marks a failure resolved because a payment succeeded. `no_dunning_schedule` says only that no row of the quote carries a schedule. What a page may say to a contractor for each reason is not decided in this set: it belongs to the page pull request and its own LEGAL-READ. No customer-visible text is added by this set.

## When a request is accepted (D-379: only until the homeowner notice goes out)
Only while every row of the quote's group is `active` or `warning_sent` with `resolved_at` NULL, and one of them carries a schedule. The homeowner notice is the moment `process-dunning` sets `homeowner_notified` on the scheduled row; from then on every row of that quote refuses. One edge, stated so nobody is surprised: the scheduled job runs every 30 minutes, so between the time a notice falls due (`homeowner_notify_at`) and the job's next run the row is still `warning_sent` and a request is still accepted. The request only records a time and a count. Cutting off at the due time instead is one more condition in the same place; it is not made here because no ruling asks for it.

## Where the per-quote count lives, and why
It is the sum of `retry_request_count` over the rows of the group, read after the function has locked every row of the group (`FOR UPDATE`, in id order). The called row is not locked first: it is read plainly for ownership and for its quote, and locked only as part of the ordered group, so two callers on two rows of one quote take their locks in the same order and cannot deadlock.

Why a sum over locked rows and not a separate per-quote table:
- the rows are the only place the dunning state lives, so they must be read and locked for the cutoff anyway;
- a second table would be a second money-path object with its own grants, row security and rollback, and a second place for the count to disagree with the rows;
- two callers on different rows of one quote always meet on a lock, because both groups contain every committed row of that quote, including the oldest.

What it costs: the count for a quote is not one stored number; a reader must sum. The retry pass must read a request per quote (latest `retry_requested_at`, summed count), never per row.

## The cap (D-379: up to 3 per failed payment)
Held in two places, which guarantee different things:
- **The function**: `c_max_requests = 3`, tested against the group sum under the locks. This is the per-quote cap.
- **The table**: `CHECK (retry_request_count BETWEEN 0 AND 3)`. This is a per-row bound. It guarantees that no writer of any role, including a service-role job, can store a count outside 0 to 3 on any one row. It does **not** by itself guarantee 3 per quote: a service-role writer could set two rows of one quote to 3 each. Through this function that cannot happen, because the sum is tested before every write.

What neither does:
- A service-role job can still set counts back to 0, or write `retry_requested_at` itself.
- The cap counts requests, not charge attempts. A retry pass that inserted a further `payment_failures` row for the same quote on each decline (as `:1083` does today) would not earn a fresh allowance here, because the count is per quote; but the retry pass must still keep its own limit on charge attempts per quote and must skip hard declines (LEGAL-READ 6045706206 finding 3; CEO comment 6045861846).
- A `retry_requested_at` in the future would read `already_requested` until that time passes. No contractor can write the column; noted for whoever writes the retry pass.

## Rollback
Drops the function and both columns (the CHECK goes with its column). It does NOT give the logged-out role (anon) back the three write permissions the forward file removed. After a rollback the table's permissions differ from today's by exactly those three, on purpose.

## Not in this set, on purpose
- `authenticated` holds INSERT, UPDATE, DELETE and TRUNCATE on `payment_failures`, before this migration, after it and after its rollback. Row security does not govern TRUNCATE; the independent review ran a TRUNCATE as `authenticated` on scratch and it succeeded in all three states (comment 6047683096 finding 11). The CEO named that revoke as a separate protective change (6045861846). It is left out of this pull request.
- The `process-dunning` retry pass and the page. The legacy page's "Retry Payment Now" button stays exactly as it is on `main` (its direct write matches zero rows) until that later pull request.
- The double insert on `main` (two `payment_failures` rows per failed charge). It is a defect in the webhooks and `process-dunning`, wants its own issue, and is not touched here. Production holds 0 `payment_failures` rows (SELECT, 2026-10-07), so nothing needs cleaning up yet.

## Risk
- Nothing consumes `retry_requested_at` yet, and no page calls the function. Applying this set changes nothing a contractor can see, with one invisible exception: the legacy page reads the table with `select('*')`, so the two new columns travel to the owning contractor's browser. They hold nothing the contractor did not cause.
- The function makes no Stripe call and sends no message.
- anon keeps SELECT and REFERENCES on the table (no anon policy exists; SELECT returns no rows). Not writes, left alone.
- The 15-minute window is measured from the stored `retry_requested_at`. When the retry pass later "consumes" a request it must not null the column, or the window resets; it needs its own consumed marker.
- `ADD COLUMN ... NOT NULL DEFAULT 0` and `ADD CONSTRAINT ... CHECK` each take a brief ACCESS EXCLUSIVE lock on `payment_failures`. The table has 0 rows (SELECT, 2026-10-07); a constant default does not rewrite the table and the CHECK validates 0 rows.

## Proof
**Where it ran.** A scratch PostgreSQL 16.2 built from `supabase/tests/gh2442_replica_fixture.sql`, which copies the live `payment_failures` definition, its 3 policies and its anon/authenticated grants as read from production (project yeszghaspzwwstvsrioa, PostgreSQL 17.6) by read-only SELECT on 2026-10-07. It did NOT run on production: this revision's author had no grant to run DDL there, even rolled back. A production run (one batch ending in a deliberate RAISE, so nothing persists) is the applier's step inside the apply window.

What the scratch database cannot show: anything that depends on production objects the fixture leaves out (other tables' triggers, extensions, the real `auth` schema, the table's 6 indexes) or on the difference between PostgreSQL 16 and 17. The function reads only `payment_failures`, `contractors.id`, `contractors.user_id` and `auth.uid()`; the group read can use the existing index `idx_payment_failures_quote_id`. On production the proof needs a test contractor that has a quote for the T lines; 1 test contractor with a login has 2 or more quotes there today (SELECT, 2026-10-07), and the proof prefers such a contractor.

**Negative control 1, migration absent** (proof file run alone):
```
[BEFORE] FIXTURES k1=a2482d56 k2login=213d35ba homeowner=c893ad30
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
ROWS payment_failures before-run=0 inside-batch-end=2 (fixtures; the batch rolls back)
```
**Forward, then rollback** (one batch; 8-character id prefixes of scratch rows only). O and C lines are a scheduled row on its own; S3 to S5 are rows in the shapes the code really writes; U1 to U6 are shapes nothing writes; K1 to K3 are the CHECK; **T0 to T6 are two rows of one quote**, a webhook row plus a scheduled row, with the function called on the webhook row (T0 calls the two rows in turn):
```
[BEFORE] FIXTURES k1=ac52ce95 k2login=7da45dbc homeowner=f9a8a29c
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
[AFTER] FIXTURES k1=ac52ce95 k2login=7da45dbc homeowner=f9a8a29c
[AFTER] F0 function present=t secdef=t config={"search_path=public, pg_temp"} anon_exec=f authenticated_exec=t
[AFTER] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[AFTER] O1 owner, active row: {"reason": null, "status": "requested", "dunning_status": "active", "requests_remaining": 2, "retry_requested_at": "2026-10-07T23:55:24.492081+00:00"} | other columns unchanged=t | retry_requested_at set=t | count=1
[AFTER] O2 owner again inside 15 min: {"reason": null, "status": "already_requested", "dunning_status": "active", "requests_remaining": 2, "retry_requested_at": "2026-10-07T23:55:24.492081+00:00"} | retry_requested_at unchanged=t | other columns unchanged=t | count=1
[AFTER] O3 owner, request 16 min old: {"reason": null, "status": "requested", "dunning_status": "active", "requests_remaining": 1, "retry_requested_at": "2026-10-07T23:55:24.492081+00:00"} | retry_requested_at moved forward=t | count=2
[AFTER] O4 owner, warning_sent row: {"reason": null, "status": "requested", "dunning_status": "warning_sent", "requests_remaining": 2, "retry_requested_at": "2026-10-07T23:55:24.492081+00:00"}
[AFTER] C1 owner, 3rd request: {"reason": null, "status": "requested", "dunning_status": "active", "requests_remaining": 0, "retry_requested_at": "2026-10-07T23:55:24.492081+00:00"} | count=3
[AFTER] C2 owner, same instant: {"reason": null, "status": "already_requested", "dunning_status": "active", "requests_remaining": 0, "retry_requested_at": "2026-10-07T23:55:24.492081+00:00"} | count=3
[AFTER] C3 owner, 16 min after the 3rd: {"reason": "limit_reached", "status": "not_retryable", "dunning_status": "active", "requests_remaining": 0, "retry_requested_at": "2026-10-07T23:39:24.492081+00:00"} | count=3 | retry_requested_at unchanged=t
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
[AFTER] T0 W + scheduled row active (S1): W=requested, sched=already_requested, sched=requested, W=requested, sched=limit_reached, W=limit_reached | recorded for the quote=3
[AFTER] T1 W + scheduled row homeowner_notified (S3): homeowner_notified, homeowner_notified, homeowner_notified, homeowner_notified | recorded for the quote=0
[AFTER] T2 W + scheduled row resolved + resolved_at (S4, :612): homeowner_proceeded, homeowner_proceeded, homeowner_proceeded, homeowner_proceeded | recorded for the quote=0
[AFTER] T3 W + scheduled row contractor_out + resolved_at (S5, :662): contractor_out, contractor_out, contractor_out, contractor_out | recorded for the quote=0
[AFTER] T4 W alone, no scheduled row (alternate method charged, :958): no_dunning_schedule, no_dunning_schedule, no_dunning_schedule, no_dunning_schedule | recorded for the quote=0
[AFTER] T5 W + scheduled row active that already holds 3 requests: limit_reached, limit_reached, limit_reached, limit_reached | recorded for the quote=3
[AFTER] T6 W + scheduled row active; closed rows of the same contractor on no quote exist (S3-U6 above): requested, requested, requested, limit_reached | recorded for the quote=3
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
[ROLLED-BACK] FIXTURES k1=ac52ce95 k2login=7da45dbc homeowner=f9a8a29c
[ROLLED-BACK] F0 function present=f
[ROLLED-BACK] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[ROLLED-BACK] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[ROLLED-BACK] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[ROLLED-BACK] D2 anon, direct table UPDATE: REJECTED 42501 permission denied for table payment_failures | row unchanged=t
[ROLLED-BACK] R0 function count=0 | retry columns left=0 | anon UPDATE=f TRUNCATE=f TRIGGER=f
ROWS payment_failures before-run=0 inside-batch-end=15 (fixtures; the batch rolls back)
```
Scratch database after the batch: `rows=0 fn=0 cols=15 anon_update=true`.

**Negative control 2, the previous head's forward file (0e0d255, per-row logic) under the same proof.** Every T line is wrong: the webhook row accepts 3 requests after the homeowner notice (T1), after the homeowner went ahead (T2), after the contractor was removed (T3) and with no dunning at all (T4), and a quote ends with 6 recorded (T0, T5):
```
[AFTER] T0 W + scheduled row active (S1): W=requested, sched=requested, sched=requested, W=requested, sched=requested, W=requested | recorded for the quote=6
[AFTER] T1 W + scheduled row homeowner_notified (S3): requested, requested, requested, limit_reached | recorded for the quote=3
[AFTER] T2 W + scheduled row resolved + resolved_at (S4, :612): requested, requested, requested, limit_reached | recorded for the quote=3
[AFTER] T3 W + scheduled row contractor_out + resolved_at (S5, :662): requested, requested, requested, limit_reached | recorded for the quote=3
[AFTER] T4 W alone, no scheduled row (alternate method charged, :958): requested, requested, requested, limit_reached | recorded for the quote=3
[AFTER] T5 W + scheduled row active that already holds 3 requests: requested, requested, requested, limit_reached | recorded for the quote=6
[AFTER] T6 W + scheduled row active; closed rows of the same contractor on no quote exist (S3-U6 above): requested, requested, requested, limit_reached | recorded for the quote=3
```
**Concurrency** (`python3 supabase/tests/gh2442_concurrency_harness.py`, same scratch server, committed transactions on separate connections). CONC-1 to CONC-3 are one row; **CONC-4 and CONC-5 are two rows of one quote**. The NEG lines are negative controls with the row locks removed:
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
[CONC-4] quote holds 2 (1 on each row); A on the webhook row holds its transaction open; B on the scheduled row waiting on a lock=1; A=requested B=already_requested; quote total=3
[NEG two rows, no row locks, CHECK present] quote holds 2 (1 on each row); A on the webhook row holds its transaction open; B on the scheduled row waiting on a lock=0; A=requested B=requested; quote total=4
[CONC-5] round 1 (24 simultaneous, 12 on each row of one quote) {'already_requested': 23, 'requested': 1} quote total=1
[CONC-5] round 2 (24 simultaneous, 12 on each row of one quote) {'already_requested': 23, 'requested': 1} quote total=2
[CONC-5] round 3 (24 simultaneous, 12 on each row of one quote) {'already_requested': 23, 'requested': 1} quote total=3
[CONC-5] round 4 (24 simultaneous, 12 on each row of one quote) {'not_retryable': 24} quote total=3
[CONC-5] round 5 (24 simultaneous, 12 on each row of one quote) {'not_retryable': 24} quote total=3
[CONC-5] round 6 (24 simultaneous, 12 on each row of one quote) {'not_retryable': 24} quote total=3
```
**Negative control 3, the same harness loaded with the previous head's forward file (0e0d255).** On two rows of one quote the second caller does not wait and the quote reaches 4 (CONC-4) and then 6 (CONC-5):
```
NEGATIVE CONTROL: forward file is prev2/gh2442_dunning_retry_request.sql
[CONC-4] quote holds 2 (1 on each row); A on the webhook row holds its transaction open; B on the scheduled row waiting on a lock=0; A=requested B=requested; quote total=4
[CONC-5] round 1 (24 simultaneous, 12 on each row of one quote) {'already_requested': 22, 'requested': 2} quote total=2
[CONC-5] round 2 (24 simultaneous, 12 on each row of one quote) {'already_requested': 22, 'requested': 2} quote total=4
[CONC-5] round 3 (24 simultaneous, 12 on each row of one quote) {'already_requested': 22, 'requested': 2} quote total=6
[CONC-5] round 4 (24 simultaneous, 12 on each row of one quote) {'not_retryable': 24} quote total=6
[CONC-5] round 5 (24 simultaneous, 12 on each row of one quote) {'not_retryable': 24} quote total=6
[CONC-5] round 6 (24 simultaneous, 12 on each row of one quote) {'not_retryable': 24} quote total=6
```
**Earlier negative controls, still true and kept in this file's history:** the forward file at ad4b00c labelled both written closed shapes `resolved` and had no CHECK (pre-flight at 0e0d255); the rollback at 00f5442 re-granted anon and left `anon UPDATE=t TRUNCATE=t TRIGGER=t` (pre-flight at ad4b00c). The current rollback's R0 line above reads `f f f`.

## Still owed before anything is applied
1. A fresh REVIEW and LEGAL-READ at this pull request's new head, then Ben's R-177 signature, and the R-097 24-hour window posted on #2442 for this head.
2. At apply time: the proof run on production in its rolled-back form, the set filed under `supabase/migrations/` with the label `permissions-ratchet: reviewed`, and a recorded apply.
3. Not part of this set, and not started: the `process-dunning` retry pass and the page. They wait on the CEO's customer-facing sentence about the card fee (PR #2579 comment 6029194857, item 2) and on what the page may say for each `reason`.
