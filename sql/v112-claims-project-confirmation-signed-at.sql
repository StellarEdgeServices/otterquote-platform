-- v112 — D-274 (#631) / carried forward from closed #421: claims.project_confirmation_envelope_id
-- has existed since the baseline schema but nothing ever wrote a completion timestamp for it.
-- The DocuSign webhook's claim lookup only matched on docusign_envelope_id and
-- color_confirmation_envelope_id — a completed project_confirmation envelope could
-- never even be FOUND by the webhook, let alone persisted. The BoldSign webhook
-- rewrite (this issue) fixes the lookup (adds project_confirmation_envelope_id to
-- the OR clause) and needs a column to write the completion fact to, mirroring
-- color_confirmed_at's role for color_confirmation_envelope_id.
--
-- Additive, nullable, no backfill, no RLS change — Tier 3A shape per this repo's
-- own tiering (CLAUDE.md: "new nullable columns... autonomous"). Still shipped as
-- an unapplied draft alongside the rest of this PR's migrations, consistent with
-- "Code prepares, Dustin/reviewer applies" for this session — see the D-274 build
-- report on issue #631.

alter table public.claims
  add column if not exists project_confirmation_signed_at timestamp with time zone;

comment on column public.claims.project_confirmation_signed_at is
  'Set by boldsign-webhook (formerly docusign-webhook) when the project_confirmation envelope (claims.project_confirmation_envelope_id) completes signing. Added D-274 (#631) to close the persistence gap carried forward from #421 — the prior webhook could not even find the claim for this envelope type, let alone record completion.';
