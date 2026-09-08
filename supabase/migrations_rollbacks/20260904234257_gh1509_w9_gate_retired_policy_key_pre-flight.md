# Pre-Flight: 20260904234257_gh1509_w9_gate_retired_policy_key

**Migration**: 20260904234257_gh1509_w9_gate_retired_policy_key.sql
**Date**: 2026-09-04
**Author**: Claude Code (run-work dispatch rw-f22-20260904T231551-wgnu, orch rw-drain-f22-20260904T231551-cmqi)
**D-numbers**: D-182 Tier 3B (RLS policy change, R-097 24h window, approved), D-319 (the underlying decision), D-221 (Path A deploy)
**Issue**: gh-1509

## Change Summary

Adds `'w9_gate_retired'` to the client-readable key allowlist of the
`platform_settings` table's single SELECT policy, `"Authenticated can read
public settings"`. Today, `partner-dashboard.html` and
`admin-referrals.html` read the D-319 flag through this RLS-gated client
path (the same way they read `D204_HARD_FILTER`); without this key in the
allowlist, RLS filters the row to 0 results regardless of its value, so
those two pages always resolve `w9GateRetired = false`. The three payout
Edge Functions (`approve-payout`, `notify-partner-w9`,
`process-payout-reminders`) already read the flag correctly via
service-role clients, which bypass RLS entirely -- they are not affected
by this gap or this fix.

**This PR ships ONLY the forward + rollback migration files, proven in a
rolled-back transaction against production. `apply_migration` was never
called. No DDL persists.** Flipping `w9_gate_retired = true` in
`platform_settings` and the production demonstration (partner dashboard +
`approve-payout` on an `is_test` fixture) are explicitly reserved for
`@exec:cto` per the dispatch comment quoted below -- this lane does not
perform them.

## Chain of Custody (why this is authorized)

