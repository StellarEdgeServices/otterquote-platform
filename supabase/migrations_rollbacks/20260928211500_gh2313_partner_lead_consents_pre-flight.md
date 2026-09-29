# Pre-Flight: 20260928211500_gh2313_partner_lead_consents

**Migration**: `supabase/migrations/20260928211500_gh2313_partner_lead_consents.sql`
**Rollback**: `supabase/migrations_rollbacks/20260928211500_gh2313_partner_lead_consents_rollback.sql`
**Issue**: #2313 (Refs #2306 ask 2). **Author**: Marty-costume subagent of `ceo-2026-09-28T20:45:24Z`, claim `ceo78-b2313`.
**Tier**: 3A (additive, one new table). **NOT APPLIED.** Needs Dustin's approval (Tier 3), plus LEGAL-READ + `R-177 SIGNED:` on the consent-capture code in the same PR, plus the R-097 notice for the webhook deploy.

## Shape chosen and why
A new sibling table `public.partner_lead_consents`, not a nullable `partner_id` column on `lead_consents`.
- Nothing existing is altered; the homeowner D-299 evidence table and its live flow are untouched.
- Rollback is one guarded `DROP TABLE`; the column route would need `SET NOT NULL` back on `lead_id`, which fails once a partner row exists.
- The ruling requires evidence BEFORE `register_partner`, so a `referral_agents` FK is impossible; the table is keyed on the Meta leadgen id, which `referral_agents.meta_lead_id` also holds.

## Live measurements (production `yeszghaspzwwstvsrioa`, read-only SELECT, 2026-09-28)
| Check | Result |
|---|---|
| `partner_lead_consents` / `partner_consents` already exist | 0 tables (no collision) |
| `referral_agents.meta_lead_id` column | present (1) |
| `referral_agents` rows | 69 |
| `lead_consents` rows | 10 |
| `lead_consents.lead_id` | uuid, NOT NULL (why it cannot hold a partner) |

## Danger pattern check (migration-author-code Step 1)
No NOT NULL add to an existing table, no drop, no type change, no index on a hot table (the unique constraint is on a new empty table), no rename, no TRUNCATE/DELETE, no CASCADE, no new function.

## Security
RLS enabled, no policy. `REVOKE ALL ... FROM PUBLIC, anon, authenticated`; `GRANT SELECT, INSERT ... TO service_role` only. No anon/authenticated grant. (Post-apply probes to run: `has_table_privilege('anon'|'authenticated', 'public.partner_lead_consents', 'SELECT,INSERT,UPDATE,DELETE')` all false; `relrowsecurity` true; zero rows in `pg_policies` for the table.)

## Not yet done (by design)
- Migration not applied; no Supabase branch test run by the author (Supabase MCP write tools were not used).
- `META_LEADGEN_FORM_ALLOWLIST` entries have no `consent_key`/`consent_text` yet. Until each partner form's entry carries the approved wording, the webhook logs `consent_config_missing` and does NOT register that form's leads. Supplying that wording is a legal decision, not the author's.
