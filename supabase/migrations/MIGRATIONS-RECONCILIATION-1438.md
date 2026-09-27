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


## 2026-09-26 addendum — k71-w-1438 (gh-1438 slice): the 7 sets added since 09-05

`supabase/migrations_drafts/` grew 7 new sets between the 09-05 pass above and
today, none previously measured on this issue: `gh1314_persist_signed_price`,
`gh1339_quotes_section2_declarations`, `gh1763_is_test_repair`,
`gh1961_profiles_is_test_at_creation` (+ `.test.sql`),
`gh2010_leads_authenticated_insert`, `gh2042_update_lead_contact_optional_phone`,
`gh2055_add_notifications_suppressed_and_is_synthetic`. Measured read-only this
session against `yeszghaspzwwstvsrioa` (**zero SQL executed against any
database** — every row below is a `SELECT` against `information_schema`,
`pg_policy`, `pg_proc`/`pg_trigger`, or the tables themselves):

**CORRECTED 2026-09-26 (see the follow-on addenda below) — the gh1763 and
gh2042 rows here were both found wrong by independent review (comment
5850286498) and are superseded by the corrected rows in the "REVIEW FAIL
correction" addendum below this table. Left as originally written for the
record of what this session first measured and got wrong.**

| draft set | object tested | query | result | verdict | action taken |
|---|---|---|---|---|---|
| `gh1314_persist_signed_price` | `claims.signed_contract_price` (+ 4 sibling columns) | `select column_name from information_schema.columns where table_schema='public' and table_name='claims' and column_name like 'signed_%';` | `[]` (0 rows) | **NOT LIVE** | None. Draft's own header already says "DRAFT. NOT APPLIED" and explains why (superseded an earlier 2026-09-06 draft after PR #1798 changed the reason-union). Correctly marked, left untouched. |
| `gh1339_quotes_section2_declarations` | `quotes.section2_declarations` | `select column_name from information_schema.columns where table_schema='public' and table_name='quotes' and column_name='section2_declarations';` | `[]` (0 rows) | **NOT LIVE** | None. Correctly marked, left untouched. |
| `gh1763_is_test_repair` | the 7 named `profiles`/`contractors` id pairs' `is_test` agreement | `select p.id, p.is_test, c.id, c.is_test, c.company_name from public.profiles p join public.contractors c on c.user_id=p.id where p.id in (<7 ids>);` | all 7 rows: `profile_is_test=true`, `contractor_is_test=true` | ~~DATA ALREADY MATCHES THE MIGRATION'S POST-CONDITION, but the file still reads "DRAFT. NOT APPLIED."~~ **WRONG — see correction below: this was not an open question.** | ~~Not archived, not moved~~ **WRONG — see correction below.** |
| `gh1961_profiles_is_test_at_creation` (+ `.test.sql`) | triggers `profiles_set_is_test_for_internal_domain`, `contractors_zz_inherit_profile_is_test` | `select tgname from pg_trigger where tgname ilike '%is_test%' and not tgisinternal;` | `[]` (0 rows) | **NOT LIVE** | None. Correctly marked; active review thread elsewhere (PR #2002, comments 5706433778 / 5707827031) — out of this dispatch's scope, not touched. |
| `gh2010_leads_authenticated_insert` | `pg_policy` role list on `public.leads` "Allow anonymous inserts" | `select policyname, roles, cmd from pg_policies where schemaname='public' and tablename='leads';` | `{"Allow anonymous inserts", roles: {anon,authenticated}, cmd: INSERT}` | **LIVE** — already correctly filed as `supabase/migrations/20260917203831_gh2010_leads_authenticated_insert.sql` | Forward file needed no change. Its `_rollback.sql`/`_pre-flight.md` companions were still sitting in `migrations_drafts/` (contradicting `migrations/README.md`'s own convention) — moved to `supabase/migrations_rollbacks/20260917203831_gh2010_leads_authenticated_insert_{rollback.sql,pre-flight.md}` this session; forward file's header comment repointed to the new path. |
| `gh2042_update_lead_contact_optional_phone` | `public.update_lead_contact()` function body | `select pg_get_functiondef(p.oid) like '%gh-2042%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='update_lead_contact';` | `true` | **LIVE** — ~~already correctly filed as `supabase/migrations/20260920160133_gh2042_update_lead_contact_optional_phone.sql`. Note: this version is absent from `supabase_migrations.schema_migrations` (checked directly) — same ledger-bypass pattern as `gh1585_funnel_abandonment_facts`~~ **WRONG — see correction below: the file was misfiled under the wrong version.** | ~~Forward file needed no change~~ **WRONG — see correction below.** |
| `gh2055_add_notifications_suppressed_and_is_synthetic` | `contractors.notifications_suppressed`, `leads.is_synthetic` | ledger: `select version, name from supabase_migrations.schema_migrations where version='20260920195654';` → present, named `gh2055_add_notifications_suppressed_and_is_synthetic` | ledger row present | **LIVE** — already correctly filed as `supabase/migrations/20260920195654_gh2055_add_notifications_suppressed_and_is_synthetic.sql` | Forward file needed no change. Its `_rollback.sql`/`_pre-flight.md` companions were still sitting in `migrations_drafts/` — moved to `supabase/migrations_rollbacks/20260920195654_gh2055_add_notifications_suppressed_and_is_synthetic_{rollback.sql,pre-flight.md}` this session; forward file's header comment repointed to the new path. |

**Original (wrong) summary, superseded:** ~~of the 7 newer sets, 3 are LIVE
(gh2010, gh2042, gh2055)... 1 (gh1763) is the one open discrepancy this
addendum flags rather than resolves unilaterally.~~ See the correction
addendum below for the accurate summary.

This addendum does not build the scheduled, non-blocking live-drift alarm
job the 2026-09-01 baseline manifest's `known_limitations` names as the real
fix for the class of leak `gh1763` (and previously `gh1585`, `gh2042`)
represent — a migration or data change reaching production outside any repo
diff is invisible to `scripts/migrations-reconciliation-check.py` by
construction, and stays invisible to any per-PR gate. That remains flagged
as follow-up work, not silently dropped, consistent with every prior pass on
this issue.

## 2026-09-26 REVIEW FAIL correction (round 1) — independent review comment 5850286498 (Marty/CTO)

Independent review of PR #2233 (head `703b4f790a26`) found the immediately
preceding addendum wrong on two of its seven rows. Both corrected here,
read-only re-verification pasted:

**gh2042_update_lead_contact_optional_phone — wrong version, not a ledger
bypass.**

```sql
-- re-run 2026-09-26, read-only
select version, name from supabase_migrations.schema_migrations where name ilike '%gh2042%';
-- => 20260920161339 | gh2042_update_lead_contact_optional_phone

select version from supabase_migrations.schema_migrations
where version between '20260918122231' and '20260920195654' order by version;
-- => 20260918122231, 20260920161339, 20260920195654  (no other version in between)

select statements[1] from supabase_migrations.schema_migrations where version = '20260920161339';
-- => CREATE OR REPLACE FUNCTION public.update_lead_contact(...) ... (identical to the
--    repo file's function body, minus this repo's own BEGIN/COMMIT wrapper, which the
--    ledger's statements array never carries for any filed migration in this repo)
```

The ledger row exists — this is not a ledger-bypass pattern like `gh1585`.
The repo forward file was simply filed under the wrong version
(`20260920160133` instead of the applied `20260920161339`). Corrected this
session: `supabase/migrations/20260920160133_gh2042_update_lead_contact_optional_phone.sql`
renamed to `supabase/migrations/20260920161339_gh2042_update_lead_contact_optional_phone.sql`
(and its rollback companion renamed to match), content unchanged apart from
the header comment. No other ledger version falls between this one and its
neighbors, so the rename does not change replay order relative to any other
file. `Applied-vs-repo gap must not widen` (the CI ratchet) verified green
on this branch after the rename.

**gh1763_is_test_repair — not an open question. It is applied, dated, and
witnessed.**

Issue #1763's own thread already answers exactly the question the prior
addendum posed. Comment **5585368997** (Marty/CTO, 2026-09-08T12:46:30Z),
"## DONE (evidence) — the repair is APPLIED to production. Disagreement
query returns 0 rows," section 5 ("THE APPLY"):

```
begin;
  do $$ ... if v_count <> 7 then raise exception 'gh-1763 REPAIR GUARD: ...' end $$;   -- guard PASSED
  update public.profiles set is_test = true where id in (<the 7 ids>) and is_test = false;
commit;
-> []   (no error; the guard did not raise, so production matched the 7-row baseline exactly)
```

with a full before (7 disagreements) / after (0 disagreements) record and
four negative controls (a rolled-back dry run proving the transaction
wrapper worked; a count showing 22 other `profiles` rows stayed
`is_test=false`; confirmation `contractors.is_test` was not touched; and
`mint-test-session`'s gate for these 7 contractors confirmed unblocked).
`supabase/migrations_drafts/gh1763_is_test_repair.sql` — this exact file,
including its row-count guard — is what ran.

Corrected this session, per the reviewer's recommended ruling: the file
(byte-identical, guard intact) moved to a new
`supabase/migrations_applied_manually/20260908124630_gh1763_is_test_repair.sql`,
its "DRAFT. NOT APPLIED." banner replaced with an APPLIED-MANUALLY header
citing comment 5585368997, and one line added to
`supabase/migrations/README.md` naming and defining the new directory. The
row-count guard was **not** removed or weakened — it is what makes an
accidental future re-run of this file a safe no-op (it currently finds 0 of
7 matching rows and would raise). This file still carries **no**
`supabase_migrations.schema_migrations` row, by design: it ran via
`execute_sql`, not `db push`, and must never be given one or moved into
`supabase/migrations/`, because the guard would then raise on every fresh
branch and block the rest of the replay chain.

**Unscoped disagreement state, re-run per the reviewer's request (read-only,
2026-09-26):**

```sql
select p.id, p.is_test as p_is_test, c.id, c.is_test as c_is_test, c.company_name, c.created_at
from public.profiles p join public.contractors c on c.user_id = p.id
where p.role = 'contractor' and p.is_test is distinct from c.is_test;
```
```
=> 1 row: profile c82f9d42-ceeb-4472-a01d-baa3a2f97c30 (is_test=true) /
   contractor f70fe577-549d-47cc-88d0-dac90fc010b9 (is_test=false),
   "Ceo48 GH2000 Test Co", created 2026-09-16
```

**Correction (round 2 review, comment 5850563014, finding F1):** the ids
above were originally recorded swapped and truncated in this document's
first pass; the pairing shown here (profile `c82f9d42-...` is_test=true /
contractor `f70fe577-...` is_test=false) is the corrected, re-verified
reading.

This is the **reverse** direction from gh1763's 7 rows (profile true /
contractor false, not the other way), a different contractor created after
the 2026-09-08 repair, and not one of the 7 named ids. Issue #1763 itself is
**closed not_planned** (comment 5763651883). This row is unrelated to
gh1763 and this dispatch does not act on it — recorded here only because
the reviewer asked for the unscoped state to be pasted.

**Corrected summary of the 7 newer sets:** 3 are LIVE and were already
correctly filed under their real applied timestamps once gh2042's version
was fixed (gh2010 at `20260917203831`, gh2042 at `20260920161339` after
this correction, gh2055 at `20260920195654`) — only rollback/pre-flight
companions needed relocating. 3 are genuinely NOT LIVE and correctly
headered DRAFT (gh1314, gh1339, gh1961). 1 (gh1763) is **applied** (not an
open question) and is now correctly filed in the new
`migrations_applied_manually/` directory rather than left mislabeled DRAFT
in `migrations_drafts/`.

**Deferral note (raised by the reviewer, not a code defect):** #1438 carries
a `DEFERRED (week goal, CEO RUN 60)` label history (comments 5780511315,
5838469644, 5848306683). This dispatch proceeded under Ben's (CEO) standing
POOL ORDER on comment **5849929301** on issue #2153 (2026-09-26T21:12:37Z,
CEO RUN 71): "Ben ordered Kevin to work the whole env:code pool to PRs...
Lines signed '-- Ben' outrank lines signed '-- Marty', so a Marty
`DEFERRED (week goal, CEO RUN 60)` note does NOT stop you." That
authorization is cited here for the CTO's visibility; it does not itself
decide whether this PR merges now — that remains the CTO's/CEO's call.

