CREATE OR REPLACE FUNCTION public.get_claim_color_contractor(p_claim_id uuid)
RETURNS TABLE(company_name text, preferred_brands text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT ct.company_name, ct.preferred_brands
    FROM public.claims cl
    JOIN public.contractors ct ON ct.id = cl.selected_contractor_id
   WHERE cl.id = p_claim_id
     AND cl.user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_claim_color_contractor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_claim_color_contractor(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_claim_color_contractor(uuid) TO authenticated;