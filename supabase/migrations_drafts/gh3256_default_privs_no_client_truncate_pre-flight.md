<!-- STATUS (gh-1438, as of 2026-10-30T21:30:00Z): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh3256_default_privs_no_client_truncate (forward and rollback beside it) -->
<!-- EVIDENCE: drafted 2026-10-30 under #3256; production read-only (SELECT) the same day, project yeszghaspzwwstvsrioa; no database was written. -->
<!-- REPO COPY: none. DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh3256_default_privs_no_client_truncate (#3256)

Tier 3B: a default-privilege change. Follows the R-097 24-hour notice. Project P18. Follow-up to #3240 / PR #3252, review 6527318575, finding 2.

## 1. Production facts (read-only, 2026-10-30, PG 17.6)

| fact | value |
|---|---|
| `pg_default_acl` (postgres, public, tables) | `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}` |
| `pg_default_acl` (supabase_admin, public, tables) | the same, grantor `supabase_admin` |
| migration / MCP `current_user` | `postgres`, `rolsuper = false` |
| `pg_has_role('postgres','supabase_admin','MEMBER')` | **false** (postgres is a member of anon, authenticated, service_role, authenticator, supabase_privileged_role and the pg_* roles) |
| owners of public relations | postgres: 63 tables, 11 views. supabase_admin owns none. |
| existing tables with client TRUNCATE | 42 (anon) / 43 (authenticated) tables. These are #3252's scope, not this file's. |

## 2. Can the migration role alter supabase_admin's defaults? No.

`ALTER DEFAULT PRIVILEGES FOR ROLE x` needs membership in `x` (or superuser). postgres has neither. The proof reproduces this on a cluster bootstrapped as `supabase_admin`, with `postgres` as a non-superuser non-member: the statement fails with `ERROR: permission denied to change default privileges`.

So:
- The forward changes **postgres's** defaults only.
- The **fallback #3256 asks for ships in the same PR.** `scripts/new-table-truncate-revoke-check.py` and `.github/workflows/new-table-truncate-revoke.yml` fail any PR whose migration diff creates a public table without `REVOKE TRUNCATE` (or `REVOKE ALL`) on it from anon and authenticated, after the CREATE and not granted back.
- On recent main the gate is quiet: the 8 newest table-creating migrations all pass (they already `REVOKE ALL`). It is not a required check yet; adding it is a repository-settings change.

If the Management API apply path ever runs as a superuser, it could also alter `supabase_admin`'s defaults. That would be a separate, explicit change, not a conditional branch in this file.

## 3. What changes

- **New tables `postgres` creates in `public`:** anon and authenticated get `arwdxtm` (no `D`). service_role keeps `arwdDxtm`. SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER/MAINTAIN are unchanged.
- **Unchanged:**
  - existing tables
  - the sequence and function defaults
  - supabase_admin's defaults
  - the defaults in other schemas
- The forward's assertions refuse the commit if:
  - client TRUNCATE remains;
  - any other client default privilege is lost;
  - service_role loses TRUNCATE.

## 4. Apply

1. Run the forward through the normal migration path, as `postgres`.
2. Run the closes-on query: `select defaclrole::regrole, defaclacl from pg_default_acl where defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r';`
   - The postgres row should show `anon=arwdxtm/postgres,authenticated=arwdxtm/postgres`. Today it is `arwdDxtm`.
   - The supabase_admin row stays `arwdDxtm`. That row is covered by the CI gate, not this file.
3. Optional: create a scratch table through the migration path, check `has_table_privilege('authenticated', '<t>', 'TRUNCATE') = false`, then drop it.
4. File the forward under its ledger version, and move the rollback and pre-flight to `supabase/migrations_rollbacks/`.

## 5. Rollback

Run `gh3256_default_privs_no_client_truncate_rollback.sql`. It runs `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO anon, authenticated`. In the proof, `pg_default_acl` afterwards is identical to the pre-forward state, and running it twice is safe. Tables created while the forward was in force keep their ACLs.

## 6. Proof

`PGHOST=… PGPORT=… bash supabase/tests/gh3256_default_privs_proof_run.sh` runs on a throwaway PG16 cluster created with `initdb -U supabase_admin`.

| phase | result |
|---|---|
| CAPABILITY | postgres is not a superuser or a member of supabase_admin, and altering supabase_admin's defaults gives 42501. The model's defaults equal production's (minus PG17's MAINTAIN). |
| BEFORE (negative control) | A new postgres table gives anon/authenticated TRUNCATE, and a real `TRUNCATE` as authenticated succeeds. |
| AFTER | Exactly one `pg_default_acl` row changes, `arwdDxt` → `arwdxt` for anon/authenticated. A new table refuses `TRUNCATE` as authenticated (permission denied) and keeps every other privilege. service_role keeps TRUNCATE. The BEFORE table is untouched. A supabase_admin-created table still gets client TRUNCATE: that is the gap the gate covers. |
| RERUN, REAPPLY | Same as AFTER. |
| ROLLBACK | `pg_default_acl` identical to BEFORE, new tables open again, running it twice is safe. |
| Mutants | 18/18 killed: 12 forward (3 of them by the forward's own assertions), 6 rollback. One rollback variant, `GRANT ALL`, is equivalent here rather than a defect, and is documented in the runner. |
| Gate vs Postgres | All 18 detector fixtures are run on real Postgres with today's defaults. The detector's verdict matches whether a new table really keeps client TRUNCATE on 18/18. The one deliberate difference is that a default-privilege REVOKE in the file is not accepted, because it does not cover supabase_admin. |