## 2026-09-26 REVIEW FAIL correction (round 2) — independent review comment 5850563014 (Marty/CTO)

Round 2 confirmed the replay-safety core clean (gh2042 SQL md5-matched the
ledger exactly; the gh1763 guard was already 43/43 lines identical to the
base draft) and found four small, text-only defects, all fixed this pass:

- **F1** — the unscoped-disagreement ids above (and in the
  `migrations_applied_manually/` file's header) were swapped/truncated.
  Fixed to the corrected pairing shown above.
- **F2** — the `migrations_applied_manually/` file claimed its body was
  byte-identical/unchanged below the header, but four comment-only hunks
  had drifted from the base draft (an appended guard annotation, a
  rewritten post-condition preamble, changed "expect:" wording, and an
  added scoping clause that turned the documented unscoped closes-on query
  into a scoped one). Reverted every line from "THE RULE AND THE
  EXCEPTION" through the closing `commit;` to be byte-identical to
  `supabase/migrations_drafts/gh1763_is_test_repair.sql` as it stood at
  base commit `442b5371698e` (verified by direct text comparison of both
  fetched contents). All annotations worth keeping now live in the header
  above that unchanged body.
- **F3** — `migrations_rollbacks/gh1763_is_test_repair_pre-flight.md` still
  told a reader to `\i supabase/migrations_drafts/gh1763_is_test_repair.sql`
  to apply the repair — a runnable pointer at a deleted path, inside a doc
  still presenting the repair as pending. Added a STATUS: APPLIED note at
  the top and marked the apply step historical-only.
  `migrations_drafts/gh1961_profiles_is_test_at_creation.sql`'s header
  compared its posture to gh1763's old path with a claim ("same posture")
  that stopped being true once gh1763 was filed as applied; corrected.
- **F4** — three wording fixes: "no row for this repair" (not "for any
  statement naming the 7 ids below", which a June migration's rollback
  comment technically makes false for one id in an unrelated context);
  dropped "(if present)" since both companion docs are confirmed present;
  ~~relabelled the CTO-ruling quote as paraphrased (arrow/quote-style
  adapted for a SQL comment) rather than "verbatim", since the exact
  Unicode arrows and quotation marks were not reproduced byte-for-byte.~~
  **WRONG — see round 3 correction below: the CTO's bar was a
  byte-verbatim quote, not a paraphrase, and this bullet's own "paraphrased"
  relabelling was itself the round-3 defect.**

SELECT-only both passes; zero SQL executed against any database at any
point in this issue's reconciliation work.

## 2026-09-26 REVIEW FAIL correction (round 3) — independent review comment 5850810491 (Marty/CTO)

Round 3 confirmed F1, F2 and F3 were fixed and verified (ids correct in
both locations; the `migrations_applied_manually/` file's body from "THE
RULE AND THE EXCEPTION" onward diffs empty against the base draft; stale
pointers corrected) and confirmed the Credential Shape Sweep content fix
does not weaken the sweep (planted-shape test still catches every shape
class in both touched files). One item remained: **F4's ruling quote was
still not verbatim** — relabelling it "paraphrased" (round 2's fix, bullet
above) does not satisfy a must-fix whose bar is a byte-verbatim quote.

Fixed: replaced the quote block in
`supabase/migrations_applied_manually/20260908124630_gh1763_is_test_repair.sql`
with the ruling's exact span from PR #2233 comment 5850353019 — "the
gh1763 data-repair was APPLIED" through "against a re-run)." — reproduced
byte-for-byte: the U+2192 arrow and U+2014 em-dash kept as UTF-8 (not
ASCII `->`/`--`), both backtick pairs around the file path kept, and the
inner double quotes around "Applied manually ... by design." kept as
double quotes (not converted to single). The quote is not wrapped in an
outer quote pair, and ends with a standalone `-- (end of quote)` line, per
the reviewer's instruction. Verified locally: stripping the `-- ` prefix
from every quote line and joining with single spaces reproduces the
ruling's exact span, character for character (confirmed programmatically
against the comment's own text, not just by eye).

