-- STATUS (gh-1438, as of 2026-10-23T16:44:20Z): APPLIED
-- FILE ROLE: step 3 of 3 of set gh2881_claims_private_text_column_grants: the gated column revoke (steps 1 and 2: gh2881_claim_private_text_rpc.sql, then publish the pages)
-- EVIDENCE: APPLIED -- #2881 comment 6369876631 (CTO RUN 77): step 4 of 4 applied at about 16:39Z via the Management API (HTTP 201) with --pages-published-yes, file sha256 0483655a... = the draft on main; NO schema_migrations row. Earlier draft-time evidence, kept: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881). No ledger row exists. Production was not touched by this draft; the proof ran on a throwaway Postgres only (supabase/tests/gh2881_claims_private_text_proof_run.sh).
-- REPO COPY: supabase/migrations_applied_manually/20261023163900_gh2881_claims_private_text_column_grants.sql (forward, applied outside the ledger), supabase/migrations_rollbacks/20261023163900_gh2881_claims_private_text_column_grants_rollback.sql (rollback), supabase/migrations_rollbacks/20261023163900_gh2881_claims_private_text_column_grants_pre-flight.md (pre-flight)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh2881_claims_private_text_column_grants
-- GitHub: #2881 (D-390 follow-up; review 6256187448 finding D2 on PR #2880). Refs #2559, #2882.
-- Tier: 3B. It REMOVES a read capability from the `authenticated` role on three columns of public.claims. R-177 pair, LEGAL-READ and an
--   R-097 24-hour notice come first. It is also a BREAKING CHANGE for every browser read that asks for those columns or for `*` (see the gate).
-- Rollback: supabase/migrations_drafts/gh2881_claims_private_text_column_grants_rollback.sql (restores the grants only; the RPC stays for the pages)
-- Pre-flight: supabase/migrations_drafts/gh2881_claims_private_text_column_grants_pre-flight.md (caller inventory, apply order, open questions)
-- Proof (rolled back, role-switched): supabase/tests/gh2881_claims_private_text_proof.sql (runner: gh2881_claims_private_text_proof_run.sh)
--
-- WHAT IS HIDDEN. Three columns the homeowner types or fills in on public.claims:
--     homeowner_notes       text   ("Notes for Contractors", up to 500 characters)
--     urgency_reason        text   (free text beside "ASAP")
--     project_confirmation  jsonb  (the confirmation form; carries homeownerNotes, workNotBeingDone, projectNotes, exclusions)
--   `authenticated` loses SELECT on exactly these. Every other column keeps the access it has today.
--
-- WHY COLUMN PRIVILEGES AND AN OWNER RPC (and not a policy, and not a second view). The #2559 view migration
--   (20261008231303_gh2559_bidder_claims_view.sql) already explains why a row policy cannot do this: one login role (authenticated) serves
--   homeowners, contractors and admins, and a policy decides ROWS, never columns. D-390 redacts these texts on every contractor view
--   (bidder_claim_summary, the Scope of Work, the thread, the e-mail preview), but the BASE ROW is a second door: a contractor who calls
--   PostgREST directly (GET /rest/v1/claims?select=homeowner_notes) reads the raw text. A view cannot close that door, because the door is the
--   table itself. The only ways to close it are (a) take the columns away from the role (this file), or (b) move the data to a table the role
--   cannot read (a bigger change: every homeowner write path moves too). (a) is smaller, reversible in one statement, and leaves the homeowner's
--   writes untouched (INSERT and UPDATE privileges are NOT changed). The homeowner and admin read the three columns through
--   public.claim_private_text() (step 1, gh2881_claim_private_text_rpc.sql), which is SECURITY DEFINER and answers only for the claim's owner or an admin. service_role, SECURITY DEFINER
--   functions owned by postgres (bidder_claim_summary, accept_bid, the D-390 functions) and the edge functions are unaffected.
--
-- WHAT THIS CHANGES FOR EVERYONE ELSE (read before you apply)
--   1. `authenticated` held table-level SELECT on public.claims. A column privilege cannot be taken away from a role that holds the table-level
--      privilege, so this file revokes the table-level SELECT and grants SELECT on every column EXCEPT the three, using the live column list at
--      apply time.
--   2. A request with select=* (or .select() after an insert/update, which is RETURNING *) now fails with 42501 for every browser session,
--      homeowner included, until that read names its columns. The pre-flight lists every such caller found at main. THE GATE BELOW REFUSES
--      TO RUN unless the operator states that those callers have been moved and published.
--   3. A column added to public.claims AFTER this file runs is NOT readable by `authenticated` until it is granted. The pre-flight names this
--      rule; any later claims migration must GRANT SELECT (<new column>) ON public.claims TO authenticated, or the browser cannot read it.
--
-- GATE. The file refuses (P0A81) unless the apply transaction first ran:  SET LOCAL gh2881.pages_published = 'yes';
--   That statement is the operator's recorded statement that no published page or function asks `authenticated` for these three columns or for `*`
--   (pre-flight section 3). It is deliberately NOT inside this file.
--
-- SEARCH PATH / SECURITY. The function is SECURITY DEFINER with search_path = public, pg_temp, schema-qualified names, EXECUTE revoked from PUBLIC
--   and anon and granted to authenticated only. It returns at most one row, and none for a caller who is neither the claim's owner nor an admin.
--   (permissions-ratchet: this file has a GRANT to authenticated and a SECURITY DEFINER function; the PR needs the label
--   "permissions-ratchet: reviewed" once a human has read both.)
BEGIN;

