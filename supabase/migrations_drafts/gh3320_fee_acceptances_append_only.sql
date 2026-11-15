-- gh-3320: make public.fee_acceptances append-only for the client roles, as D-214 says (UETA acceptance evidence: "append-only (no updates, no deletes)").
-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (ledger version 20261109145733, name gh3320_fee_acceptances_append_only; read-only ledger query, CTO RUN 104, #3324; the lines below are the pre-apply drafting record)
-- EVIDENCE: drafted on main 33f7c8ae. No production read was made by the author (no database connection, by instruction). The state this changes is the one measured on #3320
-- (Supabase MCP SELECT, CEO RUN 143, 2026-11-02, project yeszghaspzwwstvsrioa): authenticated holds UPDATE and DELETE, anon holds UPDATE and not DELETE, RLS on and not forced, policies
-- admin read / admin update / contractor insert own / contractor read own, no DELETE policy, no triggers, 8 rows. Those figures match supabase/migrations/20260101000000_v000_baseline_schema.sql
-- (policies lines 3624-3635) and the gh-1529 / gh-3240 revokes; the applier re-reads them first (pre-flight).
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY: apply only through the Tier 3B path (migration-author, R-177 pair or Ben's ruling that none is owed, R-097 24-hour notice, a recorded apply).
-- Rollback: supabase/migrations_rollbacks/gh3320_fee_acceptances_append_only_rollback.sql
-- Pre-flight: supabase/migrations_rollbacks/gh3320_fee_acceptances_append_only_pre-flight.md  Proof (BEGIN ... ROLLBACK, throwaway Postgres): supabase/tests/gh3320_fee_acceptances_append_only_proof.sql
-- TRANSACTION: this file carries its own BEGIN ... COMMIT and is meant to be run ALONE (`psql -v ON_ERROR_STOP=1 -f`). Run that way it is all-or-nothing: if the guard raises, the DROP POLICY and the
-- REVOKE roll back with it (the runner's guard cases G1, G2, G4 and G5 prove that nothing is left committed).
-- THE FILE'S OWN COMMIT ENDS ANY TRANSACTION THE APPLIER OPENED AROUND IT. `BEGIN; <this file>; ROLLBACK;` and `psql -1 -f` therefore leave the change COMMITTED (the inner BEGIN is only a
-- warning), and a step placed after this file in the same transaction (a history insert, a check) is not atomic with it. NEVER dry-run this file by wrapping it; rehearse on a throwaway Postgres
-- (the runner's case W1 shows a wrapped ROLLBACK committing). A guard that fires inside a wrapping transaction still commits nothing, because the transaction is aborted (case W2).
-- A plain `psql -f` exits 0 even when the guard fires (the error is printed, nothing is committed), so do not trust the tool's exit status: after any apply read pre-flight checks 1 and 2 again.
--
-- What changes (two statements, then a guard):
--   (1) DROP the policy "Admin can update fee acceptances" (UPDATE for any caller whose JWT email is the owner's). Nothing in this repo reads or writes through it: the only writers of
--       fee_acceptances are INSERTs from contractor-bid-form.html and react-app contractor/bid/[claimId]/bid-form.tsx; the only readers are stripe-webhook and get-business-lines-dashboard
--       (service_role); the only DELETEs are tests/e2e/seed/teardown.mjs and the one-off sql/2026-07-13-purge-summit-ridge-543.sql (service_role / SQL editor). No code UPDATEs the table at all,
--       including the never-written columns invoice_url, rescinded_at and rescission_reason.
--   (2) REVOKE UPDATE and DELETE on the table from anon and authenticated (the second layer the policies alone lacked; DELETE was already refused for anon by gh-1529).
-- What does NOT change: INSERT and SELECT for every role, the three remaining policies, service_role and postgres (the e2e teardown and one-off purges still work), the table, its rows, columns,
-- indexes and FKs. No trigger is added (see the PR body, Q2: a trigger that also bound service_role would break tests/e2e/seed/teardown.mjs).
-- Money: none changed; the table is the evidence of a fee the contractor accepted, and this narrows who can alter it. Consent: no wording changes.

BEGIN;

DROP POLICY IF EXISTS "Admin can update fee acceptances" ON public.fee_acceptances;

REVOKE UPDATE, DELETE ON TABLE public.fee_acceptances FROM anon, authenticated;

-- GUARD: refuse (and so roll back the whole migration) if a client role still holds UPDATE (table-wide or on any single column), DELETE or TRUNCATE, or an UPDATE or DELETE policy survives.
-- TRUNCATE is not revoked here (gh-3240 already revoked it and #3320's figures do not list it) but it ignores RLS, so a surviving TRUNCATE stops the migration for the applier to look at.
-- A column-level UPDATE grant made by another grantor is untouched by the REVOKE above; has_table_privilege does not report it, has_any_column_privilege does.
DO $guard$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(r || ':' || p || CASE WHEN p = 'UPDATE' AND NOT has_table_privilege(r, 'public.fee_acceptances', p) THEN ' (column-level)' ELSE '' END, ', ') INTO bad
    FROM unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['UPDATE', 'DELETE', 'TRUNCATE']) p
   WHERE CASE WHEN p = 'UPDATE' THEN has_any_column_privilege(r, 'public.fee_acceptances', p) ELSE has_table_privilege(r, 'public.fee_acceptances', p) END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'gh3320: client privilege survived on public.fee_acceptances: %', bad USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fee_acceptances' AND cmd IN ('UPDATE', 'DELETE', 'ALL')) THEN
    RAISE EXCEPTION 'gh3320: an UPDATE, DELETE or ALL policy survives on public.fee_acceptances' USING ERRCODE = '55000';
  END IF;
END
$guard$;

COMMIT;
