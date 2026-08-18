-- gh-886: Narrow the referral_agents payout-governing write surface
-- Tier 3B, R-097 24h notice served 2026-08-18T11:37:10Z (issue #886 comment
-- 5327596693, corrected 5332180631) and fast-pathed same-day per Dustin's
-- CEO-board approval ("Q3: Approved - fast path it"). Branch-verified
-- 2026-08-17 against a disposable Supabase branch: 5/5 probes passed
-- (2 negative payout-column blocks, 1 negative DELETE silent-deny, 1
-- positive partner profile-column write, 1 positive admin payout-column
-- write), rollback confirmed exact restore. Re-verified live against prod
-- immediately after apply (2026-08-18T21:1xZ): P1 (self-clear
-- payments_blocked) -> 42501 as designed; P4 (genuine profile column) ->
-- succeeds; P3 (DELETE own row) -> silently blocked, 0 rows removed.
--
-- Full brief: Docs/gh-886-referral-agents-payout-tier3b-brief.md (PR #981)
-- Full migration package + probe results: issue #886 comments
-- 5321087654 (R-097 notice) and 5321092379 (migration package).
--
-- Rollback: supabase/migrations_rollbacks/gh886_referral_agents_payout_guard_rollback.sql

begin;

revoke update on public.referral_agents from anon;

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
