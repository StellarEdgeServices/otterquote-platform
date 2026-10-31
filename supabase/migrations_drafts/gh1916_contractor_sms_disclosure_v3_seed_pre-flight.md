<!-- STATUS (gh-1438, as of 2026-10-31): NOT APPLIED -->
<!-- EVIDENCE: drafted 2026-10-31 under #1916 / #2875; no database was read or written to produce this file. -->
<!-- REPO COPY: none. -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->
# Pre-flight: gh1916_contractor_sms_disclosure_v3_seed

Drafted under #1916 / #2875. Nothing here is applied.

## Do not apply until
1. LEGAL-READ and the CEO `R-177 SIGNED:` are posted on the PR that carries this file, at its head.
2. The brand spelling, program name and version tag are decided (the `Q:` on #1916 asks Ben) and edited into the three constants. The guard in the file refuses a `DRAFT` / `UNSIGNED` id.
3. The `/sms-terms` page is published (wording pack piece 2, approved on #3065). The screen links to it.
4. The R-097 notice for this Tier 3B change has run its window (this is the switch that turns the contractor opt-in on).
5. The Twilio Verify code template is registered (wording pack piece 3), or Dustin accepts the default Verify text in the meantime.

## Read-only checks before the apply
```sql
select to_regclass('public.sms_disclosure_versions');                    -- expect non-null (layer 1 applied)
select id, retired_at from public.sms_disclosure_versions;                -- expect 0 rows
select count(*) from public.contractor_sms_numbers;                       -- expect 0 (nothing can be verified yet)
```

## After the apply
```sql
select id, program_name, effective_at, retired_at from public.sms_disclosure_versions;   -- the one signed row, retired_at null
```
Then the production probe on the closes-on: an `is_test` contractor ticks the box, verifies a number, and a `contractor_sms_numbers` row exists with `verified_at` and this `disclosure_version_id`; a signup that leaves the box unticked has no row. Marty owns the apply and the probe.

## Rollback
`gh1916_contractor_sms_disclosure_v3_seed_rollback.sql`: retires the row (the screen offers nothing again); deletes it only if no consent record references it.
