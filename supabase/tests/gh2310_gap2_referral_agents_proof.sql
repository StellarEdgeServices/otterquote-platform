-- Proof for gh2310 Gap 2 (referral_agents only). BEGIN ... ROLLBACK only; run the whole block as ONE batch
-- and re-read counts afterwards. Inlines the migration's DO block rather than running the file (which COMMITs).
BEGIN;
SELECT 'before' AS phase,
  count(*) FILTER (WHERE is_test=false) AS ra_false, count(*) AS ra_total,
  count(*) FILTER (WHERE id='503f015b-c52f-4e35-a8f9-26243709f32f' AND is_test=false) AS carlos_false,
  count(*) FILTER (WHERE id = ANY (ARRAY['1927861f-8836-49ce-a528-08c432cc69cc'::uuid,'0a934e11-5cac-4607-a63c-7446fe446f81'::uuid,'bdfe2bbf-bbc6-42b9-9213-02b36ebb46fa'::uuid,'f05146f5-f397-4e68-9720-e4394e9c7bd4'::uuid,'9320942a-90c0-4517-b5b7-919f8b2652b8'::uuid,'1280cf58-d89d-4311-b016-c1ff06f29477'::uuid,'0db676cc-0c3f-4c9b-bd25-65952572d6df'::uuid,'5f9ea879-255d-499c-879d-806a9f84eb04'::uuid,'1a61675f-b972-4dd4-a483-d5aa0d9757dc'::uuid]) AND is_test=false) AS target_false
FROM public.referral_agents;   -- expect 10 | 69 | 1 | 9
DO $$
DECLARE
  v_ids uuid[] := ARRAY['1927861f-8836-49ce-a528-08c432cc69cc'::uuid,'0a934e11-5cac-4607-a63c-7446fe446f81'::uuid,'bdfe2bbf-bbc6-42b9-9213-02b36ebb46fa'::uuid,'f05146f5-f397-4e68-9720-e4394e9c7bd4'::uuid,'9320942a-90c0-4517-b5b7-919f8b2652b8'::uuid,'1280cf58-d89d-4311-b016-c1ff06f29477'::uuid,'0db676cc-0c3f-4c9b-bd25-65952572d6df'::uuid,'5f9ea879-255d-499c-879d-806a9f84eb04'::uuid,'1a61675f-b972-4dd4-a483-d5aa0d9757dc'::uuid];
  v_carlos constant uuid := '503f015b-c52f-4e35-a8f9-26243709f32f'::uuid;
  v_updated uuid[];
BEGIN
  IF array_length(v_ids, 1) <> 9 THEN
    RAISE EXCEPTION 'gh2310 gap2 guard: id list has % entries, expected 9', array_length(v_ids, 1);
  END IF;
  IF v_carlos = ANY (v_ids) THEN
    RAISE EXCEPTION 'gh2310 gap2 guard: Carlos McGuire (503f015b) must not be in the id list (CEO ruling 5911272800)';
  END IF;

  -- gh-886 trigger referral_agents_guard_payout_columns rejects is_test changes unless auth.role()='service_role'
  -- or an admin JWT; a migration connection has neither. Claim service_role for THIS TRANSACTION ONLY (is_local=true).
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  WITH upd AS (
    UPDATE public.referral_agents
       SET is_test = true
     WHERE id = ANY (v_ids)
       AND is_test = false
    RETURNING id
  )
  SELECT array_agg(id) INTO v_updated FROM upd;

  IF v_updated IS NULL
     OR array_length(v_updated, 1) <> 9
     OR EXISTS (SELECT 1 FROM unnest(v_updated) u WHERE u <> ALL (v_ids)) THEN
    RAISE EXCEPTION 'gh2310 gap2 guard tripped: updated % rows (expected exactly 9 from the id list)',
      coalesce(array_length(v_updated, 1), 0);
  END IF;
END
$$;
SELECT 'inside' AS phase,
  count(*) FILTER (WHERE is_test=false) AS ra_false, count(*) AS ra_total,
  count(*) FILTER (WHERE id='503f015b-c52f-4e35-a8f9-26243709f32f' AND is_test=false) AS carlos_false,
  count(*) FILTER (WHERE id = ANY (ARRAY['1927861f-8836-49ce-a528-08c432cc69cc'::uuid,'0a934e11-5cac-4607-a63c-7446fe446f81'::uuid,'bdfe2bbf-bbc6-42b9-9213-02b36ebb46fa'::uuid,'f05146f5-f397-4e68-9720-e4394e9c7bd4'::uuid,'9320942a-90c0-4517-b5b7-919f8b2652b8'::uuid,'1280cf58-d89d-4311-b016-c1ff06f29477'::uuid,'0db676cc-0c3f-4c9b-bd25-65952572d6df'::uuid,'5f9ea879-255d-499c-879d-806a9f84eb04'::uuid,'1a61675f-b972-4dd4-a483-d5aa0d9757dc'::uuid]) AND is_test=false) AS target_false
FROM public.referral_agents;   -- expect 1 | 69 | 1 | 0
ROLLBACK;
SELECT 'after' AS phase,
  count(*) FILTER (WHERE is_test=false) AS ra_false, count(*) AS ra_total,
  count(*) FILTER (WHERE id='503f015b-c52f-4e35-a8f9-26243709f32f' AND is_test=false) AS carlos_false
FROM public.referral_agents;   -- expect 10 | 69 | 1
