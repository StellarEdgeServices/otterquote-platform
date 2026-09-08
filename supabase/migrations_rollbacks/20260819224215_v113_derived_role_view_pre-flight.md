# Pre-Flight: 20260819224215_v113_derived_role_view

**Migration**: 20260819224215_v113_derived_role_view.sql
**Date**: 2026-08-19
**Author**: Claude Code (run-work rw-909-f22-b4vw)
**D-numbers**: D-182 (Tier 3), D-221 (Path A)
**Tracking**: gh-909 (Option C, Dustin-approved 2026-08-17 CEO board; build details APPROVED 2026-08-19 comment 5346445233)

## Change Summary

Adds `public.resolved_user_role`, a read-only, `SECURITY INVOKER` VIEW that
derives each authenticated user's functional role from fact tables
(`contractors`, `referral_agents`, `claims`) instead of the single-scalar
`profiles.role` column. Purely additive: no existing table, column, index,
policy, or function is touched, dropped, or altered. `profiles.role` is
unchanged and keeps being written by its 5 existing writers — it becomes
fallback/signup-lane metadata as of this migration, not authoritative, per
the gh-909 scoping decision. Enables cutting `js/auth.js getRole()`,
`react-app/app/providers/auth-provider.tsx resolveRole()`, and
`react-app/app/auth-callback/page.tsx` over to a single fact-table-backed
source of truth (separate PR, blocked on this migration landing in prod).

## Precedence Encoded

1. `contractors` row exists for this `user_id` → `'contractor'`
2. Active `referral_agents` row (`status='active'`) → `agent_type`
3. Owns ≥1 `claims` row (`claims.user_id = auth.uid()`) → `'homeowner'`
4. `profiles.role` is not null → `profiles.role`
5. Default → `'homeowner'`

Steps 1–2 and 4–5 are identical to `getRole()`'s existing order (pure
representation change). Step 3 (claims → homeowner) is new behavior,
explicitly approved 2026-08-19.

## Row Count Estimate

| Table | Row Count (2026-08-19) | Source |
|-------|------------------------|--------|
| profiles | 38 | live query |
| contractors | ~14 linked to profiles (unique index on user_id) | live query |
| referral_agents | 13 (7 linked, 6 unclaimed/NULL) | live query |
| claims | not counted (view reads via indexed `user_id`, EXISTS short-circuits) | — |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| CREATE VIEW | none on existing tables (new relation only) | <1s |
| COMMENT ON VIEW | ACCESS EXCLUSIVE on the new view only | <1s |
| REVOKE/GRANT | ACCESS EXCLUSIVE on the new view only | <1s |

No existing table is locked. This is the lowest-risk category of migration
in the danger-pattern checklist: a brand-new, read-only, indexed-lookup view.

## Danger Pattern Check

| Pattern | Triggered? | Override? |
|---------|-----------|-----------|
| NOT NULL without DEFAULT | No | — |
| NOT NULL on >100K rows | No | — |
| Drop column | No | — |
| Type change rewrite | No | — |
| Index without CONCURRENTLY | No (no index created) | — |
| RENAME | No | — |
| Truncate/DELETE all | No | — |
| CASCADE DROP | No | — |
| New function in public (grant-default trap) | N/A — this is a VIEW, not a function. Applied the same discipline anyway: explicit `REVOKE ALL ... FROM PUBLIC, anon` + `GRANT SELECT ... TO authenticated`, verified live (see Branch Test Results) | — |

## Live Pre-Build Re-Verification (Gate 5.5 — scoping comment premise check)

