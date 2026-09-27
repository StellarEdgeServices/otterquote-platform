-- gh-2238: Guard public.claims.measurement_shape against homeowner self-service writes
-- Requested-by: exec:cto (Marty, CTO RUN 42, cto-2026-09-26T20:52:44Z), finding
-- from the independent review of PR #2236 (comment 5850578681, "finding C").
--
-- Premise, read-only on prod (yeszghaspzwwstvsrioa), captured 2026-09-27:
--   - "Users can update own claims" RLS UPDATE policy: qual/with_check both
--     just `user_id = auth.uid()` -- no column restriction, so it does not
--     stop a homeowner writing measurement_shape.
--   - information_schema.column_privileges on public.claims.measurement_shape:
--     both anon and authenticated hold column-level UPDATE (and INSERT).
--   - No existing trigger on public.claims references measurement_shape (7
--     triggers total: after_claim_completed, after_claim_completed_rebate,
--     claims_payment_method_guard, claims_updated_at,
--     trg_claims_advance_referral, trg_claims_copy_first_touch,
--     trg_notify_admin_new_claim).
--   - Only legitimate writer in the repo: admin-measurements.html:695
--     (`sb.from('claims').update({ measurement_shape: 'full' })`), run from
--     the signed-in admin's OWN session (not service_role) and gated
--     client-side by isAdmin plus DB-side by RLS policy `claims_admin_update`
--     (`is_admin_email()`). A pure `auth.role() = 'service_role'` check would
--     therefore break this writer -- the guard below also allows
--     `is_admin_email()`, matching gh-886's identical shape
--     (referral_agents_guard_payout_columns,
--     20260818211118_gh886_referral_agents_payout_guard.sql).
--   - Homeowner claim INSERT ("Users can insert own claims", with_check
--     user_id = auth.uid()) also has no column restriction and the same
--     column-level INSERT grant exists for authenticated -- a homeowner could
--     set measurement_shape at claim-creation time too, so the guard covers
--     INSERT as well as UPDATE.
--
-- Effect exploited before this fix: a homeowner PATCHing their own claim's
-- measurement_shape to 'full' makes the #1411 D-317 payment-intent gate
-- (`evaluateMeasurementUpgradeGate`) refuse every contractor's upgrade
-- purchase on that claim (ALREADY_DETAILED) even though no detailed report
-- was ever delivered.
--
-- Chosen control: narrowest -- a BEFORE INSERT OR UPDATE trigger that blocks
-- only a change/preset of measurement_shape unless the caller is
-- service_role or an admin (is_admin_email()). No column-level REVOKE: the
-- admin writer authenticates as `authenticated` (its own admin session, not
-- service_role), so a table- or column-level REVOKE from `authenticated`
-- would break admin-measurements.html's flip-on-deliver flow. The trigger
-- leaves every other column and every other writer of claims completely
-- untouched.
--
-- Tier: protective-only (removes capability from an attacker, adds none) --
-- R-134 fast-path candidacy is the CTO's call; full R-097 24h window is the
-- fallback. Also needs an executive-dispatched REVIEW + LEGAL-READ/R-177
-- path (money gate) and an APPLY-DECISION before this is applied to prod.
--
-- Rollback: supabase/migrations_rollbacks/gh2238_measurement_shape_guard_rollback.sql

begin;

create or replace function public.claims_guard_measurement_shape()
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

  if tg_op = 'INSERT' then
    if new.measurement_shape is not null then
      raise exception
        'claims.measurement_shape can only be set by service_role or an admin (gh-2238)'
        using errcode = '42501';
    end if;
  else
    if new.measurement_shape is distinct from old.measurement_shape then
      raise exception
        'claims.measurement_shape can only be changed by service_role or an admin (gh-2238)'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists claims_guard_measurement_shape on public.claims;

create trigger claims_guard_measurement_shape
  before insert or update on public.claims
  for each row
  execute function public.claims_guard_measurement_shape();

commit;
