-- LOCAL-ONLY additions for the gh-3460 proof (throwaway Postgres, never production). Loaded after local_pg16/00_stub_schema.sql and gh3229_local_stub_extras.sql.
ALTER TABLE public.hover_orders ADD COLUMN requested_by_contractor_id uuid, ADD COLUMN admin_notes text;
-- LEGAL-READ 6673369791 blocker 1: production hover_orders has product_code (the stub did not); 'roof_upgrade_detailed' is the contractor-only upgrade (D-317)
ALTER TABLE public.hover_orders ADD COLUMN product_code text;