- Follow-up identified by the CTO in issue comment `5514854954`
  (2026-09-02T19:05:01Z), immediately after half A of gh-1509 (#1545)
  merged.
- R-097 24-hour risk brief posted as issue comment `5530428267`
  (2026-09-03T18:40:26Z); `tier:3b` applied as the notice's mechanism.
- Window closed 2026-09-04T18:40:06Z with no objection recorded anywhere
  on the issue (confirmed by re-reading the full comment thread live in
  this session).
- `tier:3b-approved` applied by CTO run `cto-2026-09-04T18:26:08Z`, issue
  comment `5545246895` (2026-09-04T19:05:55Z).
- Dispatched to this lane in issue comment `5545414037`
  (2026-09-04T19:20:45Z), which states verbatim: *"So the lane's whole
  deliverable is steps 1 and 2: a reviewed PR containing both halves of
  the migration, with the `BEGIN … ROLLBACK` transcript. Nothing is
  applied,"* and *"⛔ STOP THERE. Flipping `w9_gate_retired = true` in
  `platform_settings` is mine ... The lane does not flip it and does not
  deploy it,"* and *"The production demonstration is mine too."*
- Claimed by this lane in issue comment `5547691134`
  (2026-09-04T23:38:58Z).

All five of the above were independently re-verified live against the
GitHub issue (not taken on the dispatch prompt's word) before any work
began, per this session's own verification-first preamble.

## Live Policy State — Read Immediately Before Authoring (prod, yeszghaspzwwstvsrioa)

```sql
select policyname, cmd, roles, permissive, qual, with_check
from pg_policies where schemaname='public' and tablename='platform_settings';
```
```json
[{"policyname":"Authenticated can read public settings","cmd":"SELECT","roles":"{authenticated}","permissive":"PERMISSIVE","qual":"(key = ANY (ARRAY['D204_HARD_FILTER'::text, 'hover_measurement_price'::text, 'platform_fee_percentage'::text, 'skip_hover_in_test'::text, 'measurement_products'::text]))","with_check":null}]
```

**Exactly ONE policy exists on `platform_settings`, total (no cmd filter
applied to the query above -- this is every policy on the table, of any
command type).** There is no separate admin write policy. The new ARRAY
in the forward migration is this live qual's five keys, verbatim, plus
`'w9_gate_retired'` -- not a reconstruction from the repo file. It is
byte-identical to the repo's newest definition
(`supabase/migrations/20260825113728_gh1245_admin_measurements_rls.sql`),
so there is no live/repo drift to report.

## Proof: Rolled-Back Transaction Against Production

**Transaction semantics probed first.** `BEGIN; CREATE TEMP TABLE
rw_probe(x int); INSERT INTO rw_probe VALUES (1); SELECT * FROM rw_probe;
ROLLBACK;` returned `[{"x":1}]`, confirming the connection sees
in-transaction state. A second, separate call confirmed
`to_regclass('rw_probe')` and `to_regclass('pg_temp.rw_probe')` both
return `null` -- nothing persisted.

**Batch return-value check.** `BEGIN; SELECT 'first' as label; SELECT
'second' as label; ROLLBACK;` returned only `[{"label":"second"}]` --
confirming this tool returns only the LAST statement's result from a
semicolon-separated batch, not every intermediate SELECT. Per the work
order, the proof below therefore uses a single `DO $$ ... $$` block that
accumulates every intermediate result into one text report and surfaces
it via `RAISE EXCEPTION USING MESSAGE = <report>` -- which both guarantees
the enclosing transaction aborts (Postgres aborts the current transaction
on any unhandled exception) and returns the full transcript in the
error text.

**Pattern used: `DO $$ ... RAISE EXCEPTION USING MESSAGE ... $$` inside an explicit `BEGIN ... ROLLBACK`.**

Full statement executed against `yeszghaspzwwstvsrioa`:

```sql
BEGIN;

DO $$
DECLARE
  v_pre_qual text;
  v_post_forward_qual text;
  v_post_rollback_qual text;
  v_functional_keys text;
  v_report text := '';
  v_old_keys text[] := ARRAY['D204_HARD_FILTER','hover_measurement_price','platform_fee_percentage','skip_hover_in_test','measurement_products'];
  k text;
  v_all_old_present boolean := true;
  v_policy_count int;
BEGIN
  SELECT count(*) INTO v_policy_count FROM pg_policies WHERE schemaname='public' AND tablename='platform_settings';
  v_report := v_report || 'TOTAL POLICIES ON platform_settings: ' || v_policy_count::text || E'\n\n';

  SELECT qual INTO v_pre_qual FROM pg_policies WHERE schemaname='public' AND tablename='platform_settings' AND policyname='Authenticated can read public settings';
  v_report := v_report || E'PRE-CHANGE QUAL:\n' || v_pre_qual || E'\n\n';

  DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
  CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
    FOR SELECT TO authenticated
    USING (key = ANY (ARRAY[
      'D204_HARD_FILTER'::text, 'hover_measurement_price'::text,
      'platform_fee_percentage'::text, 'skip_hover_in_test'::text,
      'measurement_products'::text, 'w9_gate_retired'::text
    ]));

  SELECT qual INTO v_post_forward_qual FROM pg_policies WHERE schemaname='public' AND tablename='platform_settings' AND policyname='Authenticated can read public settings';
  v_report := v_report || E'POST-FORWARD QUAL:\n' || v_post_forward_qual || E'\n\n';

  FOREACH k IN ARRAY v_old_keys LOOP
    IF position(quote_literal(k) in v_post_forward_qual) = 0 THEN
      v_all_old_present := false;
      v_report := v_report || 'MISSING OLD KEY: ' || k || E'\n';
    END IF;
  END LOOP;
  IF position(quote_literal('w9_gate_retired') in v_post_forward_qual) = 0 THEN
    v_all_old_present := false;
    v_report := v_report || 'MISSING NEW KEY: w9_gate_retired' || E'\n';
  END IF;
  v_report := v_report || 'ASSERT_ALL_OLD_KEYS_PLUS_NEW_PRESENT: ' || v_all_old_present::text || E'\n\n';

  SET LOCAL ROLE authenticated;
  SELECT string_agg(key, ',' ORDER BY key) INTO v_functional_keys
    FROM platform_settings
    WHERE key IN ('D204_HARD_FILTER','hover_measurement_price','platform_fee_percentage','skip_hover_in_test','measurement_products','w9_gate_retired');
  RESET ROLE;
  v_report := v_report || 'FUNCTIONAL CHECK (role=authenticated) keys visible: ' || COALESCE(v_functional_keys, '(none)') || E'\n';
  v_report := v_report || 'NOTE: no w9_gate_retired row exists yet -- absence from this list is EXPECTED; none was inserted.' || E'\n\n';

  DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;
  CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
    FOR SELECT TO authenticated
    USING (key = ANY (ARRAY[
      'D204_HARD_FILTER'::text, 'hover_measurement_price'::text,
      'platform_fee_percentage'::text, 'skip_hover_in_test'::text,
      'measurement_products'::text
    ]));

  SELECT qual INTO v_post_rollback_qual FROM pg_policies WHERE schemaname='public' AND tablename='platform_settings' AND policyname='Authenticated can read public settings';
  v_report := v_report || E'POST-ROLLBACK QUAL:\n' || v_post_rollback_qual || E'\n\n';
  v_report := v_report || 'ASSERT_ROLLBACK_QUAL_BYTE_IDENTICAL_TO_PRECHANGE: ' || (v_post_rollback_qual = v_pre_qual)::text || E'\n';

  RAISE EXCEPTION USING MESSAGE = v_report;
END $$;

ROLLBACK;
```

**Raw transcript returned (the `DO` block's `RAISE EXCEPTION` message, verbatim):**

```
TOTAL POLICIES ON platform_settings: 1

PRE-CHANGE QUAL:
(key = ANY (ARRAY['D204_HARD_FILTER'::text, 'hover_measurement_price'::text, 'platform_fee_percentage'::text, 'skip_hover_in_test'::text, 'measurement_products'::text]))

POST-FORWARD QUAL:
(key = ANY (ARRAY['D204_HARD_FILTER'::text, 'hover_measurement_price'::text, 'platform_fee_percentage'::text, 'skip_hover_in_test'::text, 'measurement_products'::text, 'w9_gate_retired'::text]))

ASSERT_ALL_OLD_KEYS_PLUS_NEW_PRESENT: true

FUNCTIONAL CHECK (role=authenticated) keys visible: D204_HARD_FILTER,hover_measurement_price,measurement_products,platform_fee_percentage,skip_hover_in_test
NOTE: no w9_gate_retired row exists yet -- absence from this list is EXPECTED; none was inserted.

POST-ROLLBACK QUAL:
(key = ANY (ARRAY['D204_HARD_FILTER'::text, 'hover_measurement_price'::text, 'platform_fee_percentage'::text, 'skip_hover_in_test'::text, 'measurement_products'::text]))

ASSERT_ROLLBACK_QUAL_BYTE_IDENTICAL_TO_PRECHANGE: true

CONTEXT:  PL/pgSQL function inline_code_block line 75 at RAISE
```

The `RAISE EXCEPTION` aborts the enclosing transaction unconditionally
(Postgres semantics: an unhandled exception aborts the current
transaction regardless of any subsequent `ROLLBACK`/`COMMIT` in the same
batch) -- the explicit trailing `ROLLBACK;` is belt-and-suspenders on top
of that guarantee.

## Nothing Persisted — Proven in a NEW, Separate Call

```sql
select policyname, qual from pg_policies where schemaname='public' and tablename='platform_settings';
```
```json
[{"policyname":"Authenticated can read public settings","qual":"(key = ANY (ARRAY['D204_HARD_FILTER'::text, 'hover_measurement_price'::text, 'platform_fee_percentage'::text, 'skip_hover_in_test'::text, 'measurement_products'::text]))"}]
```
Qual is identical to the pre-change state; `w9_gate_retired` is absent.

```sql
select count(*) as w9_row_count from platform_settings where key = 'w9_gate_retired';
```
```json
[{"w9_row_count":0}]
```
No `w9_gate_retired` row exists (none was inserted by this session, per
instruction -- the flag row's insertion/flip is the CTO's step 3).

## Full Policy Enumeration on `platform_settings`

The `count(*)` query above and the unfiltered `pg_policies` query both
return exactly **one** row for `tablename='platform_settings'` regardless
of `cmd` — there is no admin write policy, no `ALL`/`INSERT`/`UPDATE`/
`DELETE` policy, nothing else defined on this table. The migration in
this PR touches only that one policy.

## Key-Set Assertion

New ARRAY = live five keys (`D204_HARD_FILTER`, `hover_measurement_price`,
`platform_fee_percentage`, `skip_hover_in_test`, `measurement_products`)
**plus exactly one** (`w9_gate_retired`). No key is dropped. Verified
programmatically in the transcript above
(`ASSERT_ALL_OLD_KEYS_PLUS_NEW_PRESENT: true`) rather than by inspection
only.

## Danger Pattern Check

| # | Pattern | Triggered? | Notes |
|---|---------|-----------|-------|
| 1 | NOT NULL, no DEFAULT | No | Not a column change |
| 2 | NOT NULL on >100K rows | No | — |
| 3 | Drop column | No | — |
| 4 | Type change rewrite | No | — |
| 5 | Index without CONCURRENTLY | No | Not an index |
| 6 | RENAME | No | — |
| 7 | TRUNCATE/DELETE all | No | — |
| 8 | CASCADE DROP | No | — |
| 9 | New/replaced function EXECUTE grants | No | No function created |
| — | RLS policy rewrite (DROP + CREATE) | **Classed Tier 3B regardless of diff size** | Constitution entry 3: "a change is tiered by what its pipeline executes, not by its diff." Mitigated by: live qual re-read before writing (no drift), full policy enumeration (nothing else on the table), programmatic key-set assertion, and the rolled-back production proof above. |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| `DROP POLICY` / `CREATE POLICY` | Brief catalog-only lock on `pg_policy`; no table rewrite, no row scan | Near-instant regardless of table size |

## Supabase Branch Test Results

Not performed as a branch test — per the work order, proof is a
`BEGIN...ROLLBACK` transaction directly against production (the policy
and its exact live qual only exist meaningfully in prod; a fresh branch
would not reproduce the same baseline without first replaying the
gh1245 migration). See "Proof" section above for the full rolled-back
transcript, which serves the same verification purpose the skill's Step 6
branch test would.

## Deploy Notes

- **D-182 Tier**: 3B — R-097 24h window opened 2026-09-03T18:40:26Z,
  closed 2026-09-04T18:40:06Z with no objection; `tier:3b-approved`
  applied by CTO run `cto-2026-09-04T18:26:08Z` (issue comment
  `5545246895`).
- **Application**: **NOT performed by this session.** This PR ships the
  authored forward + rollback migration files and this pre-flight only.
  `apply_migration` was never called; no DDL was run outside a
  `BEGIN...ROLLBACK` block. Steps 3 (flip `w9_gate_retired = true`) and 4
  (production demonstration) are **@exec:cto's**, per the 2026-09-04T19:20:45Z
  dispatch (issue comment `5545414037`) — this lane does not perform
  them, does not touch `partner-dashboard.html`, `approve-payout`,
  `notify-partner-w9`, `process-payout-reminders`, `admin-referrals.html`,
  or `partner-agreement.html`.
- **Rollback pre-authorized**: Yes —
  `20260904234257_gh1509_w9_gate_retired_policy_key_rollback.sql`
  re-creates the policy with exactly the original five keys. Reversible
  with no data loss.
- **Refuter guidance** (per the dispatch): check specifically that the
  rewritten policy drops no key the current one grants — the transcript's
  `ASSERT_ALL_OLD_KEYS_PLUS_NEW_PRESENT: true` line and the
  `POST-FORWARD QUAL` transcript line are the evidence for that check.

## Danger Overrides

None.
