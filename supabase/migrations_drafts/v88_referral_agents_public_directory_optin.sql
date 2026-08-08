-- Migration: v88_referral_agents_public_directory_optin
-- Author: run-work F-22 sub-agent (automated) — session rw-86e1h5j3x-f22-a015
-- Date: 2026-07-03
-- Status: DRAFT ONLY — DO NOT APPLY. Tier 3 (D-182) approval pending.
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: v88_referral_agents_public_directory_optin_rollback.sql
-- Pre-flight: v88_referral_agents_public_directory_optin_pre-flight.md
-- ClickUp task: 86e1h5j3x (SEO P2 — /partners/ referral-partner directory)
--
-- NUMBERING NOTE: sql/v88-referral-agents-public-view.sql (2026-06-13) also
-- carries the v88 label in the legacy sql/ lineage. This file follows the
-- supabase/migrations/ lineage (v83..v87). Orchestrator: renumber to v89 at
-- approval time if the two lineages have since been unified.
--
-- Summary: Adds public_directory_optin boolean column to referral_agents.
--          Agents default to NOT opted in (false). The partner directory
--          generator (tools/generate_partner_pages.py) renders pages only
--          for agents where this flag is true — zero pages until this
--          migration is applied AND agents explicitly opt in.

BEGIN;

ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS public_directory_optin BOOLEAN NOT NULL DEFAULT false;

COMMIT;
