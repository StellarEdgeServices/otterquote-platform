# Pre-Flight: gh3498_quotes_idempotency_key (DRAFT, NOT APPLIED)

**Forward**: `supabase/migrations_drafts/gh3498_quotes_idempotency_key.sql`
**Rollback**: `supabase/migrations_rollbacks/gh3498_quotes_idempotency_key_rollback.sql`
**Issue**: #3498 (REVIEW 6675274132 on PR #3491). **Tier**: 3A additive; apply only through the Tier 3B path (R-097 notice, recorded apply). Nothing was applied by the PR.

## Change
`ALTER TABLE public.quotes ADD COLUMN idempotency_key text` (nullable, no default) and
`CREATE UNIQUE INDEX quotes_idempotency_key_uidx ON public.quotes (idempotency_key) WHERE idempotency_key IS NOT NULL`.

## Would production's duplicates stop the index from building? No.
Read-only SELECTs against project yeszghaspzwwstvsrioa, 2026-11-06:
- `quotes` has 12 rows, all `is_test`; no column matching `%idempot%` exists.
- Groups with more than one quote for the same (claim_id, contractor_id, trade_type): 0. For (claim_id, contractor_id): 0.
- Regardless of those counts, the index is on a column that is NULL in every existing row and is partial on `IS NOT NULL`, so no existing row (duplicate or not) is in the index and the build cannot fail on existing data.
- Existing indexes: `quotes_pkey`, `quotes_one_selected_bid_per_claim`, `quotes_autobid_unique_idx` (auto-bids only) and others; none covers a hand bid, which is why a retry can file a second bid today.

## Local proof (throwaway Postgres 16.15, own port 55498 and data directory, removed afterwards)
A minimal `quotes` table seeded with two duplicate rows for one claim+contractor: forward applied; forward applied a second time (idempotent); four NULL-key rows coexist; a second row with the same key fails `ERROR: duplicate key value violates unique constraint "quotes_idempotency_key_uidx"` (SQLSTATE 23505); rollback removed the column and the index (0 and 0).

## Locks and size
`ADD COLUMN` nullable without default is metadata-only (brief ACCESS EXCLUSIVE). The index build takes a SHARE lock on 12 rows: well under a second. No CONCURRENTLY needed at this size.

## Interaction with live code (read, not run)
- `quotes_guard_homeowner_columns` (INSERT branch, first 2,500 characters read): requires `status='submitted'`, `bid_status='active'` and the defaults on payment/signing columns; it does not list `idempotency_key`. The rest of the function was not read; confirm it does not reject unknown columns before apply.
- RLS: `Contractors can read own quotes` lets the form read its own row back by key after a 23505.
- Order: the forms detect the column missing (PGRST204 or 42703) and file the bid without a key, so the PR can merge before this is applied; the protection starts when it is.

## Danger patterns
NOT NULL without default: no. Drop column: only in rollback. Type rewrite: no. Index without CONCURRENTLY: yes, at 12 rows (accepted). Rename/truncate/cascade: no.
