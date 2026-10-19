<!-- STATUS (gh-1438, as of 2026-10-19T19:10:11Z): NOT APPLIED -->
<!-- EVIDENCE: drafted 2026-10-19T19:10:11Z under #2881 (CTO RUN 72 worker cto72-b2881); production read-only measurements in section 2 (Supabase execute_sql, SELECT only, same day) -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->
# Pre-flight: gh2881_claims_private_text_column_grants (Tier 3B)

NOT APPLIED. Refs #2881, #2559, #2882, PR #2880 (review 6256187448 finding D2). Needs REVIEW + LEGAL-READ + R-177 signature, an R-097 24-hour notice and a Tier 3B window before any apply. **Stacked on PR #2880** (the redaction helper it reuses is not on main yet).

## 1. What it does
`authenticated` loses SELECT on `claims.homeowner_notes`, `claims.urgency_reason`, `claims.project_confirmation`; every other column keeps today's access. The claim owner and admins read the three through `public.claim_private_text(claim_id)` (SECURITY DEFINER, one row or none). INSERT/UPDATE privileges, policies, `service_role`, and postgres-owned definer functions and views (`bidder_claim_summary`, `accept_bid`) are untouched. Why this and not a policy or a view: see the forward file header (a row policy cannot hide columns for one shared role; a view cannot close the base-table door).

## 2. Production measurements (read-only, 2026-10-19)
- `pg_class.relacl` for `public.claims`: `anon=arwdDxtm`, `authenticated=arwdDxtm`, `service_role=arwdDxtm` (table-level, all privileges). No column-level ACLs exist (0 attributes with `attacl`). So the forward file must revoke the table-level SELECT and re-grant by column; it does this for `authenticated` and `anon` (anon has no row policy today, so it reads nothing, but the privilege is closed anyway).
- Objects depending on the three columns: one, `bidder_claim_summary` (postgres-owned view; unaffected by `authenticated`'s privileges).
- `claims` is in no publication (`pg_publication_tables` 0 rows), so Realtime does not carry these columns.
- 9 claims have non-empty `homeowner_notes`.
Rollback ACL to compare: the four entries above.

## 3. Callers that break at apply (the gate exists for these)
A `select=*` or a bare `.select()` after an insert/update (RETURNING *) from a browser session fails with 42501 once the columns are gone. Found at this branch by a scan of `.from('claims')` statements (excluding tests): 13 sites, all must name their columns first (and read the three through `claim_private_text` where they need them):
`bids.html:588`, `contract-signing.html:1266`, `dashboard.html:1753`, `dashboard.html:2920` (bare `.select()` after update), `help-estimate.html:847`, `help-measurements.html:819`, `project-confirmation.html:2170`, `react-app/app/(homeowner)/bids/use-bids-data.ts:55`, `.../contract-signing/use-contract-signing-data.ts:173`, `.../help-estimate/use-help-estimate-data.ts:42`, `.../help-measurements/use-help-measurements-data.ts:98`, `.../project-confirmation/use-project-confirmation-data.ts:117`, `react-app/app/hooks/use-claim-status.ts:51`.
Direct readers of the hidden columns by name: `dashboard.html:2779-2786` (edit form: notes, urgency reason, confirmation flag) and `project-confirmation.html:2273` and the React twin read `claim.project_confirmation` off the `*` row. The writes (`project-info-*.html`, `dashboard.html:2912`, `project-confirmation` save) only SET the columns and keep working (proof: write path probe).
Not enumerated and owed before apply: edge functions that read `claims` with the caller's JWT instead of the service role (14 functions pass the caller's Authorization header and mention `claims`; most use it only for `auth.getUser`), and any `security_invoker` view or definer-less function reading the columns (section 2 found none in the catalog).
**These page changes are NOT in this PR.** They are a separate, published-first step; the forward file refuses to run until the operator states they are live (`SET LOCAL gh2881.pages_published = 'yes'`).

## 4. Apply order
1. PR #2880 merged and applied first is NOT required by this file (it has no dependency on `d390_redact_contact`), but the Arabic-Indic fold fix for the SQL side belongs there (section 7).
2. Page and function changes of section 3 merged and published.
3. R-097 notice; then in one transaction: `SET LOCAL gh2881.pages_published = 'yes';` followed by the forward file (BEGIN/COMMIT inside it are its own; run the file whole).
4. Verify with the proof (`supabase/tests/gh2881_claims_private_text_proof.sql`) against production inside its rolled-back block, with an is_test contractor beside the negative control from before the apply.
Rollback: `gh2881_claims_private_text_column_grants_rollback.sql` (restores table-level SELECT; drops the RPC; safe twice).

## 5. Standing rule this introduces
A column added to `public.claims` after the apply is NOT readable by `authenticated` until `GRANT SELECT (<col>) ON public.claims TO authenticated`. Every later claims migration must carry that line. (CI check for this is not in this PR; recommended follow-up.)

## 6. permissions-ratchet
The forward file has a GRANT to `authenticated` (column SELECT, function EXECUTE) and a SECURITY DEFINER function: the PR needs the label `permissions-ratchet: reviewed` after a human reads both.

## 7. Not done here, named
- SQL-side Arabic-Indic digit fold (issue comment 6256295897): the TypeScript fold used by the Scope of Work and project_confirmation redaction is fixed in this PR with tests. The Postgres fold lives in `d390_redact_contact` (PR #2880's unapplied migration) and in the LIVE `bidder_claim_summary` view; fixing it means editing #2880's migration and replacing the live view. Not attempted in this draft.
- Other free-text fields on the project_confirmation document (`structure_names`, `shingle_color`) are not redacted.
- Other decimal-digit scripts (Devanagari, Thai, full-width are NFKC-folded; Devanagari etc. are not) are not folded.
