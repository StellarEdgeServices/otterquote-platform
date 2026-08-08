# Pre-Flight: v83_add_public_directory_optin_to_contractors

**Migration**: v83_add_public_directory_optin_to_contractors.sql  
**Date**: 2026-05-26  
**Author**: Wingman F-22  
**D-numbers**: D-182 (Tier 3), D-221 (Path A)  
**ClickUp task**: 86e1j4jaz (SEO P2)

---

## Change Summary

Adds a `public_directory_optin` boolean column to the `contractors` table with `DEFAULT false NOT NULL`. This column gates which contractors appear on a future public-facing SEO directory page. All existing contractors default to opted out (`false`). Contractors will need to explicitly opt in, likely via a settings UI toggle (future build task). No data loss risk; the column is additive only.

---

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| contractors | 5 | Supabase query — 2026-05-26 |

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|-------------------|
| ADD COLUMN with DEFAULT (5 rows) | ACCESS EXCLUSIVE (brief) | < 5ms — negligible |

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | ✅ No — has `DEFAULT false` | — |
| 2 | NOT NULL on table > 100K rows | ✅ No — only 5 rows | — |
| 3 | DROP COLUMN | ✅ No | — |
| 4 | Type change requiring table rewrite | ✅ No | — |
| 5 | Index without CONCURRENTLY on hot table | ✅ No — no index added | — |
| 6 | RENAME TABLE or RENAME COLUMN | ✅ No | — |
| 7 | TRUNCATE or DELETE all rows | ✅ No | — |
| 8 | CASCADE DROP | ✅ No | — |

**All 8 patterns clear. No overrides required.**

---

## Code Path Impact Analysis

- **Existing reads of `contractors` table**: Zero code paths reference `public_directory_optin` — confirmed by full codebase grep (2026-05-26). Adding a column with a server-side DEFAULT is fully backward-compatible; no existing SELECT *, INSERT, or UPDATE statements break.
- **RLS policies**: No change required. The existing RLS on `contractors` applies; this column follows the same access rules as the rest of the row.
- **No index added**: Boolean opt-in on a 5-row table with anticipated low cardinality does not warrant an index now. Revisit when directory is live and row count grows.

---

## Supabase Branch Test Results

**Branch**: migration-test-v83 (`heefyvkxffdontamrbfe`)  
**Note**: Branch schema was empty (migrations not linked to Supabase branch tracking); minimal contractors table scaffolded for test.

| Step | Result |
|------|--------|
| Forward — `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS public_directory_optin BOOLEAN DEFAULT false NOT NULL` | ✅ Applied |
| Verify — column present with `data_type=boolean`, `column_default=false`, `is_nullable=NO` | ✅ Confirmed |
| Rollback — `ALTER TABLE contractors DROP COLUMN IF EXISTS public_directory_optin` | ✅ Applied |
| Verify — column absent from `information_schema.columns` | ✅ Confirmed — schema restored |

Branch deleted after test.

---

## Deploy Notes

- **D-182 Tier**: 3 — SQL migration. Requires explicit Dustin approval before execution.
- **D-221 Deploy Path**: GitHub PR → merge → Netlify/Supabase auto-deploy (Path A). Do NOT execute via direct Supabase push or bash.
- **Rollback pre-authorized**: Yes — run `v83_..._rollback.sql` immediately if any schema-related errors appear post-deploy. Rollback destroys any optin data written after the forward migration runs, so execute quickly if needed.
- **Monitoring**: Watch Sentry for 30 minutes post-deploy for any unexpected DB errors on the `contractors` table.
- **Follow-on work**: A UI toggle on `contractor-settings.html` or `contractor-profile.html` will be needed to let contractors set this flag. The public directory page itself is a separate build task.

---

## Danger Overrides

None.
