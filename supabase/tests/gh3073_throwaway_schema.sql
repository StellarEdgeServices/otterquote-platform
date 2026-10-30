-- gh-3073: THROWAWAY schema for supabase/tests/gh3073_agreement_version_proof.sql. Scratch Postgres only; never apply anywhere else.
-- Baseline = main after PR #3037: the gh-2995 throwaway schema, then the gh-2995 forward file (accept_cpa(), contractor_cpa_acceptances,
-- the redefined freeze trigger). Paths are relative to this file (psql \ir). It models nothing beyond what gh-2995 models.
\set ON_ERROR_STOP on
\ir gh2995_throwaway_schema.sql
\ir ../migrations_drafts/gh2995_accept_cpa_append_only.sql
