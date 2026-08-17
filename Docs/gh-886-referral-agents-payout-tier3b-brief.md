# gh-886 — `referral_agents` Payout-Column Write Surface: Pre-Drafted R-097 Tier-3B Brief

**Status: DRAFT. NOT POSTED. NOT A NOTICE. The 24-hour clock has not started.**

Written per gh-886's Tier-3B label and the R-097 requirement that destructive SQL against a
payment-adjacent table gets a 24-hour notice window before it runs. Nothing in this document
authorizes any action. Its only purpose is to let whoever posts the real R-097 notice do so by
copying the **Notice text** section below, without reconstructing scope/evidence/rollback from
scratch at that moment. No DDL/DML was run to produce this brief — every claim below is
`SELECT`/`pg_catalog`-sourced, re-verified live against project `yeszghaspzwwstvsrioa` on
2026-08-17, after the issue's original 2026-08-14 evidence pass.

## Why this is Tier 3B

Per R-109 (tier by consequence): the change is schema-only (grants, an RLS policy split, one
trigger), but what it protects is the payout gate, W-9 compliance attestation, commission
rollups, and the D-142 forward-only-accrual floor for a live, partially-claimed table (7 of 12
rows have an owner today). Getting the REVOKE/policy split wrong in either direction — too loose
and the hole stays open; too tight and it silently breaks the admin panel's direct-table payout
writes (see Finding 2 below) — has real payout consequences. That is squarely R-097's "all but
money & legal" boundary: technical, but consequential enough to earn the 24-hour window.

## Fresh evidence pass (2026-08-17) vs. the issue's 2026-08-14 snapshot

All queries below were re-run today, read-only, via the Supabase MCP against
`yeszghaspzwwstvsrioa`.

### The 8/14 facts — CONFIRMED, unchanged

- **Row counts**: `12 total / 7 claimed (user_id set) / 1 unblocked (payments_blocked=false) / 0
  W-9-verified`. Identical to the issue's `12 / 7 / 1 / 0`. (Issue #950, filed today by the
  Bridge, independently corroborates "5 unclaimed `referral_agents` rows" — 12 − 7 = 5, consistent,
  not a new fact.)
- **Policy `Agents can manage own profile`**: still `cmd = '*'` (ALL), `USING`/`WITH CHECK` both
  `(user_id = ( SELECT auth.uid() AS uid))`. Still row-scoped only, as the issue said.
- **Column-level UPDATE grants**: confirmed present for `authenticated` AND `anon` on all 8 named
  columns (`payments_blocked`, `w9_verified_at`, `recruited_at`, `recruited_by_id`,
  `total_commission_earned`, `recruit_earnings`, `status`, `is_test`). Re-running
  `information_schema.column_privileges` today shows this is actually the **full column list**
  (every column on the table, ~34 of them) — expected, since it reflects one table-wide `GRANT
  UPDATE ON referral_agents TO authenticated, anon` rather than a per-column grant. Confirms the
  issue's "table-wide UPDATE grants" framing; not a new fact, just full context.
- **Triggers**: still only `referral_agents_generate_code` and
  `referral_agents_generate_recruit_code` (both `BEFORE INSERT`, both code generators). No guard
  trigger exists. Confirmed today.
