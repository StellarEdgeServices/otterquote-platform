-- Rollback v90 — remove the admin email SELECT policy on contractors.
-- Run the v90b rollback FIRST if you need authenticated read restored.
DROP POLICY IF EXISTS "Admin can read all contractors" ON public.contractors;
