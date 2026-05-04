-- v55-hover-material-list.sql
-- Adds material_list JSONB column to hover_orders.
-- Written at D-164 gate release by check-siding-design-completion.
-- Read by create-docusign-envelope (fetchHoverMeasurements) as primary
-- source for SOW siding design attributes, with measurements_json fallback.
-- Eliminates the need for a second Hover API call during SOW generation.
-- Decision locked April 22, 2026 (Session 342). ClickUp 86e116rb8.

ALTER TABLE hover_orders
  ADD COLUMN IF NOT EXISTS material_list JSONB;