- **`register_partner()`**: exists, `prosecdef=true` (SECURITY DEFINER), `EXECUTE` granted to
  `anon`/`authenticated`/`service_role`. No `rate_limit_config` row exists for
  `register_partner` — confirmed empty today (relevant to the #973 cross-check below, not to this
  issue's fix).

### Two things the 8/14 snapshot did not surface — found during this pass

**Finding 1 — the same `FOR ALL` policy also permits DELETE, and one FK is `ON DELETE CASCADE`.**
The issue's title and body scope the exposure to UPDATE. But `Agents can manage own profile` is
`FOR ALL`, which includes DELETE, and the table-wide grant to `authenticated`/`anon` includes
`DELETE` (confirmed via `information_schema.role_table_grants`: both roles hold
DELETE/INSERT/SELECT/UPDATE/TRUNCATE/TRIGGER/REFERENCES on this table). A claimed partner
(`user_id = auth.uid()`) can therefore **delete their own `referral_agents` row today** — and
`referrals.referral_agent_id_fkey` is `FOREIGN KEY (referral_agent_id) REFERENCES
referral_agents(id) ON DELETE CASCADE` (confirmed via `pg_constraint`), so that DELETE
cascade-deletes every `referrals` row attributed to that partner — the entire commission/audit
trail, not just the profile row. (`claims.referral_agent_id_fkey`,
`referral_agents.recruited_by_id_fkey`, and `payout_approvals.partner_id_fkey` are all `ON DELETE
SET NULL`, so those are merely orphaned, not cascade-deleted — still a data-integrity loss, just
not as severe.) **This is a materially bigger finding than the issue as filed** — it means a
partner disputing their commission total, or about to be caught with a self-set
`payments_blocked=false`, can destroy the evidence outright. Section "The migration" below closes
this as a side effect of replacing `FOR ALL` with explicit per-command policies that simply omit
a partner-scoped DELETE policy — but it needs to be stated as a deliberate decision, not an
accident, which is why it's called out here.

**Finding 2 — the issue's literal AC #1 (revoke the 8 columns from `authenticated`) would break
the live admin panel.** `admin-referrals.html` (lines 714–718, 729–735) and its React port
`react-app/app/admin/referrals/page.tsx` (lines 151–155, 173–179, via
`react-app/app/admin/referrals/utils.ts` `verifyW9Payload`/`unblockPayload`) write
`w9_verified_at` and `payments_blocked` via **direct client-side `.from('referral_agents').update()`
calls**, gated only by the `Admin can update referral agents` RLS policy (`is_admin_email()`) —
**not** by a distinct Postgres role. Supabase has no separate "admin" database role; an admin's
browser session authenticates as the same `authenticated` Postgres role as any partner. Column-
level `REVOKE UPDATE (payments_blocked, w9_verified_at, ...) FROM authenticated` is enforced at
parse/rewrite time, **before** RLS policies or triggers ever run — so revoking those columns from
`authenticated` blanket-blocks the admin's own W-9-verify and manual-unblock buttons along with
the partner exposure the issue is trying to close. The issue's own AC #4 (add a BEFORE UPDATE
guard checking `service_role` or `is_admin_email()`) is the mechanism built to distinguish admin
from partner — but it can only run if `authenticated` still holds the column grant. **The
migration below revokes the 8 columns from `anon` only, keeps `authenticated`'s existing grant,
and makes the trigger guard the actual enforcement layer for the admin/partner distinction** (not
"defense in depth" as the issue's phrasing suggests — for `authenticated`, it is the *only*
depth). This is stated as the brief's recommendation, not the issue's literal AC, because the
literal AC is untested against live code and would regress the admin panel.

  *(For completeness: `agent_type` — also directly updated by the admin panel via
  `changeAgentType()` — was never in the issue's 8-column list, so it's unaffected by the REVOKE
  either way; not a Finding, just a boundary check that the enumeration below covers.)*

### Cross-check against work filed since 8/14 (register_partner / rate-limit triage)

- **#944** (Bridge, 2026-08-17): first-class triage of 74 SECURITY DEFINER + anon-executable
  advisor WARNs. `register_partner` and `track_referral_click` are both in that population, but
  #944 explicitly delegates specific fixes to child issues — it does not itself propose touching
  `referral_agents` grants or policies. No collision.
- **#973** (child of #944, today): `register_partner()` is missing the `check_rate_limit(...)`
  gate that its sibling RPC `track_referral_click` has — an anon-abuse/spam surface on *row
  creation* (unlimited `referral_agents` INSERTs). Confirmed independently in this pass: no
  `rate_limit_config` row exists for `register_partner` yet. **This is a different write surface
  than gh-886** (#973 is about unauthenticated INSERT volume via a SECURITY DEFINER RPC; gh-886 is
  about authenticated UPDATE/DELETE column/row scope via RLS+grants on the table directly). The
  two fixes touch different objects (a function body vs. table grants/policies/trigger) and don't
  conflict, but both land as separate Tier-3 migrations against the same table — whoever executes
  either should `list_migrations` first to avoid a stale-branch collision, not because the SQL
  itself overlaps.
