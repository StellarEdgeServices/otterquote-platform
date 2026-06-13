# RFC: Fix pg_net → Edge Function plumbing (app.supabase_url / app.service_role_key never configured)

| | |
|---|---|
| **Status** | DRAFT — awaiting Dustin approval (Tier C / D-182 Tier 3) |
| **Date** | 2026-06-11 |
| **Author** | Claude Code (diagnosis session) |
| **Project** | Supabase prod `yeszghaspzwwstvsrioa` |
| **Decision needed** | Approve Phase 1 (Vault secret + URL GUC + migration v86), decide W-9 gate restoration (§5.3) |
| **Related** | D-172 (W-9 gate), D-180 (payout approvals), D-220 (Tier 3 approval), v44/v49/v52a/v85 |

---

## 1. Summary

Every server-side path that calls an Edge Function from PostgreSQL via `pg_net` reads two
custom GUCs — `current_setting('app.supabase_url')` and `current_setting('app.service_role_key')` —
that **were never set at any database or role level**. Live verification: `pg_db_role_setting`
contains only `app.settings.jwt_exp`; both `current_setting(..., true)` calls return NULL.
Repo verification: no `ALTER DATABASE ... SET app.*` / `ALTER ROLE ... SET app.*` exists anywhere
in the repo or its git history, and no handoff/doc records a manual setup.

Every consumer fails closed and quiet, so nothing alarmed:

| Consumer | Introduced | Failure mode in prod today |
|---|---|---|
| `notify_admin_new_contractor()` trigger → `notify-admin-new-contractor` EF | v85 (2026-06-02) | NULL guard → `RAISE LOG` → silently skips. Dustin gets **no admin email for real contractor signups**. Masked: the only `admin_new_contractor` notification row is from deploy day (manual EF test), and subsequent signups were test accounts the trigger intentionally skips. |
| `apply_referral_commission()` W-9 branch → `notify-partner-w9` EF | v49 (2026-04-21) | Moot — see §3.1: the branch no longer exists in prod. |
| `apply_referral_commission()` → `notify-payout-pending` EF | v52a (2026-04-22) | NULL guard → silently skips. **No payout-pending email** when commissions accrue; only the 7-day auto-approve cron path remains. |
| `check-siding-design-completion` pg_cron job | v44 | Uses `current_setting('app.supabase_url')` **without** missing-ok → hard error each run — *if the job exists at all* (see §3.2). Retail siding bid release polling is dead either way. |

Root cause of the bad assumption: v49's header asserts *"app.supabase_url is set (v44 pg_cron
jobs use it)"* — circular reasoning. v44 **consumes** the GUC; nothing ever **set** it. The cron
jobs that actually work (v50a `process-coi-reminders`, v81 `process-auto-bids`) hardcode the
project URL and pass an embedded key / `CRON_SECRET` — they never touched the GUCs.

## 2. Why a plain GUC is the wrong place for the key

The originally-assumed design (`ALTER DATABASE postgres SET app.service_role_key = '...'`) is a
real vulnerability, not a style nit:

- A database-level GUC becomes a **session default for every role** in the database. Any SQL
  executed as `anon` or `authenticated` — an exposed RPC, a computed column, a future SQL
  injection — can read it with `current_setting('app.service_role_key')`.
- The value is also visible in the `pg_db_role_setting` catalog.
- v49's SECURITY NOTE claims the setting is "not accessible to anon/authenticated PostgreSQL
  roles" — **that claim is wrong** for database-level GUCs. Good thing it was never set.

Supabase Vault is the supported answer: secrets encrypted at rest, `vault.decrypted_secrets`
readable by `postgres` but not by `anon`/`authenticated`, and our trigger functions are already
`SECURITY DEFINER` owned by `postgres`.

The **URL is not a secret** (it ships in every client bundle), so a plain GUC is fine for it and
keeps the existing `current_setting('app.supabase_url', true)` reads working unchanged.

