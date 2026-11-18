-- STATUS (gh-1438, as of 2026-11-18T20:26:39Z): NOT APPLIED
-- FILE ROLE: forward file of set c4_contractor_pitch_bands_guard (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: drafted under #1315 (REVIEW: PASS 6990176825 finding; HELD comment 6990289797): contractors.pitch_bands does not exist yet, and when the c4 column is added it is on neither privileged-column list (trg_contractors_privileged_guard / enforce_contractor_privileged_columns, and contractors_freeze_privileged_columns), so a contractor's own UPDATE could write it. Lists read from supabase/migrations/20260703222148_v87_code3_rls_hardening_bundle.sql and supabase/migrations/20261028152549_gh2995_accept_cpa_append_only.sql at main 48235598; NO database was read or written to produce this file.
-- REPO COPY: none in supabase/migrations/
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- gh-1315 / c4: pin contractors.pitch_bands against client writes, and put a shape floor under every writer.
-- Tier 3B (new trigger on a user table + a CHECK constraint). Protective only: it removes capability from client roles and rejects
-- malformed JSON. NOT APPLIED by the authoring session or by CI. Every migration requires Dustin's approval; R-097 notice applies.
-- ORDER: apply AFTER c4_contractor_pitch_bands.sql (the order gate below refuses otherwise). Apply with set lock_timeout = '5s'.
-- Rollback: c4_contractor_pitch_bands_guard_rollback.sql (run it BEFORE c4_contractor_pitch_bands_rollback.sql).
--
-- WHY A NEW TRIGGER AND NOT AN EDIT OF THE EXISTING GUARD FUNCTIONS. Both existing guards would have to be redefined with their whole
-- live bodies copied, and the live body of contractors_freeze_privileged_columns() has been redefined three times (gh1425, gh2443,
-- gh2995; gh3073 leaves it alone); copying a stale body would silently UN-pin a column. A separate BEFORE INSERT OR UPDATE OF
-- pitch_bands trigger touches nothing that exists, matches the precedent of gh2785 (profiles) and is reversible by dropping two objects.
--
-- SEMANTICS (same as contractors_freeze_privileged_columns): only a direct end-user write is constrained (current_user =
-- 'authenticated'). service_role (Edge Functions, cron), SECURITY DEFINER functions and the admin account are exempt. A client INSERT
-- is born with pitch_bands NULL; a client UPDATE of pitch_bands is silently pinned to the stored value (no error), exactly like the
-- other pinned columns. If a contractor-facing editor is built later, it must write through a SECURITY DEFINER RPC that validates the
-- shape (or this trigger is dropped and the CHECK below stays as the floor); see the PR body for the recommendation.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contractors' and column_name = 'pitch_bands'
  ) then
    raise exception 'c4_contractor_pitch_bands_guard: apply c4_contractor_pitch_bands.sql first (contractors.pitch_bands does not exist)';
  end if;
end
$$;

create or replace function public.contractors_pin_pitch_bands()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Only constrain direct end-user (authenticated) writes; service_role and SECURITY DEFINER callers run as another role.
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Admin account is exempt (mirrors contractors_freeze_privileged_columns).
  if coalesce(auth.jwt() ->> 'email', '') = 'dustinstohler1@gmail.com' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.pitch_bands := null;
  else
    new.pitch_bands := old.pitch_bands;
  end if;
  return new;
end;
$function$;

drop trigger if exists contractors_pin_pitch_bands on public.contractors;
create trigger contractors_pin_pitch_bands
  before insert or update of pitch_bands on public.contractors
  for each row execute function public.contractors_pin_pitch_bands();

-- Shape floor for EVERY writer, service_role included. Deliberately loose (the strict validator is sanitizePitchBands in
-- create-docusign-envelope, which falls back to the default bands on anything else): an object, at most 4096 bytes of text, whose
-- "bands" is an array of 1 to 12 entries. The column is new and all-NULL, so the constraint scans no data.
alter table public.contractors drop constraint if exists contractors_pitch_bands_shape_chk;
alter table public.contractors
  add constraint contractors_pitch_bands_shape_chk
  check (
    pitch_bands is null
    or (
      jsonb_typeof(pitch_bands) = 'object'
      and octet_length(pitch_bands::text) <= 4096
      and case when jsonb_typeof(pitch_bands -> 'bands') = 'array'
               then jsonb_array_length(pitch_bands -> 'bands') between 1 and 12
               else false end
    )
  );