- **#970**: six *different* SECURITY DEFINER functions (`acknowledge_alert`, `check_rate_limit`,
  `cleanup_old_rate_limits`, `record_cron_health`, `update_keepalive_health`) — unrelated table,
  no overlap.
- **#972**, **#974**: `get_contractor_quote_claim_ids` and `upsert_adjuster_from_claim` — unrelated
  tables, no overlap.
- **Net**: no premise in the original issue has moved. The two findings above are additions the
  original evidence pass didn't reach (DELETE/CASCADE exposure; admin-panel-breaking literal AC),
  not corrections of anything that changed between 8/14 and today.

## The migration (drafted here only — NOT applied, NOT placed in `supabase/migrations/`)

Filename convention when this is actually authored via `migration-author-code`:
`sql/v11X-referral-agents-payout-column-guard.sql` / `sql/v11X-rollback-referral-agents-payout-column-guard.sql`
(next available `vNNN` at execution time — do not hardcode `v11X` without checking
`list_migrations` first, per `run-work-code-orchestration-gotchas`).

### Forward

```sql
-- ============================================================================
-- gh-886: Narrow the referral_agents payout-governing write surface
-- ============================================================================
-- A signed-in referral partner can currently UPDATE (and, via the same FOR ALL
-- policy + table-wide grant, DELETE) their own payments_blocked, w9_verified_at,
-- recruited_at, recruited_by_id, total_commission_earned, recruit_earnings,
-- status, and is_test columns. See gh-886 for full evidence.
--
-- Strategy (see brief Finding 2 for why this differs from the issue's literal
-- AC #1): revoke UPDATE on the 8 payout-governing columns from `anon` only —
-- anon has no legitimate write path on this table (confirmed: the "claim"
-- policy requires a JWT email claim anon never has, and "manage own profile"
-- requires user_id = auth.uid() which is NULL for anon and never matches).
-- `authenticated` KEEPS its column grant, because the admin panel's direct
-- .update() calls for payments_blocked/w9_verified_at run as `authenticated`
-- and are gated only by RLS (is_admin_email()), not by a distinct DB role.
-- The BEFORE UPDATE trigger below is therefore the real enforcement layer
-- distinguishing admin writes from partner writes on these 8 columns.
-- ============================================================================

begin;

-- 1. Anon has no legitimate write path on this table at all (AC5 audit
--    answer: it should not have UPDATE). Revoke table-wide, not just the 8
--    columns — closes the vestigial grant entirely.
revoke update on public.referral_agents from anon;

-- 2. Replace the FOR ALL policy with explicit per-command policies so a
--    future column addition doesn't silently reopen this, and so DELETE is
--    no longer implicitly available to partners (closes Finding 1 — the
--    ON DELETE CASCADE from referrals.referral_agent_id_fkey).
--    Scoped explicitly TO authenticated (was PUBLIC/"-"): anon can never
--    satisfy user_id = auth.uid() anyway, this just makes that explicit.
drop policy if exists "Agents can manage own profile" on public.referral_agents;

create policy "Agents can view own profile"
  on public.referral_agents
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "Agents can update own profile"
  on public.referral_agents
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No partner-scoped DELETE or INSERT policy is created. INSERT for the
-- unclaimed-registration path remains covered by the pre-existing
-- "Public can register as partner" policy (untouched). DELETE is now
-- unreachable for authenticated non-admin callers (default-deny under RLS
-- with no matching permissive policy) — this is the fix for Finding 1.

-- 3. BEFORE UPDATE guard: the actual enforcement for the 8 payout-governing
--    columns against `authenticated`. Raises unless the caller is
--    service_role or passes is_admin_email(). Also makes the D-142
--    forward-only-accrual floor (recruited_at) tamper-evident per the
--    issue's own framing.
create or replace function public.referral_agents_guard_payout_columns()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if is_admin_email() then
    return new;
  end if;

  if (new.payments_blocked           is distinct from old.payments_blocked)
     or (new.w9_verified_at          is distinct from old.w9_verified_at)
     or (new.recruited_at            is distinct from old.recruited_at)
     or (new.recruited_by_id         is distinct from old.recruited_by_id)
     or (new.total_commission_earned is distinct from old.total_commission_earned)
     or (new.recruit_earnings        is distinct from old.recruit_earnings)
     or (new.status                  is distinct from old.status)
     or (new.is_test                 is distinct from old.is_test)
  then
    raise exception
      'referral_agents: payout-governing columns can only be changed by service_role or an admin (gh-886)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists referral_agents_guard_payout_columns on public.referral_agents;

create trigger referral_agents_guard_payout_columns
  before update on public.referral_agents
  for each row
  execute function public.referral_agents_guard_payout_columns();

commit;
```

