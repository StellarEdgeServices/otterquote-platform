# Pre-flight: 20261006171024_gh2559_claim_docs_world_fence (Tier 3B, R-134 fast path)

APPLIED to production under R-134 (ledger version `20261006171747`). Refs #2559 (CEO handoff 6017797599, CTO ruling 6021154136 item 2). Protective only: it removes read access and grants none.

## What it does
It recreates one storage policy, `"Contractors can view biddable claim docs"` on `storage.objects`, with one added condition on the bidding branch: `c.is_test = ct.is_test`.

- Before: any contractor login with `status = 'active'` could read every file in the folder of any claim open for bids (`ready_for_bids` and status `active`, `bidding` or `pending`). A test-flagged login could read a real homeowner's files.
- After: on that branch the claim and the contractor must be in the same world (both test or both real).
- Unchanged: policy name, `SELECT`, role `authenticated`, the bucket test, the path convention, the three statuses, and the selected-contractor branch (`c.selected_contractor_id = ct.id`).
- No other policy, table, column, grant or data is touched. The proof prints an md5 over the other 31 policies on `storage.objects`; it is the same before, after the forward DDL, and after the rollback DDL.

## Why not the claims-table fence
`"Contractors can view biddable claims"` on `public.claims` hides test claims from real contractors. It shows real claims to every active contractor, test-flagged ones included. Copied to storage it would leave this hole open. The world match closes both directions.

## Who is affected (production, read 2026-10-06)
- Active contractors: 8, all `is_test = true`. Active `is_test = false` contractors: 0 (2 real rows exist, both `pending_approval`).
- Claims with files in `claim-documents`: 9. Real and open for bids: `c5ebaa5d` (2 files), `5c16cc1e` (1 file). Real draft: `4595b6f0` (2 files, never readable by contractors). Test and open: 5. Test, not open: 1.
- Effect: each of the 8 test-flagged contractor logins loses read on the 3 files of the 2 real open claims. No real contractor loses anything.
- Claims selected across worlds (claim and selected contractor with different `is_test`): 0.

## Known consequences
- A test-flagged contractor still sees a real open claim's ROW (the claims policy is not changed here). The Loss Sheet and measurement buttons on that row now fail for that login (`createSignedUrl` returns not found). The row exposure belongs to the D-368 narrowing.
- A real company that is still flagged `is_test` (onboarded but not released) cannot open a real claim's files until its flag is flipped. That is the intended order (D-325).
- The policy subquery runs under the caller's row security on `claims` and `contractors`, as before.

## Danger-pattern check
- `DROP POLICY` + `CREATE POLICY` in one transaction with `lock_timeout = '5s'`. Both take a brief ACCESS EXCLUSIVE lock on `storage.objects`; if it cannot be had in 5 seconds the whole transaction fails and nothing changes.
- A NULL `is_test` on either side refuses the read (fails closed). Production has 0 NULLs in both columns.
- Fresh-database replay: the policy is dropped `IF EXISTS` and created; v88 (`20260708002834`) creates it earlier in the chain.

## Proof
`supabase/tests/gh2559_claim_docs_world_fence_proof.sql`, one DO block that always rolls back. Run in forward-rollback mode before the apply: `VERDICT live: UNFENCED`, `VERDICT after forward: FENCED`, `VERDICT after rollback: UNFENCED`. Run alone after the apply: `VERDICT live: FENCED`. The lines that change are T1, T2 (test contractor, real open claim's file: 1 row to 0), R3 (real contractor with a bid on a test claim, that claim's file: 1 to 0) and T-all (7 to 4). R2, T3, S1, O1, O2, V1 are unchanged.

## Rollback
`supabase/migrations_rollbacks/20261006171024_gh2559_claim_docs_world_fence_rollback.sql` restores the v88 text. It re-opens the hole. Also delete the ledger row named `20261006171024_gh2559_claim_docs_world_fence`.

## Not in this change
The D-368 narrowing (a bidder sees only the summary before selection). Separate Tier 3B change with its own 24-hour notice.
