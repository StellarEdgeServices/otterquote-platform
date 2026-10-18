<!-- STATUS (gh-1438, as of 2026-10-14T15:27:36Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2442_payment_failures_revoke_authenticated_writes -->
<!-- EVIDENCE: see the forward file header; the SELECTs below were NOT run by the authoring session -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2442_payment_failures_revoke_authenticated_writes (Tier 3B, NOT APPLIED)

Issue #2442. Protective: removes `authenticated`'s INSERT, DELETE, TRUNCATE, REFERENCES and TRIGGER on `public.payment_failures`. Keeps SELECT and UPDATE.

## SELECTs to run on production before the apply (read-only) and after
```sql
-- 1. which of the seven table privileges `authenticated` holds (expect before: all seven; after: SELECT, UPDATE only)
select p, has_table_privilege('authenticated','public.payment_failures',p) as held
from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p order by 1;

-- 2. policies on the table (expect admin_select, admin_update, contractor_select_own; nothing for INSERT/DELETE)
select polname, polcmd, polroles::regrole[] from pg_policy where polrelid='public.payment_failures'::regclass;

-- 3. negative control: a table that should be untouched by this change keeps its grants
select has_table_privilege('authenticated','public.claims','SELECT') as claims_select_still_held;

-- 4. row count (expect 0 on 2026-10-13; the REVOKE touches no rows)
select count(*) from public.payment_failures;
```

## What would break
Nothing in the repository writes `payment_failures` as `authenticated` with INSERT or DELETE (grep of `*.html`, `*.ts`, `*.tsx`, `*.js` outside `supabase/functions/`: the only table access is two SELECTs and the legacy retry UPDATE, which this set leaves alone). Edge Functions use the service role.

## Apply and undo
Apply: the forward file, in one transaction (self-checking). Undo: the rollback file. Tier 3B: R-097 24-hour notice, REVIEW and R-177 first.