### Rollback

```sql
-- ============================================================================
-- gh-886 ROLLBACK: restore the pre-fix write surface
-- ============================================================================
begin;

drop trigger if exists referral_agents_guard_payout_columns on public.referral_agents;
drop function if exists public.referral_agents_guard_payout_columns();

drop policy if exists "Agents can view own profile" on public.referral_agents;
drop policy if exists "Agents can update own profile" on public.referral_agents;

create policy "Agents can manage own profile"
  on public.referral_agents
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant update on public.referral_agents to anon;

commit;
```

*(Rollback restores exact pre-fix behavior, including the DELETE/CASCADE exposure from Finding 1
and the anon UPDATE grant from Finding 2's audit — this is intentional: a rollback's job is to
undo the change, not to leave a partial fix in place. If rollback is ever actually needed, treat
it as "stop the bleeding on a regression," then re-plan the fix, not as an acceptable end state.)*

## Verification probes (run post-apply, on a Supabase branch first, per
`migration-author-code`'s pre-flight requirement — never against production rows for the negative
probe)

**Positive — partner can still update genuine profile columns:**
```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<a-real-claimed-partner-user_id>", "role": "authenticated"}';
update public.referral_agents
  set phone = phone, company = company  -- no-op update of allowed columns
  where user_id = '<same-user_id>';
-- Expect: success, 1 row affected.
reset role;
```

**Negative — partner cannot flip `payments_blocked` or any other payout column:**
```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<a-real-claimed-partner-user_id>", "role": "authenticated"}';
update public.referral_agents
  set payments_blocked = false
  where user_id = '<same-user_id>';
-- Expect: ERROR 42501, "payout-governing columns can only be changed by
-- service_role or an admin (gh-886)"
reset role;
```

**Negative — partner cannot DELETE their own row:**
```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<a-real-claimed-partner-user_id>", "role": "authenticated"}';
delete from public.referral_agents where user_id = '<same-user_id>';
-- Expect: 0 rows affected (RLS default-deny, no matching policy) — not an
-- error, PostgREST/RLS DELETE with no matching policy silently affects 0
-- rows rather than raising.
reset role;
```

**Positive — admin panel's direct writes still work (Finding 2's whole reason for this design):**
```sql
set local role authenticated;
set local request.jwt.claims = '{"sub": "<an-admin-user-uuid>", "email": "<the is_admin_email() address>", "role": "authenticated"}';
update public.referral_agents
  set w9_verified_at = now()
  where id = '<any-referral_agents-id>';
-- Expect: success — is_admin_email() branch in the trigger returns NEW
-- unconditionally, column grant on authenticated is untouched.
reset role;
```

