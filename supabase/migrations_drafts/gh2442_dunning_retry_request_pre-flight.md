<!-- STATUS (gh-1438, as of 2026-10-06T21:00Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2442_dunning_retry_request (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: function and column absent, anon UPDATE/TRUNCATE/TRIGGER present on production, read-only SELECT 2026-10-06 (gh-2442 build); see Proof below -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2442_dunning_retry_request (Tier 3B, NOT APPLIED)

Issue #2442, ruling comment 6025103626 (option A). Forward: `gh2442_dunning_retry_request.sql`. Rollback: `gh2442_dunning_retry_request_rollback.sql`. Proof: `supabase/tests/gh2442_dunning_retry_request_proof.sql`.

## What changes
1. `payment_failures.retry_requested_at timestamptz` (nullable, no default). Existing rows read NULL.
2. `request_dunning_retry(p_failure_id uuid) returns jsonb`. SECURITY DEFINER, `search_path = public, pg_temp`, no dynamic SQL. It writes one column, `retry_requested_at`, and nothing else.
3. EXECUTE on that function: revoked from PUBLIC and anon, granted to `authenticated`.
4. `REVOKE UPDATE, TRUNCATE, TRIGGER ON payment_failures FROM anon`.

## Grant ratchet
Item 3 is a new GRANT to `authenticated`. When this file is filed under `supabase/migrations/` at apply time, the `No new GRANT to anon/PUBLIC/authenticated` check (`scripts/permissions-ratchet.py`, scope `supabase/migrations/**`, so it does not read this directory) will flag it. The PR that files it needs the label `permissions-ratchet: reviewed`. This PR adds nothing under `supabase/migrations/`, so it does not need the label today. REVOKE lines always pass.

## Who can call it, and what they get
| caller | result |
|---|---|
| the contractor that owns the failure (`contractors.user_id = auth.uid()`), failure `active` or `warning_sent`, not resolved | `requested`; sets `retry_requested_at = now()` |
| same, second call within 15 minutes | `already_requested`; writes nothing; returns the stored time |
| same, failure resolved / contractor_out / any other state | `not_retryable`; writes nothing |
| another contractor, a homeowner, an unknown or NULL id, a login-less caller | error 42501 "payment failure not found" (same text for all, so ids cannot be probed) |
| anon | error 42501 permission denied for function |

Concurrency: the ownership read takes `FOR UPDATE` on the failure row, so two simultaneous clicks serialise and the second sees the first's request.

## Risk and what this migration does NOT do
- Nothing consumes `retry_requested_at` yet. Until the process-dunning retry pass exists (see "Still owed" below), a request is recorded and nothing else happens. **The page change must not be published before that pass is deployed**, or the button tells the contractor a retry is coming when none is.
- The function makes no Stripe call and sends no message.
- anon keeps SELECT and REFERENCES on the table (no anon policy exists; SELECT returns no rows). Not writes, left alone.
- `authenticated` still holds UPDATE, INSERT, DELETE and TRUNCATE on `payment_failures` (RLS is the only gate: a contractor has no UPDATE policy, insert/delete policies were not measured here). Out of this ruling's scope; worth its own check.
- The 15-minute window is measured from the stored `retry_requested_at`. When the retry pass later "consumes" a request it must not null the column, or the window resets; it needs its own consumed marker (below).

## Proof (production, project yeszghaspzwwstvsrioa, one batch that ends in a deliberate RAISE, so nothing persisted)
Fixtures: two is_test contractors with a login, one is_test profile that is not a contractor, found at run time. `payment_failures` has no `is_test` column; the four fixture rows belong to the is_test contractor, carry no quote or claim, and exist only inside the batch. Raw output (8-character id prefixes only):

```
[BEFORE] F0 function present=f
[BEFORE] G1-3 anon table privileges UPDATE=t TRUNCATE=t TRIGGER=t | authenticated UPDATE=t
[BEFORE] O1 owner call: REJECTED 42883 function public.request_dunning_retry(unknown) does not exist      <- negative control
[BEFORE] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[BEFORE] D2 anon, direct table UPDATE: rows=0 | row unchanged=t
[AFTER] F0 function present=t secdef=t config={"search_path=public, pg_temp"} anon_exec=f authenticated_exec=t
[AFTER] G1-3 anon table privileges UPDATE=f TRUNCATE=f TRIGGER=f | authenticated UPDATE=t (unchanged by this change)
[AFTER] O1 owner, active row: {"status": "requested", ...} | other columns unchanged=t | retry_requested_at set=t
[AFTER] O2 owner again inside 15 min: {"status": "already_requested", ...} | retry_requested_at unchanged=t | other columns unchanged=t
[AFTER] O3 owner, request 16 min old: {"status": "requested", ...} | retry_requested_at moved forward=t
[AFTER] O4 owner, warning_sent row: {"status": "requested", ...}
[AFTER] N1 owner, resolved row: {"status": "not_retryable", "retry_requested_at": null} | retry_requested_at still null=t
[AFTER] N2 owner, contractor_out row: {"status": "not_retryable", "retry_requested_at": null} | retry_requested_at still null=t
[AFTER] X1 another contractor: REJECTED 42501 payment failure not found
[AFTER] X2 homeowner: REJECTED 42501 payment failure not found
[AFTER] X3 anon: REJECTED 42501 permission denied for function request_dunning_retry
[AFTER] X4 authenticated, no login claim: REJECTED 42501 payment failure not found
[AFTER] X5 owner, unknown id: REJECTED 42501 payment failure not found
[AFTER] X6 owner, NULL id: REJECTED 42501 payment failure not found
[AFTER] X-none: after X1-X6 the active row still has retry_requested_at null=t and other columns unchanged=t
[AFTER] D1 owner, direct table UPDATE of dunning_status/amount_cents: rows=0 | row unchanged=t
[AFTER] D1b owner, direct table UPDATE of retry_requested_at: rows=0 | still null=t
[AFTER] D2 anon, direct table UPDATE: REJECTED 42501 permission denied for table payment_failures | row unchanged=t
ROWS payment_failures before-run=0 inside-batch-end=8 (fixtures; the batch rolls back)
```
Production unchanged after the batch (SELECT): payment_failures rows 0, function count 0, column count 0, anon UPDATE/TRUNCATE/TRIGGER still true.

## Still owed before anything is applied or published
1. REVIEW and LEGAL-READ of this PR, and Ben's R-177 signature, then the R-097 24-hour window posted on #2442.
2. The retry pass in the `process-dunning` scheduled (CRON) mode. NOT in this PR. Why: the function's only Stripe charge code is inline inside its TRIGGER-mode branch (`index.ts`, the "MULTI-METHOD RETRY" block): it returns HTTP responses from inside the loop, reads the staging/live key from the request's Origin header, takes `quote_id`/`amount_cents` from the request body, and is followed by an INSERT of a new payment_failures row. Reusing it from CRON means moving that block into a shared function and changing TRIGGER mode to call it, which edits the existing money path rather than adding beside it. That needs its own reviewed change (see the PR body for the exact asks, including the Stripe idempotency-key point and the consumed-marker columns).
3. A Stripe TEST-mode run of that pass before any live key sees it (owner: Marty, at deploy time).
