-- GRANT-CHECK-FIXTURE: EXPECT=PASS
-- Positive control matching the vendor notice's own required shape
-- verbatim (gh-2145 issue body) for a table that IS meant to be reachable
-- by anon/authenticated as well as service_role.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contractor_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE public.contractor_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contractor reads own notes" ON public.contractor_notes
  FOR SELECT USING (auth.uid() = contractor_id);

grant select on public.contractor_notes to anon;
grant select, insert, update, delete on public.contractor_notes to authenticated;
grant select, insert, update, delete on public.contractor_notes to service_role;

COMMIT;