SET LOCAL lock_timeout = '5s';

DO $gate$
BEGIN
  IF coalesce(current_setting('gh2881.pages_published', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'gh2881: refused. Run SET LOCAL gh2881.pages_published = ''yes''; in the same transaction ONLY after the pages and functions that read claims.homeowner_notes, urgency_reason, project_confirmation or select=* as a browser user are published (pre-flight section 3).' USING ERRCODE = 'P0A81';
  END IF;
END
$gate$;

-- 1. The read path must already exist (step 1 of the set).
DO $need$
BEGIN
  IF to_regprocedure('public.claim_private_text(uuid)') IS NULL THEN
    RAISE EXCEPTION 'gh2881: public.claim_private_text(uuid) does not exist; apply gh2881_claim_private_text_rpc.sql first' USING ERRCODE = 'P0A89';
  END IF;
END
$need$;

-- 2. The column privileges. Column list read from the live catalog so a column added since drafting is not silently dropped.
--    Done for authenticated and, if it holds any SELECT on the table, anon (anon has no row policy on claims, so it reads nothing today; the
--    privilege is closed anyway so a later policy cannot expose these columns by accident).
REVOKE SELECT (homeowner_notes, urgency_reason, project_confirmation) ON public.claims FROM PUBLIC;

DO $grant$
DECLARE
  v_cols text;
  v_role text;
  v_had boolean;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.claims'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('homeowner_notes', 'urgency_reason', 'project_confirmation');
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'gh2881: no columns found on public.claims' USING ERRCODE = 'P0A83';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    v_had := has_any_column_privilege(v_role, 'public.claims', 'SELECT');
    EXECUTE format('REVOKE SELECT ON public.claims FROM %I', v_role);
    EXECUTE format('REVOKE SELECT (homeowner_notes, urgency_reason, project_confirmation) ON public.claims FROM %I', v_role);
    IF v_had THEN
      EXECUTE format('GRANT SELECT (%s) ON public.claims TO %I', v_cols, v_role);
    END IF;
  END LOOP;
END
$grant$;

-- 3. Assertions: the three are closed to authenticated, every other column is open, and the table-level privilege is gone.
DO $assert$
DECLARE
  v_open int;
  v_total int;
BEGIN
  IF has_column_privilege('authenticated', 'public.claims', 'homeowner_notes', 'SELECT')
     OR has_column_privilege('authenticated', 'public.claims', 'urgency_reason', 'SELECT')
     OR has_column_privilege('authenticated', 'public.claims', 'project_confirmation', 'SELECT') THEN
    RAISE EXCEPTION 'gh2881: authenticated can still SELECT a hidden column' USING ERRCODE = 'P0A84';
  END IF;
  SELECT count(*) FILTER (WHERE has_column_privilege('authenticated', 'public.claims', a.attname, 'SELECT')), count(*)
    INTO v_open, v_total
    FROM pg_attribute a
   WHERE a.attrelid = 'public.claims'::regclass AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_open <> v_total - 3 THEN
    RAISE EXCEPTION 'gh2881: expected % readable columns, found %', v_total - 3, v_open USING ERRCODE = 'P0A86';
  END IF;
  IF has_column_privilege('anon', 'public.claims', 'homeowner_notes', 'SELECT') THEN
    RAISE EXCEPTION 'gh2881: anon can SELECT homeowner_notes' USING ERRCODE = 'P0A87';
  END IF;
END
$assert$;

COMMIT;