The scoping comment (gh-909 #5320260678, 2026-08-17) is 2 days old. Re-ran
its quoted live counts against prod (`yeszghaspzwwstvsrioa`) on 2026-08-19
before designing:

| Claim (2026-08-15/17) | Re-verified (2026-08-19) | Status |
|---|---|---|
| profiles: 24 homeowner / 14 contractor, 0 NULL | 24 homeowner / 14 contractor, 0 NULL | **Unchanged** |
| 3 orphan `profiles.role='contractor'` rows with no `contractors` row | 3 orphan rows, same shape (different exact set not re-diffed, count matches) | **Unchanged** |
| referral_agents: 12 active rows total (5 unlinked/NULL, 5 linked-homeowner, 2 linked-contractor) | 13 active rows total (6 unlinked/NULL, 7 linked) | **DRIFTED** — 1 more row since 2026-08-15/17 (expected — the platform is live and partners register continuously). Shape unchanged: still a mix of linked and unlinked rows. Does not affect the view's design — the precedence logic and NULL-linkage limitation both already account for this shape, not an exact count. |

**Conclusion**: premises hold except the expected natural drift in
`referral_agents` row count, which does not change the design.

## Supabase Branch Test Results

Branch: `gh909-derived-role-view` (project_ref `vvmmqihwsckejyrffmuu`, created
off `yeszghaspzwwstvsrioa`, **deleted after testing**).

**Premise correction (Gate 5.5 finding on the WORK ORDER itself, not the
scoping comment):** the work order assumed "the branch should have the same
data as a fork of prod at branch-creation time." This is **false** for this
Supabase MCP setup — `create_branch` returned `"with_data": false` and the
resulting branch had 0 rows in all 4 fact tables (schema-only fork, matching
the known local gotcha "fresh Supabase branches MIGRATIONS_FAILED" —
`list_branches` did show `MIGRATIONS_FAILED` status for this branch despite
the migration applying and the schema being fully present and query-able).
Adapted: seeded 6 synthetic rows on the branch, covering the exact shapes of
the 6 documented cases (using fabricated UUIDs since no real prod rows exist
on the branch), rather than looking up real prod row ids. This tests the
view's logic and access control identically to a data-forked branch; it just
does not use literal prod row ids. Noted here rather than silently
substituting.

Forward: ✅ Applied successfully (`apply_migration`, no errors)

### 6 documented cases (gh-909 comment 5320260678, "Test" phase) — all PASS

| # | Case | Seeded facts | Expected `derived_role` | Actual `derived_role` | Result |
|---|------|--------------|--------------------------|------------------------|--------|
| 1 | Plain homeowner | `profiles.role='homeowner'`, no contractor/partner/claim | `homeowner` | `homeowner` | ✅ PASS |
| 2 | Plain contractor | `profiles.role='contractor'` + `contractors` row | `contractor` | `contractor` | ✅ PASS |
| 3 | Partner-only, linked | active `referral_agents` row (`agent_type='re_agent'`), `user_id` set, `profiles.role='homeowner'` | `re_agent` | `re_agent` | ✅ PASS |
| 4 | Partner-only, unclaimed (NULL linkage) | `referral_agents` row, `status='active'`, `user_id IS NULL` | invisible to the view (no `auth.uid()` can ever equal `NULL`) | Row confirmed to exist in `referral_agents` (`id=ca2b7556-...`, `user_id IS NULL`); no session can query it via the view — there is no valid JWT `sub` that resolves to it | ✅ PASS (documented limitation, not a defect — matches gh-909 scoping comment) |
| 5 | Dual-role (contractor + active partner) | both a `contractors` row and an active `referral_agents` row for the same user | `contractor` (precedence: contractor wins) | `contractor` (`is_contractor=true`, `is_active_partner=true`, `partner_agent_type='re_agent'` both exposed as facts) | ✅ PASS |
| 6 | Known orphan (`role='contractor'`, no `contractors` row) | `profiles.role='contractor'` only, no `contractors` row, matching the 3 live prod orphans | `contractor` (falls through to `profiles.role`, same as current `getRole()`) | `contractor` | ✅ PASS |

### Bonus case (new behavior — claims-derived homeowner, not one of the 6 but explicitly approved 2026-08-19)

| Case | Seeded facts | Expected | Actual | Result |
|------|--------------|----------|--------|--------|
| No profile row at all, owns 1 claim, no contractor/partner | `claims.user_id` set, no `profiles` row | `homeowner` (new: claims fact resolves homeowner even with zero profile row) | `derived_role='homeowner'`, `owns_claim=true`, `profile_role=NULL` | ✅ PASS |

### Access-control / enumeration checks (the scoping comment's stated risk)

| Probe | Result |
|-------|--------|
| No JWT claim at all (`role='authenticated'`, no `sub`) | 0 rows returned (`WHERE user_id IS NOT NULL` in the view body) |
| `role='anon'` | `ERROR 42501: permission denied for view resolved_user_role` — the `REVOKE ALL ... FROM anon` took effect; anon cannot query the view at all, not even to get 0 rows |
| Authenticated as case-2 (contractor), attempt to read the underlying `profiles` table directly (proxy for "could this identity see anyone else's row through any path") | 1 row visible (their own) — `profiles_user_read` RLS policy (`id = auth.uid()`) holds under `SECURITY INVOKER` |

No path found, in 3 independent probes, for one authenticated user to see
another user's derived role or underlying fact-table row through this view.

Rollback: not exercised on the branch (the branch was schema-only-forked
and disposable — testing forward-then-rollback-then-verify-restored on a
throwaway environment adds no signal beyond what the Rollback Hard Gate
below already checks). Rollback SQL reviewed manually: `DROP VIEW IF EXISTS
public.resolved_user_role;` is the exact syntactic inverse of `CREATE VIEW
public.resolved_user_role ...` — nothing else was created by the forward
migration (no new table, column, index, or function), so there is nothing
else to revert. Zero data-loss risk since the view is read-only and no data
was written.

## Deploy Notes

- **D-182 Tier**: 3 (SQL migration — requires Dustin approval)
- **D-221 Deploy Path**: this migration is NOT bundled into the call-site PR
  (gh-909 derived-role-view PR, `js/auth.js`/`auth-provider.tsx`/
  `auth-callback/page.tsx`). It is posted to gh-909 as SQL for direct
  `apply_migration` against `yeszghaspzwwstvsrioa` once Dustin signs off —
  per the work order, this session does not apply it, and per D-182 no
  migration self-deploys.
- **Sequencing**: the call-site PR is intentionally blocked from merging
  until this migration is live in prod (the view must exist before
  `getRole()`/`resolveRole()` can query it) — see PR body.
- **Rollback pre-authorized**: Yes — run `20260819224215_v113_derived_role_view_rollback.sql`
  if anything downstream errors after cutover. Safe to run at any time
  before the call-site PR merges (nothing depends on the view yet); after
  the call-site PR merges, roll back the call-site code FIRST.
- **Monitoring**: N/A pre-cutover (nothing reads this view in prod until the
  call-site PR merges, which is explicitly gated behind this approval).

## Migration Number Collision Guard

Ran `tools/next_migration_version.py --project-id yeszghaspzwwstvsrioa`:
`sql/` max v110, `supabase/migrations/` max v104 (dir-only scan). Cross-checked
live DB via `list_migrations` (max applied: v110). Cross-checked open PRs:
**PR #947** ("pre-draft R-097 Tier-3B brief for BoldSign cutover") reserves
`sql/v111` and `sql/v112` as in-flight draft migration numbers for a
*different*, unrelated Tier-3B cutover (doc-only PR, migrations not yet
written) — confirmed by grepping the open-PR body text. Final number:
`max(110, 111 reserved, 112 reserved) + 1` = **v113**. Recorded here per the
skill's "if sources disagree, record the drift" instruction — sources didn't
disagree on landed history, but the open-PR reservation check is what pushed
the number from the naive v111 to v113.

## Danger Overrides

None.
