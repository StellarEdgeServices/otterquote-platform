# Migration chain reconciliation — issue #1438

Status as of 2026-09-01: **file-hygiene half done; backfill half deliberately
not attempted here.** This closes the drafts-directory question the issue was
filed on and records the true population-level gap the CTO's ruling
(issuecomment-5488058121) found while answering it. It does **not** close
issue #1438 — see "What this does not do" below.

## Scope rail (why this file exists and what it deliberately skips)

This reconciliation was executed under a hard scope rail: **zero SQL
execution against the database.** Every verdict below was reached with
read-only queries (`information_schema`, `pg_catalog`,
`supabase_migrations.schema_migrations`) against production
(`yeszghaspzwwstvsrioa`). No `apply_migration`, no `execute_sql` write, no
`db push` was run. Anything that would require writing to the database is
recorded as a blocker below, not executed.

## Part 1 — the 10 `supabase/migrations_drafts/` sets (the issue's own claim)

Issue #1438 as filed asserted "7 of 9 testable sets are LIVE in production
and none is in `supabase/migrations/`." Re-measured this session,
2026-09-01, against `yeszghaspzwwstvsrioa`:

| draft set | live object tested | verdict (this session) | action taken |
|---|---|---|---|
| `gh1021_add_paid_state` | `payout_approvals.paid_at` + widened status check | **LIVE** — applied as `gh1150_add_paid_state`, version `20260821205432`. SQL body byte-identical to the draft (verified against `schema_migrations.statements`). | Filed `supabase/migrations/20260821205432_gh1150_add_paid_state.sql` (post-apply trace, exact applied text) + rollback/pre-flight copied into `migrations_rollbacks/` under the same timestamp. Original draft left untouched for history. |
| `gh749_add_service_states_to_contractors` | `contractors.service_states` | **LIVE** — version `20260821225742`, exact name match. SQL body byte-identical to the draft. | Filed `supabase/migrations/20260821225742_gh749_add_service_states_to_contractors.sql` (post-apply trace) + rollback/pre-flight copied to `migrations_rollbacks/`. Draft left untouched. |
| `gh1337_claims_referrer_updates_opt_out` | `claims.referrer_updates_opt_out` | **LIVE** — version `20260831124504`, exact name match. **SQL body is NOT byte-identical to the draft** — the applied statement is a condensed re-write (its own header says "applied from [the] full annotated draft ... verbatim (semantics unchanged)", but the comment text and structure differ from the draft file). | Filed `supabase/migrations/20260831124504_gh1337_claims_referrer_updates_opt_out.sql` using the **actual applied text** (read from `schema_migrations.statements`, not the draft). Draft's `_forward.sql` left untouched (fuller annotated version, kept for the tri-state semantics write-up); rollback/pre-flight copied to `migrations_rollbacks/`. |
| `gh916_progressive_partner_status_triggers` | trigger `trg_notify_partner_status_on_bid_submitted` | **LIVE** — version `20260819210920`. **Already had a repo file** (`supabase/migrations/20260819211149_gh916_progressive_partner_status_triggers.sql`, filed before this session) — but that file's own timestamp (`211149`) does not match the live-applied version (`210920`); flagged, not corrected (pre-existing filing, not this reconciliation's SQL). Diffed the already-filed copy against the draft: **not byte-identical** — the filed copy is a post-apply-rebased version with added post-apply verification notes; the draft is the pre-rebase original. | No new forward file needed (already correctly filed as an applied trace). Copied the draft's missing pre-flight doc into `migrations_rollbacks/gh916_progressive_partner_status_triggers_pre-flight.md` (untimestamped, matching the sibling rollback file's existing naming). Draft left untouched. |
| `gh969_hover_rebate_trigger_completion` | trigger `after_claim_completed_rebate` | **LIVE** — version `20260824184631`, exact name match. Rollback for this set already existed in `migrations_rollbacks/` (untimestamped) with **no corresponding forward file anywhere in the repo** — a true orphan. Diffed applied text vs. draft: function/trigger logic identical; the two `COMMENT ON FUNCTION`/`COMMENT ON TRIGGER` string literals were reworded at apply time (draft said "NOT YET APPLIED"; applied text says "applied 2026-08-24, Dustin-approved") — **not byte-identical**. | Filed `supabase/migrations/20260824184631_gh969_hover_rebate_trigger_completion.sql` using the actual applied text. Copied the draft's pre-flight into `migrations_rollbacks/` under the matching timestamp. Pre-existing rollback left untouched. Draft left untouched. |
| `v88_referral_agents_public_directory_optin` | `referral_agents.public_directory_optin` | **LIVE** — but via a **different, already-reconciled migration**: `v101_referral_agents_public_directory_optin` (version `20260808134406`), filed by the prior #385 reconciliation as `supabase/migrations/20260807223000_v101_referral_agents_public_directory_optin.sql`, whose own header explicitly documents it as the re-cut, applied successor to this exact v88 draft. | **No action** — already fully reconciled by issue #385. Moving the v88 draft into `migrations/` now would attempt to add `public_directory_optin` a second time via a second migration file — the hazard called out in this dispatch's work order. Left in place per #385's own instruction ("left in place untouched for historical record; do not delete without also confirming this file superseded them" — confirmed superseded, still not deleted). |
| `gh1070_activity_log_grants_revoke` | `anon` grants on `public.activity_log` | **LIVE (object), but NOT from this draft.** anon has zero privileges on `public.activity_log` (confirmed via `information_schema.role_table_grants`, 2026-09-01) — but the draft's own header says "Status: DRAFT ONLY — Tier 3B. NOT APPLIED", and the migration that actually ran under a #1070 name (version `20260824183229`, name `gh1070_revoke_anon_activity_log` — note the different word order) is a single bare `REVOKE ALL PRIVILEGES ON public.activity_log FROM anon;`, structurally different from and much shorter than this draft's more heavily-annotated proposal. Two independent pieces of #1070 SQL exist; only one was ever applied, and it isn't this one. | Filed `supabase/migrations/20260824183229_gh1070_revoke_anon_activity_log.sql` using the actual applied text (the bare `REVOKE`). Draft left untouched — it must not be represented as "the applied migration" since it demonstrably isn't. No rollback/pre-flight copied (the draft's versions target a different, broader design; copying them under the applied migration's name would misrepresent them as tested against what actually ran). |
| `c4_contractor_pitch_bands` | `contractors.pitch_bands` | **NOT LIVE** — confirmed via `information_schema.columns` (2026-09-01): no such column. | Left untouched. This is the Tier 3B apply-half blocker — see "Blocker" below. Not run. |
| `gh1026_drop_admin_contractor_last_logins` | `public.admin_contractor_last_logins` | **VIEW STILL EXISTS** (confirmed via `information_schema.tables`, 2026-09-01 — `table_type = VIEW`). The `authenticated` role's `SELECT` grant on it has already been revoked live (confirmed via `information_schema.role_table_grants` — `authenticated` retains DELETE/INSERT/REFERENCES/TRIGGER/TRUNCATE/UPDATE but not SELECT), matching the draft's own claim. The `DROP VIEW` itself has not run. Issue #1438 classified this set as "documentation-only... n/a" rather than a live/not-live testable pair — preserved that classification; the substantive access-control fix (the grant revoke) is already in force, and dropping the now-inert view is optional cleanup, not a correctness gap. | Left untouched (matches issue's own classification; not one of the "9 testable" sets). |

