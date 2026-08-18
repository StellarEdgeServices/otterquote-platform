-- gh886_referral_agents_payout_guard_rollback.sql
-- Rollback for: 20260818211118_gh886_referral_agents_payout_guard.sql
-- GitHub: #886
--
-- Exact restore, captured verbatim from live pg_policy/grants before the
-- forward migration was applied (issue #886 comment 5321092379). Branch-
-- verified 2026-08-17: post-rollback, the pre-fix exploit reproduces exactly
-- (partner can flip payments_blocked again) — confirming this is a true
-- restore, not a partial fix left in place. Restoring this REOPENS the
-- privilege-escalation hole gh-886 exists to close — only run it if the
-- forward migration is actively breaking partner profile saves, admin
-- W-9-verify/unblock, or register_partner() signups.

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