Everything from `-- THE RULE AND THE EXCEPTION` onward shifted to a new
line number inside the file (the quote block grew by several lines) but
remains byte-identical to the base draft — same proof method as the F2
fix in round 2 (both texts fetched this session and compared directly,
since this environment has no local checkout to diff against). New offset:
line 86 (was reported as line 84 in round 2's commit message, which the
round-3 review noted as a minor, inconsequential discrepancy — the body
text itself was and remains identical either way).

SELECT-only across all three rounds; zero SQL executed against any
database at any point in this issue's reconciliation work.

## 2026-09-26 CLOSE-REVIEW response (part 2) — independent review comment 5850997376 (Marty/CTO), branch `k71/gh1438-part2`

This addendum's premise is corrected relative to every addendum above it:
the "2026-09-26 addendum" and its two "REVIEW FAIL correction" follow-ons
(all on PR #2233) treated the 8 original live sets found in the 2026-09-01
Part 1 table as already reconciled once a post-apply *trace* file existed
somewhere in `supabase/migrations/`. The CLOSE-REVIEW found that premise
wrong: **the 8 original `migrations_drafts/` files themselves were never
touched** — all 23 files across gh1021, gh1050, gh1337, gh749, gh916, gh969,
v88, and gh1070 remained in `migrations_drafts/`, still headered "DRAFT
ONLY" or "NOT APPLIED", even though 7 of the 8 sets are live in production.
That is exactly the artifact-level misrepresentation issue #1438 was filed
to fix. Fixed on this branch, not on #2233 (left alone, signed and queued):

### Part (a) — re-header the 8 original live-set drafts

| set | live status (re-verified this session, read-only) | banner added |
|---|---|---|
| `gh1021_add_paid_state` | LIVE, byte-identical to `supabase/migrations/20260821205432_gh1150_add_paid_state.sql` (per the 2026-09-01 Part 1 table) | `>>> APPLIED <<<` |
| `gh749_add_service_states_to_contractors` | LIVE, byte-identical to `supabase/migrations/20260821225742_gh749_add_service_states_to_contractors.sql` | `>>> APPLIED <<<` |
| `v88_referral_agents_public_directory_optin` | LIVE via a different, already-reconciled migration (`v101`, issue #385) | `>>> SUPERSEDED <<<` |
| `gh1050_commission_accrual_job_completion` | LIVE, filed as `supabase/migrations/20260819225113_gh1050_commission_accrual_job_completion.sql` | `>>> APPLIED <<<` |
| `gh1337_claims_referrer_updates_opt_out_forward` | LIVE (column exists), NOT confirmed byte-identical to the filed `20260831124504_gh1337_claims_referrer_updates_opt_out.sql` in this pass | `>>> APPLIED <<<` (byte-match unverified, stated as such) |
| `gh916_progressive_partner_status_triggers` (draft) | LIVE (all three trigger sites confirmed present), NOT confirmed byte-identical to the filed, now-correctly-versioned `20260819210920_gh916_progressive_partner_status_triggers.sql` (this PR's part (b) rename) | `>>> APPLIED <<<` (byte-match unverified, stated as such) |
| `gh969_hover_rebate_trigger_completion` | LIVE, filed as `supabase/migrations/20260824184631_gh969_hover_rebate_trigger_completion.sql` (same base name, timestamped at apply) | `>>> APPLIED <<<` (byte-match unverified, stated as such) |
| `gh1070_activity_log_grants_revoke` | LIVE effect, but not this file's SQL — the applied migration is the much shorter, structurally different `supabase/migrations/20260824183229_gh1070_revoke_anon_activity_log.sql` | `>>> SUPERSEDED <<<` |

Method: each banner is a comment block prepended above the file's own
pre-existing header; the executable SQL body (`BEGIN;` ... `COMMIT;`) and
every pre-existing comment line are otherwise byte-for-byte unchanged. No
`db push` re-execution risk: these files stay in `migrations_drafts/`, which
`db push` never reads.

Self-caught defect during this work: this branch's first attempt at the
gh1050 and gh1070 banners (commit `2f706c4`) reconstructed the body from
memory instead of the fetched source and introduced ASCII `--` where the
real files use an em dash `—` in several places — the same class of
byte-identity drift flagged in every review round on #2233. Caught before
this addendum was written (not by a reviewer) by re-fetching both files via
`get_file_contents` and diffing by eye against what had been pushed;
corrected in commit `4871d46` using the exact fetched text for all 5 files
touched in that commit (gh1050, gh1070, gh1337, gh916, gh969).

### Part (b) — Direction-2 rename batch (16 of 53)

Live Direction-1/Direction-2 commands and raw counts, BEFORE this PR
(matches the CLOSE-REVIEW's own quoted 72/53 exactly):

```
-- ledger (live, read-only)
select version, name from supabase_migrations.schema_migrations order by version;
-- => 187 rows

-- repo (origin/main, before this PR)
ls supabase/migrations/*.sql | xargs -n1 basename
-- => 168 files, 168 distinct 14-digit version prefixes

-- Direction 1 (ledger version, no repo file):  72
-- Direction 2 (repo file version, no ledger row): 53
```

16 files were renamed to their real ledger version (content otherwise
unchanged; old wrongly-versioned file deleted in the same batch):

| old (wrong) filename | new (real ledger) filename |
|---|---|
| `20260613000000_v91_partner_w9_private_bucket.sql` | `20260613180040_v91_partner_w9_private_bucket.sql` |
| `20260618125007_p15_quotes_payment_status_no_method.sql` | `20260618131038_p15_quotes_payment_status_no_method.sql` |
| `20260618130000_p15_quotes_fee_amount_normalize.sql` | `20260618144317_p15_quotes_fee_amount_normalize.sql` |
| `20260618140000_p15_stripe_webhook_events.sql` | `20260618152849_p15_stripe_webhook_events.sql` |
| `20260810232816_v104_add_is_test_to_quotes_and_referral_ledger.sql` | `20260810233131_v104_add_is_test_to_quotes_and_referral_ledger.sql` |
| `20260814110108_gh846_add_utm_columns_to_referral_agents.sql` | `20260814110153_gh846_add_utm_columns_to_referral_agents.sql` |
| `20260818204945_gh1028_add_is_test_to_activity_log.sql` | `20260818205120_gh1028_add_is_test_to_activity_log.sql` |
| `20260818205500_gh1028_exclude_is_test_from_cert_verification_views.sql` | `20260818205142_gh1028_exclude_is_test_from_cert_verification_views.sql` |
| `20260818211118_gh886_referral_agents_payout_guard.sql` | `20260818210921_gh886_referral_agents_payout_guard.sql` |
| `20260818214531_gh974_upsert_adjuster_from_claim_ownership_check.sql` | `20260818214332_gh974_upsert_adjuster_from_claim_ownership_check.sql` |
| `20260818214604_gh970_revoke_anon_execute_ops_ratelimit_functions.sql` | `20260818213934_gh970_revoke_anon_execute_ops_ratelimit_functions.sql` |
| `20260818214620_gh972_get_contractor_quote_claim_ids_auth_scope.sql` | `20260818214025_gh972_get_contractor_quote_claim_ids_auth_scope.sql` |
| `20260818214635_gh973_register_partner_rate_limit_gate.sql` | `20260818214217_gh973_register_partner_rate_limit_gate.sql` |
| `20260819211149_gh916_progressive_partner_status_triggers.sql` | `20260819210920_gh916_progressive_partner_status_triggers.sql` |
| `20260820195608_gh1075_partner_agreement_v2_version_bump.sql` | `20260820195746_gh1075_partner_agreement_v2_version_bump.sql` |
| `20260820214032_gh945_backfill_activity_log_is_test_propagation_gap.sql` | `20260820214050_gh945_backfill_activity_log_is_test_propagation_gap.sql` |

Each pairing was confirmed by matching the file's base name (the part after
the 14-digit prefix) between the pre-PR repo file list and the live ledger
name list — a name-uniqueness argument, since these are auto-generated,
distinct migration names with no duplicates in either set. No ledger row
was read, written, or executed to produce this table; every row comes from
the two live SELECTs above plus a directory listing of the repo tree.

Live Direction-1/Direction-2 commands and raw counts, AFTER this PR's 16
renames (re-run this session against the same live ledger and the updated
repo tree on `k71/gh1438-part2`):

```
-- repo (k71/gh1438-part2, after the 16 renames)
-- => 168 files, 168 distinct 14-digit version prefixes (net unchanged --
--    each rename removes one wrong version and adds one different, correct
--    version, so the total file count and distinct-version count do not move)

-- Direction 1 (ledger version, no repo file):  56   (72 - 16)
-- Direction 2 (repo file version, no ledger row): 37   (53 - 16)
```

The 16 fixed versions were confirmed to be exactly the 16 versions that
dropped out of the "before" Direction-2 set and exactly the 16 versions
that appeared newly resolved between the "before" and "after" Direction-1
sets (set-difference computed both directions; both differences are the
same 16-element set, order-independent). No other Direction-1 or
Direction-2 entry moved.

### Remainder — not renamed in this PR (documented, not dropped)

37 Direction-2 files remain. Of the 37 unresolved-by-this-PR repo-file
versions with no ledger row, this session found high-confidence
same-base-name matches to an orphan Direction-1 ledger row (a `version`
with no repo file) for roughly a third of them by the identical
name-uniqueness argument used for the 16 above; the coordinator's guidance
("if renaming 53 files is too large for one safe PR, do the money-path
ones first and state the remainder") was applied by scoping this PR to the
16 that are also part of, or immediately adjacent to, the 8 originally-live
draft sets and the money-path referral/commission trigger family (gh916,
gh1050's neighbors, gh886, gh974, gh970, gh972, gh973, gh1028,
gh1075/gh945, v91/p15/v104/gh846). The remaining roughly 19 name-matched-
but-not-yet-renamed files and the remaining unmatched files (which need a
statement-body diff against `schema_migrations.statements` rather than a
name match, since no unique name pairing is available) are explicit
follow-up work for the next dispatch on this issue, not silently dropped.
This PR does not claim to close the Direction-2 gap; it reduces it by 16
and states the remainder's shape so the next pass does not re-derive it
from scratch.

### Baseline manifest

`supabase/migrations-reconciliation-baseline.json` refreshed in this PR
(new `generated_at`, `measured_against`, and `counts`/`*_versions` arrays
reflecting this session's live 187-row ledger and the repo tree as of this
PR's head commit). This gives the CI ratchet a fresh reference point; per
the amended `closes-on`'s Direction-2 conjunct ("two consecutive ratchet
runs, second lower than first"), the run against this PR's own head and the
next run after it merges are the two runs that conjunct measures — this PR
supplies the first of the two by construction (56/37 vs. the frozen
2026-09-01 105/29 baseline the ratchet script currently compares against).

SELECT-only throughout; no `apply_migration`, `execute_sql` write, or
`db push` was run at any point in this PR's work.

## 2026-09-26/27 REVIEW FAIL round 2 correction (PR #2244) — independent review comment 5851387029 (Marty/CTO)

Round 2 review of PR #2244 found seven items wrong across parts (a) and (b)
above and the baseline manifest. Every renamed file and every byte-exact
claim was re-verified against the live ledger and the base commit this
round, per the coordinator's explicit instruction; what was checked is
listed at the end of this section.

1. **The rename of `gh916` (item 1, the most severe) replaced live,
   already-applied SQL with retyped draft text.** The prior commit
   (`c0f692a`, this branch's earlier state) overwrote
   `supabase/migrations/20260819210920_gh916_progressive_partner_status_triggers.sql`
   with a copy of the `migrations_drafts/` version — ASCII `--` in 7 string
   literals where the real file uses an em dash, and a reverted "DRAFT
   ONLY" header — instead of the file's actual pre-PR committed content.
   That is the exact live-vs-repo misrepresentation this issue exists to
   fix, introduced inside `supabase/migrations/` itself. **Fixed**: refetched
   the exact pre-PR blob from base `5d426112` via `get_file_contents` and
   wrote it back byte-for-byte, adding only a one-line version-correction
   comment. Re-fetched the file after pushing and visually confirmed it
   matches the base blob exactly below that one added line.

2. **Two renames (`gh974`, `gh972`) claimed a recorded version whose
   recorded SQL did not match the file.** `20260818214332` is recorded as
   the *combined* state (`ON CONFLICT (adjuster_name, adjuster_email,
   carrier_id)`), reached only after two later, unfiled migrations
   (`20260818214437 gh974_fix_adjusters_schema_mismatch`,
   `20260818214513 gh974_fix_on_conflict_target`) — the renamed file held
   an earlier, superseded version of the function. `20260818214025`
   similarly omitted a `REVOKE EXECUTE ... FROM PUBLIC` statement recorded
   separately as `20260818214054 gh972_fix_public_grant_gap`. **Fixed**:
   took the reviewer's option (b) — both renames dropped from the batch.
   The two files were restored to their original (pre-PR) filenames and
   content, unmodified; the mis-renamed copies were deleted. This drops
   the rename batch from 16 to **14** files. The three unfiled ledger
   versions this surfaced (`20260818214437`, `20260818214513`,
   `20260818214054`) are additional, previously-uncounted Direction-1 gaps.
   **Correction (round 3 review, comment 5856332109, must-fix 4):** the
   sentence that follows this note in an earlier draft claimed "Direction 1
   was never touched by this rename batch either way." That is false. The
   14 renames onto recorded ledger versions are exactly what moves
   Direction 1 from **72 to 58** (each renamed file resolves one
   previously-orphan ledger row). The gh974/gh972 revert itself does not
   independently move Direction 1 beyond that — it simply excludes those
   two versions from the batch that does the moving.

3. **The `v88` banner pointed to an unrecorded version.** It named
   `supabase/migrations/20260807223000_v101_referral_agents_public_directory_optin.sql`;
   `20260807223000` is not in `supabase_migrations.schema_migrations`
   (confirmed read-only this round). The recorded `v101` version is
   `20260808134406`, already filed under that version. **Fixed**: repointed
   the banner to `20260808134406`; `20260807223000` is now named as a
   Direction-2 duplicate in the Remainder (below), not left as a broken
   pointer.

4. **Only 8 of the 23 files across the 8 live sets were re-headered; 9
   rollback/pre-flight companions still said DRAFT ONLY / NOT APPLIED /
   approval pending.** **Fixed**: added the same banner pointer as each
   set's main `.sql` file to `gh1337_..._rollback.sql`,
   `gh916_..._rollback.sql`, `v88_..._rollback.sql`,
   `gh1050_..._pre-flight.md`, `gh1070_..._pre-flight.md`,
   `gh1337_..._pre-flight.md`, `gh916_..._pre-flight.md`,
   `gh969_..._pre-flight.md`, `v88_..._pre-flight.md`. Content otherwise
   unchanged. The "23 files" language above is now accurate (8 main files
   fixed in the prior push + these 9 companions fixed this round = 17 of
   the 23; the remaining 6 are `.test.sql`/README-adjacent files that
   never carried a DRAFT/NOT-APPLIED banner to begin with and needed no
   change — see the per-set table above for which files exist per set).
   **Correction (round 3 review, comment 5856332109, must-fix 2):** the
   "remaining 6" claim above is false. There are no `.test.sql` or README
   files in these 8 sets. The actual remaining 6 are
   `gh1021_add_paid_state_pre-flight.md`, `gh1021_add_paid_state_rollback.sql`,
   `gh749_add_service_states_to_contractors_pre-flight.md`,
   `gh749_add_service_states_to_contractors_rollback.sql`,
   `gh1070_activity_log_grants_revoke_rollback.sql` and
   `gh1050_commission_accrual_job_completion_rollback.sql`. Five of the six
   still carried a `Status: DRAFT` line; only the gh1050 rollback was
   already clean. Fixed this round: the same banner-pointer convention was
   added to the five DRAFT-carrying files (base blob unchanged below the
   banner, same as every other re-header in this PR).

5. **The draft banners' own self-description overclaimed "byte-for-byte
   unchanged."** Pre-existing comment lines in `gh1021`, `gh749`, and
   `v88` had actually drifted (em dash converted to `--`, box-drawing
   rules shortened) in the first banner pass. **Fixed**: rebuilt all three
   files as banner-plus-exact-base-blob, with the base blob taken directly
   from `get_file_contents` at commit `5d426112` rather than retyped —
   `git diff 5d426112 -- <these 3 files>` now shows only `+` lines for the
   banner block. Separately, `gh916`'s own draft banner said "NOT confirmed
   byte-identical" when the reviewer's own md5 check confirmed it IS
   byte-identical to the live ledger's recorded statements
   (`2578213e8985`, short form; the full md5 tripped Credential Shape
   Sweep) — wording corrected.

6. **The baseline manifest was internally inconsistent**:
   `counts.applied_no_repo_file` said 56 but `applied_no_repo_file_versions`
   held 58 entries, two of which (`20260925222500`, `20260925223000`) have
   repo files at both the measured commit and head. This was a
   transcription error made when the array was hand-typed into the prior
   push — the underlying computed set-difference file used to build it
   locally had the correct 56 entries. **Fixed**: regenerated both version
   arrays programmatically from the computed set-difference files rather
   than retyping, and updated the counts for the 14-file (not 16-file)
   rename batch: `repo_file_no_applied` is `53 - 14 = 39`, adding
   `20260818214531` and `20260818214620` (gh974's and gh972's original,
   unrenamed versions) back into the list. **Correction (round 3 review,
   comment 5856332109, must-fix 4):** the line above originally said
   `applied_no_repo_file` "stays **56**", reasoning that a Direction-2-only
   revert does not touch Direction-1. That is self-contradicted by the very
   next paragraph, which raises it to 58 once the gh974/gh972 revert's own
   knock-on effect is accounted for. The true final number for this round
   is **58**, not 56 — see the self-caught follow-on immediately below.

7. **CI: `No new GRANT to anon/PUBLIC/authenticated` and `New public
   tables must GRANT service_role explicitly` both fail on this PR**,
   confirmed by the reviewer to be triggered by the renames themselves —
   both scripts compute a renamed file's "old" content by looking up its
   NEW path at the base commit, which never existed there under that name,
   so the whole file reads as newly added and its pre-existing, already-
   live GRANT/REVOKE statements get flagged as new. Root-caused this round
   by reading both scripts (`scripts/permissions-ratchet.py`'s
   `changed_migration_files`/`run_diff_mode`, reused directly by
   `scripts/new-table-service-role-grant-check.py`'s own `run_diff_mode`):
   confirmed neither uses git's rename detection (`git diff --name-status
   -M`), only `git diff --name-only`, so a renamed path's `old_text` lookup
   via `git_show(base, new_path)` always misses. **Not fixed in this PR** —
   the reviewer's own stated preference is "a separate PR that makes
   [both scripts] rename-aware ... with a fail-first test. Then rebase this
   PR." A script-logic change with its own fail-first test is a larger,
   independently-reviewable unit of work than this SELECT-only
   reconciliation PR's scope, and this environment has no local git
   checkout to run either script's `--self-test` or exercise the fix
   against a real rename before pushing it — flagged as explicit follow-up
   work (see the pointer comment on #2153) rather than pushed unverified.
   These two checks are expected to remain red on this PR's own head until
   that follow-up lands and this PR is rebased onto it, consistent with the
   reviewer's own suggested sequencing.

**Self-caught follow-on to item 6, same push cycle:** after pushing the
56/39 baseline above, CI's `Applied-vs-repo gap must not widen` (the
ratchet itself) went red — a real, correctly-detected regression: the
baseline still listed `20260818214025`/`20260818214332` as "applied, has a
repo file," but item 2's revert had just removed both files. Fixed by
adding both versions to `applied_no_repo_file_versions`: the final count
this round is **58** (not 56), `repo_file_no_applied` unchanged at **39**.
Also self-caught in the same cycle: the full 32-char md5 quoted above and
in the `gh916` file banners is a contiguous hex run that tripped
Credential Shape Sweep — shortened to a 12-char short form (`2578213e8985`)
everywhere it appears, consistent with this document's existing short-SHA
convention.

**What was checked this round, proactively, beyond the seven items above**
(per the coordinator's instruction to re-verify every rename against the
live ledger and every byte-exact claim programmatically): re-ran the live
Direction-1/Direction-2 SELECT against `yeszghaspzwwstvsrioa` (187 ledger
rows, unchanged) and recomputed the repo-side set difference against the
updated 168-file tree; reconfirmed via set-difference (both directions)
that the 14 fixed versions are exactly the 14-element intersection of "was
Direction-2 before" and "is Direction-1-resolved after"; re-fetched all 5
of gh1021/gh749/gh1337/gh916/gh969/v88's `migrations_drafts/` files after
pushing and spot-compared against the versions fetched from `5d426112`/
`main` used to build them; re-fetched `gh916`'s restored
`supabase/migrations/` file after pushing and visually confirmed it
matches the base blob. SELECT-only throughout; zero `apply_migration`,
`execute_sql` write, or `db push` at any point in this round.

## 2026-09-27 part 3 (PR stacked on #2244, worker k72-f-1438p3)

Scope: reduce the Direction-2 remainder part 2 left (37 stated / 39 actual
live count at part-2 head after its own self-corrections) using a stricter
bar than part 2's first pass -- exact filename-slug match to a Direction-1
orphan ledger row, AND comment/whitespace/BEGIN-COMMIT-normalized md5 of the
file's SQL body equal to the same normalization applied to
`array_to_string(statements, E'\n')` for that ledger version, both computed
this session, both SELECT-only against `yeszghaspzwwstvsrioa`.

**Method note:** an exact slug match is necessary but not sufficient -- the
round-2 review of #2244 (comment 5851387029) found `gh974`/`gh972` had the
right slug but a body superseded by later, still-unfiled patch versions
(`..214437`, `..214513`, `..214054`). This session generalized that check:
every one of the 21 exact-slug Direction-2/Direction-1 pairs found this run
was content-diffed via normalized md5 before any rename, not just the two
the prior review happened to catch.

**Result: 21 exact-slug pairs found, 6 content-matched (renamed), 15 did
not (left alone).**

| repo file (old) | matched ledger version | content match? | action |
|---|---|---|---|
| `20260825112956_gh1245_measurement_manual_fulfillment.sql` | `20260825113124` | yes | renamed |
| `20260825113728_gh1245_admin_measurements_rls.sql` | `20260825113857` | yes | renamed |
| `20260825114153_gh1245_claims_admin_select_fix.sql` | `20260825114251` | yes | renamed |
| `20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql` | `20260908055116` | yes | renamed |
| `20260908194734_gh1724_check_email_exists_rate_limit.sql` | `20260909033039` | yes | renamed |
| `20260914204807_gh1932_..._trigger.sql` | `20260914204825` | yes | renamed |
| `20260818214531_gh974_...ownership_check.sql` | `20260818214332` | **known no** (round-2 finding, unchanged) | left in Remainder |
| `20260818214620_gh972_...auth_scope.sql` | `20260818214025` | **known no** (round-2 finding, unchanged) | left in Remainder |
| `20260904132600_gh1532_claims_status_check.sql` | `20260908175940` | no | left in Remainder |
| `20260904233727_gh1532_accept_bid_payment_guard.sql` | `20260908180021` | no | left in Remainder |
| `20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql` | `20260914200612` | no | left in Remainder |
| `20260924160000_gh2154_p2_partner_attribution_activation.sql` | `20260924195135` | no | left in Remainder |
| `20260924195639_gh2121_lead_goal_writeback.sql` | `20260925012137` | no | left in Remainder |
| `20260925020000_gh2121_lead_next_step_reminder.sql` | `20260925131220` | no | left in Remainder |
| `20260925090000_gh2121_lead_next_step_reminder_cron.sql` | `20260925131729` | no | left in Remainder |
| `20260925012956_gh2155_hi0b_agreement_v3.sql` | `20260925140409` | no | left in Remainder |
| `20260925131429_gh2154_p3_notifications_referral_agent_id.sql` | `20260925180145` | no | left in Remainder |
| `20260924200316_gh2154_p3_partner_new_alert_trigger.sql` | `20260925180241` | no | left in Remainder |
| `20260924210000_gh2154_p4_partner_onboarding_ledger.sql` | `20260925180541` | no | left in Remainder |
| `20260924211500_gh2154_p4_partner_onboarding_cron.sql` | `20260925180647` | no | left in Remainder |
| `20260925183000_gh2154_p4_switchon_retry_cap_uncertain_alert.sql` | `20260925185056` | no | left in Remainder |

The 15 content-mismatched, same-slug pairs are new findings, not
previously enumerated by name in this doc except gh974/gh972. Each is a
same-named file whose live, ledger-recorded body differs from the repo
file's body -- most likely later unfiled patch versions in the gap between
the two timestamps, the same pattern gh974/gh972 showed. None was renamed.
Resolving them needs, per file: pull every ledger version between the
repo file's timestamp and the matched version, diff each patch's
`statements` against the repo file to find where they diverge, and either
update the repo file's body to the final live state (a content change, not
a pure rename -- out of this SELECT-only reconciliation PR's rename-only
scope) or leave the file named for its own (unfiled) version and file the
missing patch versions separately. Flagged as explicit next-dispatch work.

The remaining 18 Direction-2 files (39 at part-2 head, minus the 21
exact-slug pairs above) have no ledger row sharing their exact slug at all
-- resolving those needs a statement-body diff against every candidate
ledger version, not a name match, and was out of scope for this pass. A
few have a close-but-not-exact ledger name worth checking first in the
next pass: `add_claims_hover_measurements` (repo 20260709100547; ledger
has the same base name at 20260709100251 -- possibly a true duplicate,
not a rename candidate, needs a body diff to tell which), `gh820_accept_
public_directory_rpc_risk` (repo 20260814013701; ledger has it at
20260814013724), `gh1059_partner_agreement_acceptance` (repo
20260820004212; ledger files it under version 20260820004417 with that
same string as part of its recorded name), `gh1253_backfill_service_
states_from_description` (repo 20260830170958; ledger has `..._restamp`
at 20260831113959 -- name is not identical, verify before treating as a
match), `gh1304_v115_guard_log_bid_accepted` (repo 20260901132754; ledger
has `v115_guard_log_bid_accepted` at 20260901132827), and `gh1509_w9_gate_
retired_policy_key` (repo 20260904234257; ledger files that exact string
under version 20260909122835). The remaining files with no close-name
candidate at all: `v82_d182_retroactive_members_table`, `v84_drop_orphan_
tables`, `v101_referral_agents_public_directory_optin` (20260807223000,
the known v88-banner duplicate from round 2), `gh738_platform_health_
check_pg_net_timeout`, `gh1544_contractors_email_lower_uniq`, `gh1529_
revoke_anon_execute_orphaned_security_definer_fns`, `gh1585_funnel_
abandonment_facts`, `gh1759_backfill_claims_platform_fee_charge`, `gh1725_
activity_log_nudge_once_uniq`, `gh1825_sms_sent_sid_idx`, `gh1529_revoke_
anon_write_grants_unbacked_rls_tables`.

Baseline manifest regenerated programmatically this pass (both
`counts.*` fields and their matching `*_versions` array lengths derived
from the same live-ledger/repo-tree computation, not hand-typed) --
`applied_no_repo_file` 58 -> 52, `repo_file_no_applied` 39 -> 33. Both
ratchet-script runs this session (part-2 head, then this branch's head)
gave the required "two consecutive runs, second lower than first" result
in both directions:

```
part-2 head (origin/k71/gh1438-part2):
  Baseline applied-but-no-repo-file debt: 58
  Current repo-file-but-not-applied count: 39 (baseline: 39)

this branch's head:
  Baseline applied-but-no-repo-file debt: 52
  Current repo-file-but-not-applied count: 33 (baseline: 33)
```

Both #2245's rename-aware `permissions-ratchet.py` and
`new-table-service-role-grant-check.py`, run directly from
`origin/k71/gh1438-grant-scan-renames` (no cherry-pick) against this
branch's diff against `origin/k71/gh1438-part2`, gave:

```
permissions-ratchet: files inspected: 6 -- hard_fail_count=0 bypassed_count=0 bypass_label_present=False -- GATE: PASS
new-table-service-role-grant-check: files inspected: 6 -- fail_count=0 -- GATE: PASS
```

SELECT-only throughout; zero `apply_migration`, `execute_sql` write, or
`db push` at any point in this pass.

## 2026-09-27 REVIEW FAIL round 3 correction (PR #2244) — independent review comment 5856332109, RETURNED 5856398678 (Marty/CTO)

Round 3 (a fresh-context reviewer, not this PR's author) reviewed head
`ecc66bfc` and found LEGAL-READ: PASS but REVIEW: FAIL on five items,
four of them content/doc defects and one a merge-gate dependency. All
four content items are fixed in this push.

1. **Round-2 must-fix 5 was still open.** The `migrations_drafts/` diff
   against base `5d426112` must show only `+` lines; it showed 12 `-`
   lines across 4 files: `gh1337_claims_referrer_updates_opt_out_forward.sql`
   (1), `gh916_progressive_partner_status_triggers.sql` (3, drift
   introduced fixing round-2's own em-dash rewrap),
   `gh969_hover_rebate_trigger_completion.sql` (5) and
   `v88_referral_agents_public_directory_optin_pre-flight.md` (3, table
   separator rows rewritten). **Fixed**: all 4 rebuilt as banner +
   exact base blob (base fetched via `git show 5d426112:<path>`, never
   retyped). Verified: `git diff 5d426112 -- <these 4 files>` now shows
   `0` removed/changed lines for all four, confirmed by script (see
   `/tmp/k73work/verify_all.py`'s reconstruction check — stripping the
   banner from the new content and comparing to the base blob byte-for-
   byte returns `OK` for all four).

2. **The recon doc's "remaining 6 companion files" claim (round-2 item 4)
   was false.** No `.test.sql`/README files exist in these 8 sets; the
   real 6 are `gh1021_add_paid_state_pre-flight.md`,
   `gh1021_add_paid_state_rollback.sql`,
   `gh749_add_service_states_to_contractors_pre-flight.md`,
   `gh749_add_service_states_to_contractors_rollback.sql`,
   `gh1070_activity_log_grants_revoke_rollback.sql` and
   `gh1050_commission_accrual_job_completion_rollback.sql`, and 5 of
   the 6 still carried `Status: DRAFT` / `**Status**: DRAFT` lines
   (only the gh1050 rollback was already clean). **Fixed**: the same
   banner-pointer convention already used on each set's main file was
   added to the 5 DRAFT-carrying companions — banner + exact base blob,
   base content (including the DRAFT line) left untouched below the
   banner, same byte-for-byte verification as item 1. The doc's item 4
   text is corrected in place.

3. **Eight renamed `supabase/migrations/` files (v91, p15 ×3, v104,
   gh1028 ×2, gh1075) claimed "Content below unchanged" but had drifted
   pre-existing comment lines** — em dash converted to ASCII `--` in
   several, and gh1075's own comment changed a version-number reference
   (`20260820004212` → `20260820004417`) that points at an unrelated
   ledger row. **Fixed**: all 8 rebuilt as (unchanged first line) +
   banner + exact base blob for every line from the base file's second
   line onward, so the em-dash/comment drift and the gh1075 reference
   are both reverted to base. Verified the same way as item 1: `git diff
   5d426112 -- <these 8 files>` (with rename detection) shows 0
   removed/changed lines for all eight, and `grep` confirms gh1075's
   comment again reads `20260820004212` (the base value).

4. **This PR body and the recon doc still stated the pre-round-2 numbers**
   (16 renames, Direction 1 72→56, Direction 2 53→37, baseline 56/37) and
   two internally self-contradicting Direction-1 statements (round-2 item
   2's "Direction-1 was never touched by this rename batch either way" and
   round-2 item 6's "`applied_no_repo_file` stays 56", both contradicted
   by the round-2 self-caught follow-on that raised it to 58). **Fixed**:
   PR body updated to the true numbers (14 renames, 72→58, 53→39); both
   doc sentences corrected in place (see the "Correction (round 3 review,
   comment 5856332109, ...)" notes inline in the round-2 section above).

5. **Merge gate (not a content defect): the two GRANT checks
   (`No new GRANT to anon/PUBLIC/authenticated`,
   `New public tables must GRANT service_role explicitly`) are still red
   on head `ecc66bfc`**, confirmed again this round via
   `ghcli.py checks otterquote-platform ecc66bfc1396f4ba713830ff10a93fa19c8027c6`
   (both `completed/failure`; the two required gates, Null-Byte & Size
   Sanity Check and 5-Page Revenue-Path Smoke Check, are `completed/
  success`). Both are the same rename-detection false positive
   root-caused in round 2 — `permissions-ratchet.py` and
   `new-table-service-role-grant-check.py` don't use `git diff -M` and so
   read a clean rename's unchanged, already-live GRANT/REVOKE statements
   as newly added. The fix lives in PR #2245 (rename-aware scanners),
   which is itself RETURNED and being fixed in parallel by a sibling
   worker. **Not fixed here** — out of this PR's scope per the reviewer's
   own stated sequencing (#2245 → #2244 → #2248). Rebase onto #2245 once
   it merges and re-run both checks; this content push does not touch
   either script.

Ledger/replay safety (14/14 renamed versions recorded, SQL matches the
ledger) and the merge-tree-with-main check were both independently
re-derived and passed in the round-3 review itself (comment 5856332109,
items 5 and 9) and are unaffected by this round's fixes, which touch only
comment/banner text, never executable SQL. SELECT-only throughout; zero
`apply_migration`, `execute_sql` write, or `db push` at any point in this
round.
