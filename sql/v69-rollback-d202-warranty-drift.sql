-- Rollback: v69 D-202 Warranty Manifest Drift
-- Drops the warranty_manifest_drift table and all associated objects.
-- Run this to reverse migration v69_d202_warranty_manifest_drift.sql

DROP TABLE IF EXISTS public.warranty_manifest_drift CASCADE;
