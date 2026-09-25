# SQL Migration Naming Conventions
# Authored: 2026-05-26 | Wingman wm-f22-20260526T204006-vzzq | Task 86e1fwe3x

---

## Why This Document Exists

An audit of `sql/` revealed multiple inconsistent naming patterns across forward migrations and rollback files. Since Supabase tracks applied migrations by filename in `schema_migrations`, existing files **cannot be renamed without breaking the migration history**. This document codifies the going-forward standard so new migrations are consistent.

---

## Patterns Found in Existing Files (Historical)

### 1. Version Number Collisions — Same Integer, Multiple Files
Two approaches were used when multiple migrations landed in the same version slot:

**Pattern A: Sequential letter suffix starting from A**
```
v35a-admin-verification.sql
v35b-insurance-detail-columns.sql

v50a-coi-reminders-cron.sql
v50b-cron-health.sql

v52a-payout-approvals.sql
v52b-platform-monitoring.sql
v52c-state-gating.sql

v71a-quotes-warranty-uploaded-at-index.sql
v71b-warranty-indexes.sql
```

**Pattern B: Primary migration keeps the number, follow-on patches use "b" or "b/c"**
```
v60-support-tickets.sql       (primary)
v60b-support-tickets-fk-indexes.sql  (follow-on patch)

v62-d214-d215-fee-acceptances.sql    (primary)
v62b-warranty-options.sql            (patch)

v63-d199-contractor-templates.sql    (primary)
v63b-d204-cert-verification-quality.sql  (patch)

v76-homeowner-video-upload.sql       (primary)
v76b-security-definer-search-paths.sql
v76c-rls-explicit-deny-service-role.sql
```

**Pattern C: No suffix — flat collisions (earliest files)**
```
v3-rate-limits.sql
v3-role-auth-migration.sql   ← same version number, no disambiguation

v11-auto-bid.sql
v11-docusign-integration.sql  ← same version number, no disambiguation
```

### 2. Rollback File Naming — Four Different Patterns Found
```
# Pattern R1: v{N}-rollback-{name}.sql  (majority)
v10-rollback-contractor-profile-settings.sql

# Pattern R2: v{N}-{name}-rollback.sql  (minority)
v57-per-user-rate-limits-rollback.sql
v60-support-tickets-rollback.sql

# Pattern R3: rollback-v{N}-{name}.sql  (one-off)
rollback-v59-incomplete-onboarding-reminders.sql

# Pattern R4: v{N}r-{name}.sql  (recent, r=rollback suffix on version)
v79r-d230-cpa-version-tracking-rollback.sql
v80r-check-rate-limit-uuid-text-overload-rollback.sql
v80br-d231-home-profiles-rollback.sql
v81r-process-auto-bids-cron-rollback.sql

# Truncated rollback (no descriptive name)
v58-rollback.sql
v61-rollback.sql
```

### 3. Word Separator Inconsistency
Most files use hyphen throughout. Two files use underscore throughout:
```
v66_d204_cert_verifications.sql
v69_d202_warranty_manifest_drift.sql
```

### 4. Non-SQL Files in sql/
```
v67-intentionally-skipped.md   ← .md file, not .sql
schema-snapshot.json            ← not a migration file
```

---

## Going-Forward Convention (Applies to All New Migrations)

### Forward Migration
```
v{N}-{kebab-case-slug}.sql
```
- `N` = next sequential integer after the current highest (currently: 81 → next = 82)
- Slug = short kebab-case description, 2–5 words, no D-number prefix unless significant
- **Never reuse a version number.** If two migrations need to ship together, give them consecutive integers.

**Examples:**
```
v82-add-contractor-notes-column.sql
v83-d235-homeowner-notifications.sql
```

### Rollback File
```
v{N}r-{kebab-case-slug}.sql
```
- Use the `r` suffix directly on the version number — Pattern R4 is the canonical form
- Match the forward migration's slug exactly

**Examples:**
```
v82r-add-contractor-notes-column.sql
v83r-d235-homeowner-notifications.sql
```

### Rules
1. **One version number per forward migration.** Never two files at the same N.
2. **Kebab-case only.** No underscores except within D-number references (e.g., `d235` stays lowercase).
3. **No bare `rollback` files.** Always include the slug so the file is self-describing.
4. **No `.md` or `.json` files in `sql/`.** Non-SQL reference files go in `Docs/` or at repo root.

---

## Existing Files: No Action Required

All files listed above **must not be renamed.** Supabase records applied migrations by filename in `public.schema_migrations`. Renaming applied files would cause Supabase to re-attempt them on next deploy, which would fail or corrupt state.

If a clean break is needed for developer ergonomics, it should be discussed with Dustin as a Tier 3 decision (D-220 applies).

---

## Schema-Lint Integration

The schema-lint CI check (task 86e1j4kd6) will enforce this convention on new files. Once that check is merged, naming violations will block PRs automatically. Until then, enforce manually on code review.

---

## GitHub Issue Linking on Two-Phase (Expand/Contract) Migrations

