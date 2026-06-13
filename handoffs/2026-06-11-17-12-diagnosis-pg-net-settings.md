# Handoff — pg_net trigger settings diagnosis + RFC

## Session Type
Diagnosis + RFC prep (Claude Code). No deploys, no commits, no prod writes.

## Date/Time
2026-06-11 17:12 ET

## Tasks Completed
- Confirmed the reported diagnosis: `app.supabase_url` / `app.service_role_key` GUCs were never
  set in prod (`yeszghaspzwwstvsrioa`). No setter exists anywhere in repo or git history; the
  working cron jobs (v50a, v81) hardcode URL/key and never used the GUCs; v49's "prerequisites
  already met" header was circular (v44 consumes the GUC, nothing sets it).
- Mapped all consumers: v85 trigger (admin signup email — dead since 2026-06-02 deploy),
  v52a notify-payout-pending (dead), v44 check-siding-design-completion cron (dead/likely never
  scheduled), v49 notify-partner-w9 (moot — see error log E2).
- Confirmed both notify EFs require bearer == SUPABASE_SERVICE_ROLE_KEY exactly, so the DB must
  hold the key (Vault) until a CRON_SECRET migration (Phase 2).
- Wrote RFC with exact commands, verification queries, repair queries, rollback:
  `Docs/RFC-2026-06-11-pg-net-settings-vault.md` — awaiting Dustin (Tier C / Tier 3).
- Note: Cowork rfc skill protocol (`Claude's Memories/Skills/rfc/SKILL.md`) was not accessible
  from Code; RFC written in standard format instead.

## Files Changed
- `Docs/RFC-2026-06-11-pg-net-settings-vault.md` (new — the deliverable)
- `handoffs/2026-06-11-17-12-diagnosis-pg-net-settings.md` (this file)

## Error Log (R-003, structured)
- **E1 — Config never applied (root cause).** `app.supabase_url`/`app.service_role_key` GUCs
  assumed set since v44 (2026-04), never set. All pg_net→EF server paths fail closed and quiet.
  Detected 2026-06-11. Severity: HIGH. Fix: RFC Phase 1 (Vault + URL GUC + migration v86).
- **E2 — D-172 regression (new finding).** v52a (2026-04-22) rebuilt `apply_referral_commission()`
  from v40's body, silently dropping v49's W-9 gate (payments_blocked withholding +
  notify-partner-w9 email + stamp). Current prod function has NO W-9 gate. Severity: HIGH
  (compliance/payments). Fix: restore gate in v86 — decision point §5.3 of the RFC.
- **E3 — v44 invalid SQL (new finding).** `SELECT cron.schedule(...) ON CONFLICT ...` is a syntax
  error (ON CONFLICT is INSERT-only); the siding cron job may never have been scheduled.
  Severity: MEDIUM. Verify via `select * from cron.job` (RFC §6.1) before assuming re-schedule
  is an "update".
- **E4 — v49 stamp-before-send flaw (latent).** `w9_notification_sent_at` stamped before the
  settings check → partners marked notified without an email. Repair query in RFC §6.3 once the
  gate is restored.
- **E5 — Wrong security claim in v49 header.** "app.service_role_key ... not accessible to
  anon/authenticated roles" is false for database-level GUCs; informed the Vault recommendation.

## Unresolved Items
- Dustin approval of RFC Phase 1 + the §5.3 W-9 gate decision (B1 restore vs B2 new D-number).
- Two Dustin-run secret-bearing commands (RFC §5.1) — not automatable, Tier C.
- Live pre-apply verification queries (RFC §6.1) — no Supabase MCP/CLI access in this session.
- v86 migration files not yet authored — run `/migration-author` after RFC approval.

## Next Session Should
1. If approved: run RFC §6.1 pre-apply queries, record results, then `/migration-author` for
   v86 (helper + v85 fn key-read swap + v52a fn with restored gate per §5.3 decision + cron
   re-schedule) with rollback + pre-flight.
2. After Dustin runs §5.1 and v86 deploys: run §6.2 post-apply checks + the end-to-end contractor
   signup probe; review §6.3 repair items with Dustin before executing any of them.
3. Open ClickUp task for Phase 2 (CRON_SECRET migration + service-role key rotation).
