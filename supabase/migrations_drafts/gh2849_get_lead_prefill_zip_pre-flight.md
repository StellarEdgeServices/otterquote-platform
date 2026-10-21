<!--
STATUS (gh-1438, as of 2026-10-19): NOT APPLIED
FILE ROLE: pre-flight file of set gh2849_get_lead_prefill_zip (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-19 under #2849; production definition read-only (pg_get_functiondef) the same day
REPO COPY: none
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-Flight: gh2849_get_lead_prefill_zip

**Migration**: gh2849_get_lead_prefill_zip.sql
**Date**: 2026-10-19
**Author**: Marty (CTO) worker, subagent of cto-2026-10-19T18:36:34Z
**Issue**: #2849 (parent #2598). **Tier**: 3B (Ben 6256645058). **Decision**: D-389.
**Status**: DRAFT ONLY, NOT APPLIED. Apply needs the R-097 24-hour notice, Marty's apply and Dustin's word (Ben 6256645058).

## Change summary

`get_lead_prefill(uuid)` returns `zip` as a fourth column. DROP + CREATE in one transaction (a new OUT column cannot go through CREATE OR REPLACE). Guard, stamp, SECURITY DEFINER, VOLATILE, search_path and grants unchanged. In-transaction assertions check shape, security, search_path and that anon/authenticated keep EXECUTE and PUBLIC does not.

## Production state read before drafting (read-only, 2026-10-19)

| Item | Value |
|---|---|
| signature | `get_lead_prefill(uuid)` |
| result | `TABLE(name text, email text, phone text)` |
| prosecdef / volatility | true / v |
| proconfig | `search_path=public, pg_temp` |
| proacl | `{postgres=X/postgres,service_role=X/postgres,anon=X/postgres,authenticated=X/postgres}` |
| body | identical to `supabase/migrations/20260916132127_gh1994_router_leads_columns.sql:318-334` |
| `leads.zip` | exists, `text` |

## Lock / risk

DROP/CREATE FUNCTION takes a lock on the pg_proc entry only, milliseconds. No table rewrite, no data change. Callers mid-transaction see either the old or the new function. Window of "function missing": none outside the transaction.

## Danger patterns

| # | Pattern | Triggered? |
|---|---|---|
| 1-2 | NOT NULL without default / on big table | No |
| 3 | DROP COLUMN | No |
| 4 | Type change with rewrite | No |
| 5 | Index without CONCURRENTLY | No |
| 6 | RENAME | No |
| 7 | TRUNCATE / DELETE all | No |
| 8 | CASCADE DROP | No (plain DROP FUNCTION; no dependent objects: views/triggers do not reference an RPC) |

## Order

1. Merge the PR (page.tsx tolerates both shapes: no `zip` key = no prefill, test 4).
2. R-097 notice, then apply this file; record the ledger version and move the set per `supabase/migrations_drafts/README.md`.
3. Verify after apply: `select pg_get_function_result('public.get_lead_prefill(uuid)'::regprocedure)` reads `TABLE(name text, email text, phone text, zip text)`; `has_function_privilege('anon','public.get_lead_prefill(uuid)','EXECUTE')` is true; negative probe: a random uuid returns 0 rows.
