# Pre-Flight: v101_referral_agents_public_directory_optin

**Migration**: 20260807223000_v101_referral_agents_public_directory_optin.sql
**Date**: 2026-08-07
**Author**: Code (Claude Code) — Wave 2 weekend engineering-drain batch 1
**Issue**: StellarEdgeServices/otterquote-platform#402
**Tier**: 3A (additive, `boolean NOT NULL DEFAULT false`, per the issue's `tier:3a` label)
**Status**: DRAFT / PR ONLY — NOT APPLIED. Actual `apply_migration` execution against the
live project is intentionally out of scope for this PR and was not performed by the
authoring session. It is a separate step for a human (or migration-author flow) to run.

---

## Change Summary

Adds a `public_directory_optin` boolean column to `public.referral_agents` with
`NOT NULL DEFAULT false`. All existing agents default to opted out (`false`).
Purely additive — no data loss, no existing rows altered beyond receiving the
new default. Functionally identical to the SQL already drafted in
`supabase/migrations/v88_referral_agents_public_directory_optin.sql` (merged to
main 2026-07-03 via PR #367), which was left without a timestamp prefix and is
therefore not recognized by the Supabase migration tooling. This file is that
same statement, re-cut with a real timestamp prefix so it can actually be applied
once approved.

## Target Table Confirmation (read-only checks, 2026-08-07)

| Check | Result |
|---|---|
| `list_tables` (public schema) | `referral_agents` present, comment: "Tracks referral sources: RE agents, insurance agents, home inspectors, and customers. Stores profile info and commission statistics." |
| Row count at issue filing (`created_at < 2026-07-05`) | 2 — matches the "(2-row table)" description in issue #402's title |
| Row count now (2026-08-07) | 9 (grown via `register_partner` RPC self-serve registration, shipped 2026-07-25 per v95/v95a) |
| Column check | `public_directory_optin` does NOT currently exist on `referral_agents` — confirms the column has never been applied |
| `list_migrations` | No entry named `v88_referral_agents_public_directory_optin` (or `v101_...`) in the applied migrations table — confirms this migration has never run against production |
| Schema fit | Table already has directory-display columns: `bio`, `photo_url`, `website`, `service_area` — consistent with gating a public partner-directory listing |

Alternative candidate considered and ruled out: `public.rate_limit_config` (2 rows
today) is a rate-limiting kill-switch config table (`function_name`, `max_per_hour/day/month`,
`enabled`, budget fields) with no directory-related semantics — not a fit for
"public directory opt-in."

## Row Count / Lock Impact

Table has single-digit rows; `ADD COLUMN ... DEFAULT false` takes a brief
ACCESS EXCLUSIVE lock, negligible duration.

## Danger Pattern Check

| # | Pattern | Triggered? |
|---|---------|-----------|
| NOT NULL without DEFAULT | No — has `DEFAULT false` |
| NOT NULL on table > 100K rows | No — single digit rows |
| DROP COLUMN | No |
| Type change / table rewrite | No |
| Index without CONCURRENTLY | No — no index added |
| RENAME | No |
| TRUNCATE/DELETE | No |
| CASCADE DROP | No |

All clear.

## Deploy Notes

- Ships via GitHub PR → CI → merge (Path A). Merging does **not** apply the
  migration — there is no auto-run pipeline for `supabase/migrations/` in this
  repo. Actual application against the live project requires an explicit
  `apply_migration` (or `supabase db push`) run, reviewed separately.
- Rollback pre-authorized (see companion `_rollback.sql`) if applied and needs
  reverting; rollback destroys any opt-in data written after the forward
  migration runs.
- Follow-on work referenced in the original v88 draft (opt-in UI toggle,
  partner directory generator `tools/generate_partner_pages.py`) is unaffected
  by this renumbering and remains a separate task.