Note: the EFs cannot simply take the anon key instead — `notify-admin-new-contractor` and
`notify-partner-w9` both require the bearer to **equal `SUPABASE_SERVICE_ROLE_KEY` exactly**
(`index.ts` auth checks). The database genuinely needs the key until Phase 2 (§7).

## 3. Additional findings (surfaced per R-016 — both predate this session)

### 3.1 D-172 W-9 gate was silently regressed by v52a — HIGH

`sql/v52a-payout-approvals.sql` (applied 2026-04-22, one day after v49) replaced
`apply_referral_commission()` with a body written against **v40**, not v49. Its own comment says
*"Extends v40's trigger function."* The entire D-172 W-9 gate — `payments_blocked` check,
commission withholding, `notify-partner-w9` email, `w9_notification_sent_at` stamp — is **absent
from the current production function**. Only v40/v49/v52a define this function in the repo;
nothing later restores the gate.

Consequences since 2026-04-22:
- Commissions for `payments_blocked = true` partners accrue and create `payout_approvals` rows
  with no W-9 withholding. (Partial backstop: D-180 manual payout approval still puts a human in
  front of actual money movement — but auto-approve fires at 7 days.)
- W-9 request emails never send, GUCs or no GUCs — the calling code is gone.

Fixing the GUCs alone does **not** resurrect the W-9 email path. Migration v86 must merge the
v49 gate back into the v52a body (decision point in §5.3).

### 3.2 v44's cron scheduling statement is invalid SQL — was it ever applied?

`sql/v44-siding-bid-release.sql:23-38` ends with:

```sql
SELECT cron.schedule(...)
ON CONFLICT (jobname) DO UPDATE
  SET schedule = '*/30 * * * *';
```

`ON CONFLICT` is INSERT-only syntax; appended to a `SELECT` it is a **syntax error**. If v44 was
applied as a single Management API batch, the whole batch aborted — meaning the
`check-siding-design-completion` job may have never been scheduled and even
`claims.siding_bid_released_at` may be missing (the column *does* appear in
`sql/schema-snapshot.json`, so it likely got applied some other way — but the cron job's
existence is unverified). Pre-apply verification queries in §6.1 resolve this.

### 3.3 v49's stamp-before-send flaw (relevant when gate is restored)

v49 stamped `w9_notification_sent_at = NOW()` **before** checking the GUCs. With the GUCs unset,
any partner who hit the gate during v49's one day in production got permanently marked
"email sent" without an email. The restored gate in v86 must only stamp when the HTTP call is
actually issued, and §6.3 includes a repair query for falsely-stamped rows.

## 4. Options

**A. Set both values as database GUCs** (the original v44/v49 assumption).
One-liner fix, zero code change — but stores the service role key world-readable inside the
database (§2). Rejected.

**B. Key in Vault behind a `private` schema helper; URL as a plain GUC. ← RECOMMENDED**
Smallest diff that is actually secure: existing `current_setting('app.supabase_url', true)`
reads keep working; only the key reads change to `private.service_role_key()`; the broken cron
job is re-scheduled correctly; the W-9 gate is restored while we are in the function anyway.

**C. CRON_SECRET pattern everywhere** (per the deferred note in `supabase/config.toml` for
`notify-payout-pending`): EFs accept a dedicated secret, `verify_jwt = false`, DB never holds
the service role key. Strategically right, but requires redeploying 3-4 EFs + config changes in
the same window — too much surface for one change. Defer to Phase 2 (§7).

## 5. Proposed change (Phase 1)

### 5.1 Dustin-run, secret-bearing — NOT committed to the repo (Tier C)

Run in Supabase Dashboard → SQL Editor, prod project `yeszghaspzwwstvsrioa`:

```sql
-- 0. Confirm Vault is available (expected: one row; if empty, enable the
--    "supabase_vault" extension from Dashboard → Database → Extensions first)
select extname, extversion from pg_extension where extname = 'supabase_vault';

-- 1. Store the service role key in Vault.
--    Paste the key from Dashboard → Project Settings → API → service_role.
--    NEVER paste it into a file, chat, ClickUp, or a migration.
select vault.create_secret(
  '<SERVICE_ROLE_KEY_HERE>',
  'service_role_key',
  'Service role key for pg_net -> Edge Function calls (RFC 2026-06-11, v86)'
);

-- 2. Set the (non-secret) project URL as a database-level GUC.
alter database postgres
  set app.supabase_url = 'https://yeszghaspzwwstvsrioa.supabase.co';
```

Notes:
- Step 2 applies to **new sessions only**. Long-lived pooled sessions pick it up as they recycle
  (cron jobs see it immediately — each run is a fresh session). Trigger paths may keep
  null-skipping for a few hours; acceptable.
- If `create_secret` errors on duplicate name, the secret already exists — use
  `select id, name from vault.secrets;` and `vault.update_secret(<id>, '<KEY>')` instead.

### 5.2 Migration `v86` (Tier 3, repo, contains no secrets)

To be authored via `/migration-author` after RFC approval
(`supabase/migrations/v86_pg_net_settings_vault.sql` + rollback + pre-flight). Contents:

```sql
-- a) Locked-down helper -------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;

create or replace function private.service_role_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'service_role_key'
  limit 1;
$$;

revoke all on function private.service_role_key() from public, anon, authenticated;

-- b) notify_admin_new_contractor(): replace the key read ----------------------
--    v_service_key := current_setting('app.service_role_key', true);
--    becomes
--    v_service_key := private.service_role_key();
--    (URL read and NULL guards unchanged.)

-- c) apply_referral_commission(): v52a body + restored D-172 W-9 gate ---------
--    Gate re-inserted between step 4 (load referrer) and step 5 (apply bonus),
--    with corrected stamp ordering:
--
--    IF v_referrer.payments_blocked THEN
--      IF v_referrer.w9_notification_sent_at IS NULL THEN
--        v_supabase_url := current_setting('app.supabase_url', true);
--        v_service_key  := private.service_role_key();
--        IF v_supabase_url IS NOT NULL AND v_service_key IS NOT NULL THEN
--          UPDATE referral_agents SET w9_notification_sent_at = NOW() WHERE id = v_referrer.id;
--          PERFORM net.http_post( ... notify-partner-w9 ... );   -- nested BEGIN/EXCEPTION
--        ELSE
--          RAISE LOG '...settings missing — W-9 email NOT sent, NOT stamped...';
--        END IF;
--      END IF;
--      RETURN NEW;   -- withhold commission + payout_approvals rows
--    END IF;
--
--    The notify-payout-pending call (v52a step 8) switches its key read to
--    private.service_role_key() as well.

-- d) Re-schedule the siding poll (fixes v44's invalid ON CONFLICT form) -------
select cron.schedule(
  'check-siding-design-completion',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/check-siding-design-completion',
    body    := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || private.service_role_key()
    )
  );
  $job$
);
-- cron.schedule() upserts by jobname (v50a precedent). The strict (no missing-ok)
-- current_setting is intentional: if config regresses, the job FAILS VISIBLY in
-- cron.job_run_details / cron_health instead of silently skipping.
```

Apply order: 5.1 first, then 5.2. (Reversed order is safe too — helpers return NULL until the
secret exists and every caller NULL-guards — but 5.1-first means zero additional skipped events.)

### 5.3 Decision point: restore the W-9 gate as designed, or keep v52a behavior?

- **B1 (recommended): restore the gate** (§5.2c). D-172 is a standing decision; v52a's omission
  was unintentional (it says "extends v40" and landed one day after v49 — a merge miss, not a
  reversal). Behavior change: blocked partners' commissions go back to being withheld
  server-side at accrual time.
- **B2: keep v52a behavior**, add only the W-9 email, rely on D-180 manual payout approval as
  the gate. Choose this only if you now consider manual approval the intended control — that
  would supersede part of D-172 and should be recorded as a new D-number.

## 6. Verification & repair