Migrations that must ship as two distinct applied phases — e.g. the additive
phase-1 (create a replacement function/column) followed by a later,
separately-applied destructive phase-2 (drop the old view/column) — follow
the expand/contract pattern documented inline in migrations like
`sql/v109-contractors-referral-agents-public-security-invoker.sql`. That
pattern exists specifically so phase 1 and phase 2 are NOT the same atomic
step: phase 1 ships and deploys safely on its own, and phase 2 only applies
once the paired call-site PR is confirmed live, avoiding an outage window.

**Convention:** the PR that ships phase 1 should reference the GitHub issue
with `Refs #NNN`, not `Fixes #NNN` / `Closes #NNN`. Reserve the closing
keyword for whichever PR (or manual close) actually completes phase 2. Using
a closing keyword on the phase-1 PR auto-closes the issue the moment phase 1
merges, even though the migration isn't done — the issue tracker then shows
"closed" for however long phase 2 is pending, which can be hours or days for
migrations that wait on a paired app deploy to go live first.

This gap was observed on #716 (v109): the phase-1 PR said "Fixes #716" and
the issue closed on merge, before the phase-2 `DROP VIEW` had actually run.

---

## New Public Tables Need an Explicit `service_role` GRANT (gh-2145, cutover 2026-10-30)

**Vendor notice (Supabase, received 2026-09-23):** on 2026-10-30, Supabase
stops auto-granting Data API (PostgREST) access to any table created in the
`public` schema **after that date**. Existing tables are unaffected. The
vendor's own required shape for a table that still needs Data API reach:

```sql
grant select on public.your_table to anon;
grant select, insert, update, delete on public.your_table to authenticated;
grant select, insert, update, delete on public.your_table to service_role;
```

**What this repo actually needs, and why it's narrower than the vendor's
3-role template:**

- `anon` / `authenticated` grants remain a **per-table product decision** —
  exactly as they are today — and are already gated by
  `scripts/permissions-ratchet.py` (gh-1767): a migration that GRANTs
  `anon`/`authenticated`/`PUBLIC` anything fails that check unless the PR
  carries the `permissions-ratchet: reviewed` label. **Nothing about gh-2145
  changes that gate.** If a new table is meant to be reachable by anon or
  authenticated clients, write the GRANT and add the `permissions-ratchet:
  reviewed` label to the PR, same as today.
- `service_role`, by contrast, is needed by essentially every table in this
  repo (Edge Functions, cron jobs, admin tooling — anything that reaches
  Postgres through the Data API with the service-role key) and is the one
  role on `permissions-ratchet.py`'s `ALLOWLISTED_GRANT_ROLES` — a migration
  that grants only `service_role` **never** needs the bypass label. A new
  table with no explicit `service_role` grant will, after 2026-10-30, simply
  have none — Edge Functions calling it through the Data API get
  permission-denied, a production break with no CI signal today.

  `.github/workflows/new-table-service-role-grant.yml`
  (`scripts/new-table-service-role-grant-check.py`) is a diff-scoped,
  build-failing CI gate for exactly this: any migration that adds a
  `CREATE TABLE ... public.<x>` fails unless the same file also contains an
  explicit `GRANT ... TO service_role` naming that table (or a schema-wide
  `GRANT ... ON ALL TABLES IN SCHEMA public TO service_role`). It does not
  require or check anon/authenticated grants — that stays permissions-
  ratchet's job, so the two gates can never disagree about the same
  statement.

**Premise correction (read-only prod check, 2026-09-25):** gh-2145's own
issue body cites `partner_onboarding_sends` as an example of a table that
is "RLS on and no policies, so it is service-role only anyway." Enumerating
this project's actual grants (`aclexplode(pg_class.relacl)` against prod,
`yeszghaspzwwstvsrioa` — `information_schema.role_table_grants` returns
nothing useful here, it only shows grants visible to the querying role)
shows that table in fact holds the **full, unrestricted default grant** to
`anon`, `authenticated`, and `service_role` alike; it is locked down by its
RLS policies (or lack thereof), not by its grants. Of the 48 public tables
with any explicit anon/authenticated/service_role ACL entry today, 44 carry
this same "wide-open grant, RLS does the real work" shape and only 2
(`ad_sharing_suppressions`, `lead_consents`) are narrow at the grant level.
Practically: today's status quo is that **every** new table gets full
anon+authenticated+service_role access at the Postgres grant layer, and RLS
is the only real fence. After 2026-10-30, that default disappears — a net
security improvement on the anon/authenticated side, but a net availability
regression for `service_role` unless the new table's migration says so
explicitly. That is what this gate exists to catch.

**New-table template (forward migration):**
```sql
CREATE TABLE IF NOT EXISTS public.new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.new_table ENABLE ROW LEVEL SECURITY;

-- Always: service_role needs an explicit grant post-2026-10-30, and this
-- role is exempt from permissions-ratchet's bypass-label requirement.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.new_table TO service_role;

-- Only if this table is meant to be reachable by anon/authenticated
-- clients directly (uncommon -- most tables are service_role/EF-only):
-- CREATE POLICY "..." ON public.new_table FOR SELECT USING (...);
-- GRANT SELECT ON public.new_table TO anon;                    -- needs the
-- GRANT SELECT, INSERT, UPDATE, DELETE ON public.new_table      -- `permissions-
--   TO authenticated;                                          -- ratchet: reviewed`
--                                                                -- label on the PR
```
