# Pre-flight — v86_drop_activity_log_event_type_check

- **ClickUp:** 86e1tz17j
- **Tier:** 3 (requires Dustin approval — granted 2026-06-11, Path A / DROP)
- **Project:** yeszghaspzwwstvsrioa (OtterQuote prod Supabase)
- **Author:** Claude Code (Opus 4.8), launch-blocker 1A, 2026-06-11
- **Status:** DRAFTED — HELD. Do not deploy until Dustin signs off on the final diff.

## What this migration does
Drops `activity_log_event_type_check`, the fail-closed CHECK that allowed only 8
`event_type` values. No replacement constraint (Path A). Rollback re-adds the
original 8 as `NOT VALID`.

## Root cause (verified, not assumed)
Confirmed against **deployed** Edge Function source on 2026-06-11:

| EF | event_type inserted | In old allow-list? |
|----|---------------------|--------------------|
| send-bid-confirmation v18 | `bid_confirmation_email_sent` | ❌ rejected |
| create-invoice v16 | `invoice_created` (D-215 L3) | ❌ rejected |
| docusign-webhook v49 | `homeowner_contract_signed_email_sent` | ❌ rejected |

All three insert with a **non-fatal swallow** (`if (logError) console.error(...)`),
so prod returned 200 and the audit row was silently dropped. At investigation,
`activity_log` held only `bid_submitted` (20 rows).

Premise corrections: `hubspot_contact_created` is **not** written by
create-hubspot-contact v23 (it never touches activity_log); `pre_flight_walk_complete`
is a PFW test artifact. Real rejected set = 3, not 5.

## Pre-flight verification (run 2026-06-11 via Supabase MCP, read-only)
```sql
-- constraint definition
SELECT pg_get_constraintdef(con.oid)
FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE rel.relname = 'activity_log' AND con.contype = 'c';
-- => CHECK (event_type = ANY (ARRAY['bid_submitted',...,'job_completed']))

-- distinct event_types present
SELECT event_type, count(*) FROM activity_log GROUP BY event_type;
-- => bid_submitted | 20   (only value present)
```
24h Postgres logs: **0** constraint-violation ERRORs (consistent with the swallow
pattern — the violation returns to the EF as a PostgREST error it catches; not a
server-side ERROR). This is NOT evidence of health.

## Deploy steps (ON DUSTIN'S GO)
1. Apply `v86_drop_activity_log_event_type_check.sql` to prod (Supabase MCP `apply_migration` or D-221 chain).
2. Confirm constraint gone:
   ```sql
   SELECT conname FROM pg_constraint
   WHERE conrelid = 'public.activity_log'::regclass AND contype = 'c';
   -- => (no row for activity_log_event_type_check)
   ```

## Post-deploy verification (D-215 audit trail intact)
3. Exercise a real contract-signed → create-invoice path (or PFW Stage 14), then:
   ```sql
   SELECT event_type, created_at FROM activity_log
   WHERE event_type IN ('invoice_created','bid_confirmation_email_sent',
                         'homeowner_contract_signed_email_sent')
   ORDER BY created_at DESC LIMIT 10;
   -- => at least one invoice_created row now lands (previously silently rejected)
   ```
4. Confirm the companion EF change (non-swallow → Sentry) is deployed so any
   FUTURE insert failure is visible rather than silent.

## Rollback
`v86_drop_activity_log_event_type_check_rollback.sql` re-adds the original 8 as
`NOT VALID`. ⚠️ Rolling back re-creates the silent-loss condition for new EF
event_types — pair with reverting the EF Sentry change and confirm with Dustin.

## Dependencies / sequencing
- Companion (separate change, same task spirit): de-blind the 3 EFs — keep insert
  non-fatal, report failure to Sentry. Needs a `_shared` Sentry helper + a
  `SENTRY_DSN` secret in the Supabase EF runtime (EFs currently have **no** Sentry).
- Not blocked by any other migration. v85 is the prior head.
