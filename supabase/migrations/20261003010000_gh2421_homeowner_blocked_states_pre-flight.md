# Pre-flight: 20261003010000_gh2421_homeowner_blocked_states (Tier 3A)

NOT APPLIED. Refs #2421 (D-344, amends D-178).

## What it does
- Seeds `platform_settings` key `homeowner_blocked_states` = `["FL","LA","TX"]` (`ON CONFLICT (key) DO NOTHING`; `key` is the PK).
- Creates `public.get_homeowner_blocked_states() RETURNS text[]` (STABLE, SECURITY DEFINER, `search_path = public`). Upper-cases and de-duplicates valid 2-letter codes. Missing row, non-array value, array with no valid code, or any exception returns `{FL,LA,TX}`. An explicit `[]` returns an empty array (operator intent: nothing blocked).
- REVOKE from PUBLIC and anon; GRANT EXECUTE to authenticated only (the dashboard requires auth).
- The RLS allow-list policy on `platform_settings` is untouched (tier 3B, out of scope).

## Danger-pattern check
No column/type/index/rename/truncate/cascade/RLS change. New function in public with a deliberate GRANT to authenticated: the permissions-ratchet CI check will flag it (SECURITY DEFINER + non-service_role grant) and needs the `permissions-ratchet: reviewed` label. The function exposes only a state-code list, no row data.

## Editing the list (no deploy)
`UPDATE public.platform_settings SET value = '["FL","LA","TX","NY"]'::jsonb, updated_at = now() WHERE key = 'homeowner_blocked_states';`

## Applier runbook
1. Apply the forward file.
2. `SELECT public.get_homeowner_blocked_states();` as service role: expect `{FL,LA,TX}`.
3. As an authenticated user via PostgREST: `rpc/get_homeowner_blocked_states` returns `["FL","LA","TX"]`. As anon: 401/403 (no EXECUTE).
4. `has_function_privilege('anon','public.get_homeowner_blocked_states()','EXECUTE')` is false.

Rollback: `supabase/migrations_rollbacks/20261003010000_gh2421_homeowner_blocked_states_rollback.sql`.

## Verification
Local Postgres 16 harness only (see PR body). Not verified against the real schema or production.