### 6.1 Pre-apply (run with the RFC, results recorded in the pre-flight doc)

```sql
-- The two GUCs are unset (re-confirm for the record)
select current_setting('app.supabase_url', true)  as url_setting,
       current_setting('app.service_role_key', true) is not null as key_is_set;
select setdatabase::regdatabase, setrole::regrole, setconfig from pg_db_role_setting;

-- Which apply_referral_commission is live? (false = W-9 gate missing, confirms §3.1)
select pg_get_functiondef('public.apply_referral_commission'::regproc) like '%payments_blocked%' as w9_gate_live;

-- Does the v44 cron job exist? (resolves §3.2)
select jobname, schedule, active from cron.job order by jobname;

-- Backlog sizing
select count(*) as unnotified_real_contractors
  from contractors
 where status = 'pending_approval'
   and email not ilike '%otterquote-internal.test%'
   and email not ilike '%pfw-%'
   and email not ilike '%authdoctor%';
select count(*) as siding_awaiting_release
  from claims where funding_type = 'cash' and siding_bid_released_at is null;
select count(*) as falsely_stamped_w9
  from referral_agents
 where payments_blocked = true
   and w9_notification_sent_at is not null
   and w9_submitted_at is null;
select count(*) as pending_payout_approvals
  from payout_approvals where status = 'pending_approval';
```

### 6.2 Post-apply

```sql
select setconfig from pg_db_role_setting where setdatabase = 'postgres'::regdatabase; -- shows app.supabase_url
select id, name, created_at from vault.secrets;            -- name only; never select decrypted values in the dashboard
select jobname, schedule, active from cron.job where jobname = 'check-siding-design-completion';
-- after ≥30 min:
select status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'check-siding-design-completion')
 order by start_time desc limit 5;
select id, status_code, error_msg, created from net._http_response order by id desc limit 10;
```

End-to-end probe: create one contractor signup with a real-looking (non-test-pattern) email and
confirm the admin email lands; clean up the row afterward.

### 6.3 Data repair (each gated on Dustin review of the 6.1 counts)

1. **Falsely stamped W-9 rows** (§3.3) — after confirming no Mailgun send exists for them:
   `update referral_agents set w9_notification_sent_at = null where payments_blocked = true and w9_notification_sent_at is not null and w9_submitted_at is null;`
2. **Unnotified contractor signups** — review the 6.1 list in admin-contractors; no SQL needed.
3. **Siding release backlog** — first successful cron run will sweep it; review the 6.1 list
   beforehand so the burst of releases is expected.
4. **Commissions accrued for blocked partners since 2026-04-22** — review `payout_approvals`
   joined to `referral_agents.payments_blocked` before anything auto-approves.

## 7. Phase 2 (separate RFC, after launch pressure allows)

1. Move the EFs to the `CRON_SECRET` pattern (already the documented intent in
   `supabase/config.toml` for `notify-payout-pending`) so the database stops holding the
   service role key entirely; then delete the Vault secret.
2. Rotate the service role key — already mandated by v49's pre-launch security checklist note,
   and now also prudent because it has circulated through manual cron setups (v50a).
3. Evaluate migrating off legacy JWT-style keys to Supabase's newer secret API keys; the EF
   bearer-equality checks and the Vault value must move together.

## 8. Rollback (v86r)

```sql
select cron.unschedule('check-siding-design-completion');
-- restore v85 + v52a function bodies verbatim (GUC reads, no gate)
drop function if exists private.service_role_key();
drop schema if exists private;
alter database postgres reset app.supabase_url;
-- Dustin, dashboard: delete from vault.secrets where name = 'service_role_key';
```

## 9. Costs / risks

- No schema changes; function + cron only. Trigger NULL guards mean a partial apply degrades to
  today's behavior, not worse.
- Restored W-9 gate changes money behavior for blocked partners (why §5.3 is an explicit ask).
- Helper lock-down is load-bearing: `private.service_role_key()` must never be granted to
  `anon`/`authenticated`, and no RPC may wrap it.
