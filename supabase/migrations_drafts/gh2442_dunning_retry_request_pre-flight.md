<!-- STATUS (gh-1438, as of 2026-10-07T19:12Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: function and both columns absent, anon UPDATE/TRUNCATE/TRIGGER present, payment_failures 0 rows on production, read-only SELECT 2026-10-07 (gh-2442 SQL-only revision); see Proof below -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2442_dunning_retry_request (Tier 3B, NOT APPLIED)

Issue #2442, ruling comment 6025103626 (option A), split order PR #2579 comment 6029194857 (SQL only). Forward: `gh2442_dunning_retry_request.sql`. Rollback: `gh2442_dunning_retry_request_rollback.sql`. Proof: `supabase/tests/gh2442_dunning_retry_request_proof.sql`, scratch-database fixture `supabase/tests/gh2442_replica_fixture.sql`.

This set is SQL only. No page calls the function and no job reads the columns. The page change and the `process-dunning` retry pass are a separate, later pull request.

## What changes
1. `payment_failures.retry_requested_at timestamptz` (nullable, no default). Existing rows read NULL.
2. `payment_failures.retry_request_count integer NOT NULL DEFAULT 0`. Existing rows read 0.
3. `request_dunning_retry(p_failure_id uuid) returns jsonb`. SECURITY DEFINER, `search_path = public, pg_temp`, no dynamic SQL. It writes those two columns and nothing else.
4. EXECUTE on that function: revoked from PUBLIC and anon, granted to `authenticated`.
5. `REVOKE UPDATE, TRUNCATE, TRIGGER ON payment_failures FROM anon`.

## Grant ratchet
Item 4 is a new GRANT to `authenticated`. When this file is filed under `supabase/migrations/` at apply time, the `No new GRANT to anon/PUBLIC/authenticated` check (`scripts/permissions-ratchet.py`, scope `supabase/migrations/**`, so it does not read this directory) will flag it. The PR that files it needs the label `permissions-ratchet: reviewed`. This PR adds nothing under `supabase/migrations/`, so it does not need the label today. REVOKE lines always pass.

## Who can call it, and what they get
Every answer carries `status`, `reason`, `retry_requested_at` and `requests_remaining`.

| caller | result |
|---|---|
| the contractor that owns the failure (`contractors.user_id = auth.uid()`), failure `active` or `warning_sent`, not resolved, fewer than 3 requests recorded | `requested`; sets `retry_requested_at = now()`, adds 1 to `retry_request_count` |
| same, second call within 15 minutes | `already_requested`; writes nothing; returns the stored time |
| same, 3 requests already recorded and the last one more than 15 minutes old | `not_retryable`, reason `limit_reached`; writes nothing |
| same, failure already settled (`resolved_at` set, or `dunning_status = resolved`) | `not_retryable`, reason `resolved`; writes nothing |
| same, failure in any other state (`homeowner_notified`, `contractor_out`, `escalated`, `expired`) | `not_retryable`, reason `closed`; writes nothing |
| another contractor, a homeowner, an unknown or NULL id, a login-less caller | error 42501 "payment failure not found" (same text for all, so ids cannot be probed) |
| anon | error 42501 permission denied for function |

Concurrency: the ownership read takes `FOR UPDATE` on the failure row, so two simultaneous clicks serialise and the second sees the first's request and count.

## The cap (split order item 4)
A failure can carry at most 3 recorded requests for its whole life. Before this revision the only limit was the 15-minute window, which let one failure be re-requested 96 times a day (24 hours / 15 minutes), each of which a later retry pass could have turned into a charge attempt. The cap is enforced inside the function, under the row lock, so no page and no later job can raise it; changing it means changing the constant `c_max_requests` in a reviewed migration. The function never resets the count. The number 3 is the author's choice and is open to the CEO: see the question on PR #2579.

The retry pass, when it is written, still needs its own limits (attempts per scheduled run, maximum request age, one charge attempt per recorded request). This cap bounds the requests; it does not replace those.

## The "not retryable" wording (split order item 3)
The page text that told every `not_retryable` contractor "Please update your card" is no longer in this pull request (the whole page change left it). What stays here is the fact a page needs so it cannot repeat that mistake: `reason`. A contractor whose failure is already settled gets `reason = resolved`, and a page must not answer that with a request to update a card. The LEGAL-READ on the earlier head (comment 6029017466, finding 3) suggested "This payment can no longer be retried from here." with the Update Card button left as it is. The final sentence belongs to the later page pull request and its own LEGAL-READ; no customer-visible text is added by this set.

## Rollback (split order item 3)
The rollback drops the function and both columns. It does NOT give the logged-out role (anon) back the three write permissions the forward file removed. After a rollback the table's permissions differ from today's by exactly those three, on purpose.

## Risk and what this migration does NOT do
- Nothing consumes `retry_requested_at` yet, and no page calls the function. Applying this set changes nothing a contractor can see. The legacy page's button stays exactly as broken as it is on `main` today (its direct write matches zero rows) until the later pull request.
- The function makes no Stripe call and sends no message.
- anon keeps SELECT and REFERENCES on the table (no anon policy exists; SELECT returns no rows). Not writes, left alone.
- `authenticated` still holds UPDATE, INSERT, DELETE and TRUNCATE on `payment_failures` (RLS is the only gate: a contractor has no UPDATE policy; insert/delete policies: none exist per `pg_policies`, 3 policies read on 2026-10-07). Out of this ruling's scope; worth its own check.
- The 15-minute window is measured from the stored `retry_requested_at`. When the retry pass later "consumes" a request it must not null the column, or the window resets; it needs its own consumed marker.
- `ADD COLUMN ... NOT NULL DEFAULT 0` takes a brief ACCESS EXCLUSIVE lock on `payment_failures`. The table has 0 rows (SELECT, 2026-10-07) and a constant default does not rewrite the table.

## Proof
**Where it ran.** A scratch PostgreSQL 16.2 built from `supabase/tests/gh2442_replica_fixture.sql`, which copies the live `payment_failures` definition, its 3 policies and its anon/authenticated grants as read from production (project yeszghaspzwwstvsrioa, PostgreSQL 17.6) by read-only SELECT on 2026-10-07. It did NOT run on production: this revision's author had no grant to run DDL there, even rolled back. The 2026-10-06 version of the proof did run on production in the rolled-back way; its output is in this file's history at commit 00f5442. A production run of this version (one batch ending in a deliberate RAISE, so nothing persists) is the applier's step inside the apply window.

What the scratch database cannot show: anything that depends on production objects the fixture leaves out (other tables' triggers, extensions, the real `auth` schema). The function reads only `payment_failures`, `contractors.id`, `contractors.user_id` and `auth.uid()`.

**Negative control 1, migration absent** (proof file run alone):
```
[BEFORE] FIXTURES k1=14891093 k2login=353e6b94 homeowner=d0da3de1
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
ROWS payment_failures before-run=0 inside-batch-end=5 (fixtures; the batch rolls back)
```
**Forward, then rollback** (one batch; 8-character id prefixes of scratch rows only):
```
[BEFORE] FIXTURES k1=8cf62176 k2login=260d2a5d homeowner=a9a4971b
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
[AFTER] FIXTURES k1=8cf62176 k2login=260d2a5d homeowner=a9a4971b
[AFTER] F0 function present=t secdef=t config={"search_path=public, pg_temp"} anon_exec=f authenticated_exec=t
[AFTER] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[AFTER] O1 owner, active row: {"reason": null, "status": "requested", "requests_remaining": 2, "retry_requested_at": "2026-10-07T19:33:18.672539+00:00"} | other columns unchanged=t | retry_requested_at set=t | count=1
[AFTER] O2 owner again inside 15 min: {"reason": null, "status": "already_requested", "requests_remaining": 2, "retry_requested_at": "2026-10-07T19:33:18.672539+00:00"} | retry_requested_at unchanged=t | other columns unchanged=t | count=1
[AFTER] O3 owner, request 16 min old: {"reason": null, "status": "requested", "requests_remaining": 1, "retry_requested_at": "2026-10-07T19:33:18.672539+00:00"} | retry_requested_at moved forward=t | count=2
[AFTER] O4 owner, warning_sent row: {"reason": null, "status": "requested", "requests_remaining": 2, "retry_requested_at": "2026-10-07T19:33:18.672539+00:00"}
[AFTER] C1 owner, 3rd request: {"reason": null, "status": "requested", "requests_remaining": 0, "retry_requested_at": "2026-10-07T19:33:18.672539+00:00"} | count=3
[AFTER] C2 owner, same instant: {"reason": null, "status": "already_requested", "requests_remaining": 0, "retry_requested_at": "2026-10-07T19:33:18.672539+00:00"} | count=3
[AFTER] C3 owner, 16 min after the 3rd: {"reason": "limit_reached", "status": "not_retryable", "requests_remaining": 0, "retry_requested_at": "2026-10-07T19:17:18.672539+00:00"} | count=3 | retry_requested_at unchanged=t
[AFTER] C4 owner, 10 more tries each 16 min apart (L = limit_reached): LLLLLLLLLL | count=3
[AFTER] N1 owner, resolved row: {"reason": "resolved", "status": "not_retryable", "requests_remaining": 0, "retry_requested_at": null} | retry_requested_at still null=t
[AFTER] N2 owner, contractor_out row: {"reason": "closed", "status": "not_retryable", "requests_remaining": 0, "retry_requested_at": null} | retry_requested_at still null=t
[AFTER] N1b owner, resolved_at set but status still active: {"reason": "resolved", "status": "not_retryable", "requests_remaining": 0, "retry_requested_at": null} | retry_requested_at still null=t
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
[ROLLED-BACK] FIXTURES k1=8cf62176 k2login=260d2a5d homeowner=a9a4971b
[ROLLED-BACK] F0 function present=f
[ROLLED-BACK] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[ROLLED-BACK] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist
[ROLLED-BACK] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[ROLLED-BACK] D2 anon, direct table UPDATE: REJECTED 42501 permission denied for table payment_failures | row unchanged=t
[ROLLED-BACK] R0 function count=0 | retry columns left=0 | anon UPDATE=f TRUNCATE=f TRIGGER=f
ROWS payment_failures before-run=0 inside-batch-end=15 (fixtures; the batch rolls back)
```
Scratch database after the batch: `rows=0 fn=0 cols=15 anon_update=true`.

**Negative control 2, the rollback this revision replaces** (same forward file, the rollback from commit 00f5442): 
```
[ROLLED-BACK] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t (unchanged by this change)
[ROLLED-BACK] R0 function count=0 | retry columns left=1 | anon UPDATE=t TRUNCATE=t TRIGGER=t
```
That rollback handed anon its three write permissions back, and left one of this revision's two columns behind; the new one leaves `anon UPDATE=f TRUNCATE=f TRIGGER=f` and no column.

## Still owed before anything is applied
1. A fresh REVIEW and LEGAL-READ at this pull request's new head, then Ben's R-177 signature, and the R-097 24-hour window posted on #2442 for this head.
2. At apply time: the proof run on production in its rolled-back form, the set filed under `supabase/migrations/` with the label `permissions-ratchet: reviewed`, and a recorded apply.
3. Not part of this set, and not started: the `process-dunning` retry pass and the page change. They wait on the CEO's customer-facing sentence about the card fee (PR #2579 comment 6029194857, item 2).
