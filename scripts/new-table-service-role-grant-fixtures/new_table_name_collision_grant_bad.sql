-- GRANT-CHECK-FIXTURE: EXPECT=FAIL
-- Negative control (PR #2201 review 5839752411, finding 2): grant matching
-- must be anchored to the exact identifier, never a substring. This
-- migration creates public.bar and grants service_role only on the
-- unrelated public.foo_bar -- a real table that merely shares a suffix.
-- The pre-fix `_target_matches_table` used an unanchored regex and let
-- `foo_bar` satisfy a check for `bar`, so this used to false-PASS.

BEGIN;

CREATE TABLE IF NOT EXISTS public.bar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Pre-existing, unrelated table. Its grant must never be credited to
-- the brand-new `bar` table above just because the names overlap.
grant select, insert, update, delete on public.foo_bar to service_role;

COMMIT;