**Reconciled 5 of 9 testable draft sets this session** (gh1021/gh1150, gh749,
gh1337, gh969, gh1070) with new post-apply trace files — none of them by
raw-moving the draft (5 of the 7 live sets, including 3 of these 5, turned
out **not** to be byte-identical to what actually ran; see the "not
byte-identical" notes above). 2 were already reconciled by prior sessions
(gh1050, gh916 — pre-flight docs backfilled only). 1 was already reconciled
by issue #385 under a different migration number (v88 → v101). 1 remains
genuinely unapplied (c4, blocker below). 1 is documentation-only by the
issue's own classification (gh1026).

## Part 2 — the population the 10-set frame missed

The CTO's ruling on this issue (issuecomment-5488058121, 2026-09-01)
measured the true population and found the drafts directory is "7 of 109,"
not "7 of 9." Re-measured this session, independently, against the current
`origin/main` tip (`487680b`) and live `yeszghaspzwwstvsrioa`:

```
-- live query (read-only), gh-1438 reconciliation, 2026-09-01
select count(*) from supabase_migrations.schema_migrations;
-- => 139

-- repo file count
ls supabase/migrations/*.sql | wc -l
-- => 70 (before this session's 5 new trace files; 75 after)

-- distinct 14-digit version prefixes among those files
-- => 58 (before this session; 63 after — 5 new trace files add 5 new
--    versions: 20260821205432, 20260821225742, 20260831124504,
--    20260824184631, 20260824183229)
```

Full version-set comparison (Python, `supabase/migrations/*.sql` filenames'
`^\d{14}_` prefix vs. every `version` in
`supabase_migrations.schema_migrations`), computed before this session's 5
new files were added:

```
APPLIED but NO repo file : 109
repo file but NOT APPLIED :  28
```

This matches the CTO's independently-measured 109/28 exactly. After this
session's 5 new trace files, the applied-but-no-file count drops to **104**
(139 total applied − 35 with a repo file, up from 30). The 28
file-but-not-applied count is untouched by this session (all 28 are
timestamp-mismatch artifacts already documented by the prior #385
reconciliation — same migration, filed under a repo timestamp a few minutes
or hours off from the live-applied timestamp — not something this session's
scope (`migrations_drafts/` reconciliation) touched or was asked to touch).

The oldest orphans still run back to `20260423105913 v53_switch_reason_survey`
and include the RLS/SECURITY DEFINER hardening batch the CTO's comment
called out (`fix_security_definer_search_paths`,
`rls_explicit_deny_service_role_only_tables`, `v84_rls_policy_consolidation`,
`v87_referrals_rls_update_scope`) — none of that is touched by this PR. This
document is not a fix for the 104-item gap; it is the up-to-date measurement
of it, so the next session doing this work is not re-deriving the same
numbers from scratch.

## What this does not do (by design, per this dispatch's scope rail)

1. **Does not backfill the 104-item `APPLIED but NO repo file` gap.** The
   CTO's ruling was explicit that the full backfill is not this issue's
   closing condition and should happen "oldest-first, in batches," with the
   three money-path triggers (`apply_referral_commission`,
   `after_claim_completed`, `after_claim_completed_rebate`) as their own
   batch. That is a separate, larger effort than the 5-set drafts-directory
   reconciliation this dispatch scoped.
2. **Does not build the CI reconciliation ratchet** the CTO's amended
   `closes-on` requires (a checked-in baseline manifest + a check that fails
   a PR that widens either gap, seeded from today's 104/28 numbers above).
   That was named in the CTO's ruling as the actual next concrete step and
   is flagged as a follow-up in this PR's issue comment rather than
   attempted blind in this dispatch — see the `Q:` comment on #1438.
3. **Does not apply `c4_contractor_pitch_bands`.** See Blocker below.
4. **Does not touch the 28 `repo file but NOT APPLIED` timestamp-drift
   entries** carried over from the #385 reconciliation, or the recurred
   instance of #385's "Defect 1" (rollback scripts sitting directly in
   `supabase/migrations/` again — e.g. `20260819221010_gh1041_..._rollback.sql`,
   `20260825112956_gh1245_..._rollback.sql`, `20260830170958_gh1253_..._rollback.sql`,
   `20260831113959_..._restamp_rollback.sql`, `20260831125120_gh1387_..._rollback.sql`,
   `20260901114145_gh1425_..._rollback.sql` — all post-date the #385 fix and
   were filed directly into the forward-replay path again). Both are
   incidental findings from this session, reported here per R-156 rather
   than filed as new issues.

## Blocker — Tier 3B, requires Dustin's approval, NOT run

`c4_contractor_pitch_bands` is confirmed **not applied**
(`contractors.pitch_bands` does not exist live, checked 2026-09-01). Exact
DDL, unexecuted, from `supabase/migrations_drafts/c4_contractor_pitch_bands.sql`:

```sql
alter table public.contractors
  add column if not exists pitch_bands jsonb;

comment on column public.contractors.pitch_bands is
  'C4: the contractor''s own priced roof-slope bands and access adders, as HIS rate '
  'card states them. Shape: {"source":"contractor_rate_card","bands":[{"label":..., '
  '"min_over_12":int|null,"max_over_12":int|null,"rate_per_square":numeric|null}], '
  '"two_story_adder":{"label":...,"rate_per_square":numeric}}. Pitch is expressed as '
  'rise over a run of 12. NULL means no rate card on file, and create-docusign-envelope '
  'falls back to the Xactimate-aligned 7/12 threshold. Deliberately NOT a platform '
  'constant: Indy Rooftops prices steep from 5/12 while Xactimate and RoofScope both '
  'use 7/12, and that is a commercial choice each contractor makes.';
```

Not run by this session. If Dustin approves, apply via `migration-author-code`
or a follow-up dispatch with Tier 3B sign-off, then move this draft the same
way the 5 sets above were handled.

## Method (reproducible)

```
# Live applied ledger
select version, name from supabase_migrations.schema_migrations order by version;
select count(*) from supabase_migrations.schema_migrations;

# Live object checks (read-only)
select column_name from information_schema.columns where table_schema='public' and table_name=... and column_name=...;
select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name=...;
select table_name, table_type from information_schema.tables where table_schema='public' and table_name=...;

# Applied statement text (to compare a draft against what actually ran)
select version, name, statements[1] from supabase_migrations.schema_migrations where version = '...';

# Repo file enumeration
ls supabase/migrations/*.sql | xargs -n1 basename | sort
ls supabase/migrations_drafts/
```


## 2026-09-05 addendum — CTO run `cto-2026-09-05T03:07:58Z` (gh-1438 slice)

Live ledger `supabase_migrations.schema_migrations` read 2026-09-05T05:1xZ: **143 rows**.
Repo `supabase/migrations/` distinct 14-digit versions on this branch: **105**.

| direction | before this PR | after this PR |
|---|---|---|
| applied, no repo file | 71 | **70** |
| repo file, not applied (by ledger) | 32 | **32** |

(The CI ratchet's own report reads "105 / 35 (baseline 29)" — it counts against the
frozen 2026-09-01 baseline manifest, not the live ledger; the live numbers above are
the ones conjunct 2 of the amended `closes-on` tracks.)

### Sets touched or recorded this run

| set | live status | repo status after this PR | rule applied |
|---|---|---|---|
| `funnel_abandonment_facts` (gh-1585) | **APPLIED LIVE** 2026-09-04T21:20:48Z via Management API SQL — **no ledger row** (that path never writes `schema_migrations`) | filed `20260904212048_gh1585_funnel_abandonment_facts.sql` — idempotent (`CREATE TABLE IF NOT EXISTS` + `ENABLE ROW LEVEL SECURITY`, zero policies, matching live); rollback in `migrations_rollbacks/` | applied → lives in `supabase/migrations/` under its real applied timestamp; replay-safe because the ledger cannot vouch for it |
| `gh1411_vendor_credit_expected` | APPLIED LIVE, ledger version **20260904224528** | file was `20260903190000_*` (read as never-applied, and its `_rollback.sql` twin sat in the replay path) → **renamed** to `20260904224528_*`; rollback moved to `migrations_rollbacks/` | file carries the real applied version, never the draft's |
| `gh1531_cron_vault_resync` | APPLIED LIVE, ledger version 20260905044823 | already filed under the same version (PR #1680) | no action |
| `claims_status_check` (gh-1532, file `20260904132600_gh1532_claims_status_check.sql`, #1627) | **NOT APPLIED** — `pg_constraint` has no `claims_status_check` on `public.claims` | present in `supabase/migrations/` — **in-repo-but-not-applied**, tier:3b, applies on #1532's R-097 window, NOT by this PR | recorded, not applied (this issue is tier:3a: repo-only) |
| the 10 `migrations_drafts/` sets | unchanged from the table above | unchanged | — |

### The stated rule (unchanged, restated so it is quotable)

Once a migration has been applied to production it lives in `supabase/migrations/`
under the **real applied timestamp from `schema_migrations`** (never the draft's
name or a fresh stamp); rollback and pre-flight companions live in
`supabase/migrations_rollbacks/`; SQL that is written but not applied lives in
`supabase/migrations_drafts/` until it is applied. A migration applied through a
path that bypasses the ledger (Management API SQL, dashboard) must be filed
idempotently, because `db push` will treat its file as pending.

### Residual defects observed, not fixed here (out of this slice)

- 20 `*_rollback.sql` / `*_pre-flight.md` companions still sit inside
  `supabase/migrations/` with a 14-digit prefix (e.g. `20260901132754_gh1304_*_rollback.sql`,
  `20260904132600_gh1532_*_rollback.sql`). Every `_rollback.sql` there is replayed
  FORWARD on a fresh branch — the exact defect `MIGRATIONS-RECONCILIATION-385.md`
  defect 2 documented. Belongs to the backfill/hygiene batches.
- Batch 3 (PR #1604, 70 → 49) — check its merge state; the live count of 71 before
  this PR says it had not landed at measurement time.
