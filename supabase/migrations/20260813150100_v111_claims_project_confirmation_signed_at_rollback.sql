-- Rollback for v111_claims_project_confirmation_signed_at.
-- Safe: column is additive, nullable, and (until the BoldSign webhook ships)
-- unread by any other code path.

alter table public.claims
  drop column if exists project_confirmation_signed_at;