**`register_partner()` end-to-end re-verify (issue AC5 — "should be unaffected, confirm don't
assume"):**
1. Call `register_partner(...)` with a fresh test email via the anon key (same path
   `refer-a-friend.html` / `react-app/app/refer/page.tsx` use).
2. Confirm the row is created (SECURITY DEFINER INSERT path — the function owner's privileges
   govern the INSERT, not the caller's grants, so the anon UPDATE revoke and the new UPDATE
   policies should not touch it; if `relforcerowsecurity` were `true` this would need re-checking,
   but it is confirmed `false` on this table today, so table-owner/SECURITY DEFINER writes are not
   RLS-forced here).
3. Confirm no `w9_verified_at`/`payments_blocked`/etc. columns are touched by the RPC's INSERT
   (they default `NULL`/`true` per the baseline schema) — i.e. the guard trigger, which only fires
   on UPDATE, never engages on this path at all, so there is nothing for it to block.
4. If it fails, the fault is almost certainly the anon UPDATE revoke reaching somewhere
   unexpected inside the function body (e.g. an internal upsert-by-email branch) — grep
   `sql/v95-referral-attribution-rpc.sql` for any `UPDATE` statement inside `register_partner`
   before assuming the REVOKE is the cause; the function's INSERT path is the documented one.

## Risk / blast radius

**Who is affected:** the 7 claimed `referral_agents` rows (real partners with `user_id` set)
lose the ability to self-modify their payout gate, W-9 attestation, commission totals, recruit
lineage, and test flag, and lose the ability to delete their own row outright. The 5 unclaimed
rows (#950) are unaffected either way — no `user_id` means the "manage own profile" policy family
never matched them regardless of this fix.

**Every client code path that writes to `referral_agents`, enumerated (grepped from this
worktree, `search_code` unavailable per #690):**

| # | File : line | Writer | Columns written | RLS policy relied on | Affected by this fix? |
|---|---|---|---|---|---|
| 1 | `react-app/app/lib/partner-record.ts:86` | partner (claim-link) | `user_id` only | `Authenticated can claim unclaimed partner record` | No — different policy, untouched, doesn't touch the 8 columns |
| 2 | `react-app/app/partner/dashboard/page.tsx:773-778` | partner (profile self-edit) | `first_name,last_name,email,phone,company,service_area,website,bio` | `Agents can manage own profile` → becomes `Agents can update own profile` | No column overlap with the 8 — continues to work under the renamed policy |
| 3 | `partner-dashboard.html:2225-2230` | partner (profile self-edit, static twin of #2) | same as #2 | same as #2 | Same as #2 |
| 4 | `admin-referrals.html:715-718` | admin (`verifyW9`) | `w9_verified_at` | `Admin can update referral agents` (`is_admin_email()`) | **Would break under the issue's literal AC #1; does NOT break under this brief's design** (Finding 2) |
| 5 | `admin-referrals.html:732-735` | admin (`manualUnblock`) | `payments_blocked` | same | Same as #4 |
| 6 | `admin-referrals.html:815-818` | admin (`changeAgentType`) | `agent_type` | same | No — `agent_type` was never in the 8-column list |
| 7 | `react-app/app/admin/referrals/page.tsx:151-155` (via `utils.ts:208-210`) | admin (React `handleVerify`) | `w9_verified_at` | same | Same as #4 |
| 8 | `react-app/app/admin/referrals/page.tsx:173-179` (via `utils.ts:220-222`) | admin (React unblock) | `payments_blocked` | same | Same as #4 |
| 9 | `react-app/app/admin/referrals/page.tsx:205-213` | admin (React agent-type change) | `agent_type` | same | Same as #6 |
| — | `supabase/functions/submit-partner-w9/index.ts:187-190` | EF, `service_role` client | `w9_file_url, w9_submitted_at, payments_blocked` | RLS bypassed (service_role) | No — service_role untouched by any grant/policy change here |
| — | `supabase/functions/process-payout-reminders/index.ts:717-720` | EF, `service_role` client | `w9_notification_sent_at` | RLS bypassed | No — not one of the 8 columns, and service_role untouched regardless |
| — | `tests/e2e/seed/seed.mjs` | test seed, `service_role` client | various (INSERT) | RLS bypassed | No |

Enumeration method: `grep -riE "referral_agents" --files-with-matches` across the worktree (88
files matched broadly), narrowed to `.update(`/`.delete(`/`.insert(` call sites within ~80 chars
of a `.from('referral_agents')` chain, then manually read each hit. No file outside this table
lists a code path that mutates it.

**What could break if this migration is drafted differently than above:**
- Literal issue AC #1 (revoke the 8 columns from `authenticated` too) → breaks rows 4/5/7/8 above
  (admin W-9 verify + manual unblock, both HTML and React surfaces) — this is Finding 2, already
  designed around.
- Adding a DELETE policy scoped to `user_id = auth.uid()` "for symmetry" → reopens Finding 1 (the
  CASCADE-delete of the partner's own `referrals` history). Deliberately not done.
- Forgetting `to authenticated` on the two new policies (leaving them `PUBLIC`) → harmless in
  practice (anon can't satisfy `user_id = auth.uid()`) but re-widens the surface for no reason;
  keep the explicit scoping.

**Rollback trigger conditions:** apply the rollback SQL above if, after this ships, (a) any
partner-facing profile-edit save (rows 2/3) starts failing — would indicate the new UPDATE policy
or the guard trigger is catching a column it shouldn't; check the trigger's `IS DISTINCT FROM`
list against the actual `updates` payload first, since the fix is additive to the fastest
diagnosis, not necessarily the migration; (b) the admin W-9-verify or manual-unblock buttons start
erroring — would indicate `is_admin_email()` is evaluating differently under the trigger's
`SECURITY DEFINER` context than it does under a plain RLS `USING` clause (different execution
context — worth an explicit pre-merge check, not just a probe); (c) `register_partner()` signups
stop creating rows.

**R-097 24-hour notice window mechanics:**
- **Notice date**: whenever this brief's "Notice text" section below is actually posted to gh-886
  as a comment — that post, not this brief's creation, starts the clock. This brief itself starts
  nothing.
- **Objection channel**: a reply from Dustin on the gh-886 issue thread, or an explicit verbal/chat
  override, before the 24 hours elapse.
- **Expiry behavior**: absent an objection or an earlier explicit go-ahead, the migration in this
  brief becomes executable by whichever session next claims gh-886 with the window closed — that
  session still runs the verification probes on a branch first (per `migration-author-code`) before
  applying to the main project; the 24-hour clock is a notice window, not a skip-the-branch-test
  license.

## Notice text (copy this verbatim when Dustin says post it)

> **R-097 24-HOUR NOTICE — gh-886 `referral_agents` Payout-Column Write-Surface Fix**
>
> Posting this notice starts the 24-hour window. Absent an objection or an earlier explicit
> go-ahead from Dustin, the following ships after the window closes:
>
> 1. `REVOKE UPDATE ON public.referral_agents FROM anon` (table-wide — anon has no legitimate
>    write path on this table today).
> 2. Replace policy `Agents can manage own profile` (FOR ALL) with two explicit policies:
>    `Agents can view own profile` (SELECT) and `Agents can update own profile` (UPDATE), both
>    scoped `TO authenticated`, `user_id = auth.uid()`. No partner-scoped DELETE policy is added —
>    this intentionally closes a DELETE/CASCADE exposure found during this brief's evidence pass
>    (see "Finding 1").
> 3. Add trigger `referral_agents_guard_payout_columns` (BEFORE UPDATE) raising unless the caller
>    is `service_role` or passes `is_admin_email()`, when any of `payments_blocked`,
>    `w9_verified_at`, `recruited_at`, `recruited_by_id`, `total_commission_earned`,
>    `recruit_earnings`, `status`, or `is_test` changes. `authenticated`'s column-level UPDATE
>    grant on these 8 columns is deliberately NOT revoked — the admin panel's direct
>    `.update()` calls for `payments_blocked`/`w9_verified_at` depend on it; the trigger is the
>    real enforcement layer (see "Finding 2").
>
> Full evidence, migration SQL, verification probes, and blast-radius enumeration:
> `Docs/gh-886-referral-agents-payout-tier3b-brief.md`.
>
> Preconditions before this notice is posted for real: none outstanding — the fresh evidence pass
> in this brief re-confirmed every fact the issue rests on as of 2026-08-17. This is ready to post
> whenever Dustin wants the clock started.

---
*Drafted by run-work Code, `rw-gh886brief-f22-c4a7`, 2026-08-17, per gh-886 (Tier 3B, R-097).*
