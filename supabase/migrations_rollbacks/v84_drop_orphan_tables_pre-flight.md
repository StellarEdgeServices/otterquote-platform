# v84_drop_orphan_tables — Pre-Flight

**ClickUp:** [86e1j588x](https://app.clickup.com/t/86e1j588x)
**Drafted:** 2026-05-27 by Cowork session (Opus)
**Migration tier:** Tier 3 (D-220) — requires Dustin approval before merge
**Deploy chain:** D-221 Path A
**Drafted via:** migration-author equivalent (manual, verified against live DB)

---

## What this migration does

Drops four orphan tables that predate the current claim flow:

| Table | Reason | Live rows | Inbound FKs | Size |
|-------|--------|-----------|-------------|------|
| `documents` | Predates D-182 DocuSign flow | 0 | 0 | 40 KB |
| `job_assignments` | Superseded by `bids` table | 0 | 0 | 49 KB |
| `inspection_bookings` | Orphaned inspection concept | 0 | 0 | 40 KB |
| `claim_trade_items` | Orphaned line-item concept | 0 | 0 | 24 KB |

**Total reclaimed:** ~154 KB metadata + 27 dependent objects (3 PKs + 11 indexes + 13 RLS policies + 1 trigger).

---

## Pre-flight verification (re-run before deploy)

Executed 2026-05-27 against project `yeszghaspzwwstvsrioa`:

```sql
WITH t AS (
  SELECT unnest(ARRAY['documents','job_assignments','inspection_bookings','claim_trade_items']) AS table_name
)
SELECT
  t.table_name,
  (SELECT n_live_tup FROM pg_stat_user_tables s
    WHERE s.relname = t.table_name AND s.schemaname='public') AS live_rows,
  (SELECT COUNT(*) FROM pg_constraint c
     JOIN pg_class cl ON c.conrelid = cl.oid
   WHERE c.contype='f' AND c.confrelid = format('public.%I', t.table_name)::regclass) AS inbound_fk_count
FROM t;
```

**Result:** All four tables — `live_rows=0`, `inbound_fk_count=0`. ✅

The forward SQL contains a transactional safety net that re-checks `n_live_tup`
and aborts the migration if any of the four tables has gained rows between
pre-flight and execution.

---

## Verified application-code references

Grep against `otterquote-deploy/` (excluding `node_modules/` and `supabase/migrations/`):

| Table | App-code references |
|-------|---------------------|
| `documents` | None (all matches are unrelated identifiers: `docusign`, `google_docs`, `attestation_documents`, `legal-documents`, etc.) |
| `job_assignments` | None |
| `claim_trade_items` | None |
| `inspection_bookings` | **One** — `schedule-inspection.html` line 997 (Supabase insert) |

---

## ⚠️ Orphan code path

`schedule-inspection.html` line 997 still inserts into `inspection_bookings`.
The page is reachable from `repair-intake.html`. The table has accumulated
zero rows over its lifetime, which is why it qualifies as orphan — but the
code path is technically live.

**Migration decision:** Proceed. After v84, any call to that insert returns
a Postgres `42P01 undefined_table` error. Because the page has never produced
a row, the path is functionally dead.

**Follow-up task (not blocking):** Remove `schedule-inspection.html` and the
link from `repair-intake.html`. File as **Forge candidate** — Architect will
catch the schema/code drift on next sweep. Recommend ClickUp task:
*"Remove orphaned schedule-inspection.html page (post v84 cleanup)"*, Tier 1,
Sonnet.

---

## RLS, indexes, triggers preserved in rollback

The rollback recreates every object that was on the tables at pre-flight time:

- **PKs (4):** `documents_pkey`, `job_assignments_pkey`, `inspection_bookings_pkey`, `claim_trade_items_pkey`
- **Unique (1):** `job_assignments_claim_id_key`
- **Indexes (7):** `idx_documents_claim_id`, `idx_job_assignments_claim_id`, `idx_job_assignments_contractor_id`, `idx_job_assignments_quote_id`, `idx_inspection_bookings_claim`, `idx_inspection_bookings_contractor`, `idx_inspection_bookings_date`, `idx_claim_trade_items_claim_id`
- **RLS policies (13):** verbatim from `pg_policies` 2026-05-27
- **Trigger (1):** `set_updated_at_job_assignments` (depends on existing `public.set_updated_at()` function)

**Rollback assumption:** `public.set_updated_at()` function still exists at
rollback time (it is shared by many tables and is not removed by v84).

---

## Acceptance Criteria check (from ClickUp task)

- [x] `forward.sql` drops all four tables — **DONE** (`v84_drop_orphan_tables.sql`)
- [x] `rollback.sql` restores all four tables with original schema — **DONE** (`v84_drop_orphan_tables_rollback.sql`)
- [x] `pre-flight.md` confirms 0 rows and no FK dependencies — **DONE** (this file)
- [ ] Migration passes CI — **deferred to Code F35 PR run**
- [ ] Tier 3 approved by Dustin before deploy — **PENDING**

---

## Recommended deploy sequence (Code F35)

1. `migration-author-code` verification against a fresh Supabase branch:
   - Forward applies cleanly
   - Rollback applies cleanly
   - Idempotency check (forward → rollback → forward → rollback)
2. Create PR on a `feature/86e1j588x-drop-orphan-tables` branch via `commit_via_api.py`
3. Surface to Dustin for Tier 3 approval (D-220 / D-182)
4. After approval, merge to `main` and let CI apply
5. Verify post-deploy: `\dt public.documents` etc. → "Did not find any relation"
6. Close 86e1j588x with `[WINGMAN-DONE: cwk-86e1j588x]` comment
7. File follow-up task: remove `schedule-inspection.html` (Forge candidate)

---

## Risk summary

| Risk | Likelihood | Severity | Mitigation |
|------|-----------|----------|------------|
| Hidden inbound FK breaks rollback | Very low | High | Pre-flight verified 0 inbound FKs across all 4 tables |
| Row appears between pre-flight and deploy | Very low | Medium | Forward SQL re-checks row count transactionally and aborts on > 0 |
| Orphan code path (`schedule-inspection.html`) errors | Low | Low | Page has produced 0 rows over months — functionally dead |
| `set_updated_at()` function dropped before rollback | Very low | Medium | Function is shared by many tables; not removed by v84 |

**Overall risk:** Low. Recommend proceed after Tier 3 approval.
