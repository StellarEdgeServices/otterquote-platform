-- Rollback for c4_contractor_pitch_bands.sql
-- Safe because the column is additive and nullable: no other object depends on
-- it, and create-docusign-envelope reads it with `?.` and falls back when absent.
-- Dropping it loses any rate cards entered after the forward migration — export
-- `select id, pitch_bands from public.contractors where pitch_bands is not null`
-- before running this if any are populated.

alter table public.contractors
  drop column if exists pitch_bands;
