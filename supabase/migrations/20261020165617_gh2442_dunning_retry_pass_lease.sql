-- STATUS (gh-1438, as of 2026-10-19T20:58:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh2442_dunning_retry_pass_lease
-- EVIDENCE: table absent on production to be confirmed by the pre-flight SELECT; behaviour proved on a scratch PostgreSQL (PGlite), see the proof file
-- REPO COPY: none
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md (Tier 3B path: review, R-097 notice, recorded apply)
--
-- Migration: gh2442_dunning_retry_pass_lease
-- GitHub: #2442, PR #2927 (REVIEW 6277096279 E1, belt and braces). Tier: 3B (new table on the money path). NOT APPLIED.
-- Rollback: gh2442_dunning_retry_pass_lease_rollback.sql   Proof: supabase/tests/gh2442_dunning_retry_pass_lease_proof.sql
--
-- What it does. One single-row lease table so two process-dunning CRON ticks cannot run the retry pass at the same time.
-- The pass takes the lease with  UPDATE ... SET holder=<token>, locked_until=now()+10min WHERE id=1 AND locked_until < now()
-- (one row written = acquired) and gives it back when it finishes; a crashed pass leaves the lease to expire. The lease is
-- the second lock: the first is the compare-and-set on the stored idempotency key. Service role only: RLS on, no policies,
-- no grant to PUBLIC / anon / authenticated. If this table is absent or unreadable the pass SKIPS that tick (fails closed).
BEGIN;
CREATE TABLE IF NOT EXISTS public.dunning_retry_pass_lease (
  id           integer PRIMARY KEY CHECK (id = 1),
  holder       text,
  locked_until timestamptz NOT NULL DEFAULT 'epoch'
);
INSERT INTO public.dunning_retry_pass_lease (id, holder, locked_until) VALUES (1, NULL, 'epoch') ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.dunning_retry_pass_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dunning_retry_pass_lease FROM PUBLIC;
REVOKE ALL ON TABLE public.dunning_retry_pass_lease FROM anon;
REVOKE ALL ON TABLE public.dunning_retry_pass_lease FROM authenticated;
GRANT SELECT, UPDATE ON TABLE public.dunning_retry_pass_lease TO service_role;
COMMENT ON TABLE public.dunning_retry_pass_lease IS 'gh-2442: single-row run lease for the process-dunning retry pass (service role only).';
COMMIT;
