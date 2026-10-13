-- gh-2619 proof: contractor_messages on public.messages admits only the claim's selected contractor.
-- SELF-ROLLING-BACK: one DO block does the fixtures, the BEFORE probes, the ALTER POLICY (the exact
-- statement from supabase/migrations_drafts/gh2619_messages_selected_contractor_only.sql), the AFTER
-- probes, then ends with RAISE EXCEPTION, which rolls the whole transaction back and returns the
-- report in the error text. Nothing persists. Run: python3 "In Flight/bin/_cto53_sql.py" <this file>
-- Uses is_test = true rows only; ids are looked up at run time and printed as 8-character digests.
DO $proof$
DECLARE
  v_claim uuid; v_owner uuid; v_sel_ctr uuid; v_sel_uid uuid;
  v_b_ctr uuid; v_b_uid uuid; v_n_ctr uuid; v_n_uid uuid;
  v_pre uuid[]; v_total int; v_out text := ''; v_n int; v_phase int; v_i int;
  v_label text[]; v_uid uuid[]; v_role text[];
  v_policy_before text; v_policy_after text; v_ist boolean;
BEGIN
  -- fixtures (lookups, is_test only)
  SELECT c.id, c.user_id, c.selected_contractor_id INTO v_claim, v_owner, v_sel_ctr
    FROM public.claims c
   WHERE c.is_test = true AND c.selected_contractor_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.messages m WHERE m.claim_id = c.id)
     AND (SELECT k.user_id FROM public.contractors k WHERE k.id = c.selected_contractor_id) <> c.user_id
   ORDER BY c.created_at LIMIT 1;
  IF v_claim IS NULL THEN RAISE EXCEPTION 'no is_test claim with a selected contractor and messages'; END IF;
  SELECT user_id INTO v_sel_uid FROM public.contractors WHERE id = v_sel_ctr;
  SELECT id, user_id INTO v_b_ctr, v_b_uid FROM public.contractors k
   WHERE k.is_test = true AND k.status = 'active' AND k.id <> v_sel_ctr AND k.user_id NOT IN (v_owner, v_sel_uid)
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = v_claim AND q.contractor_id = k.id)
   ORDER BY k.id LIMIT 1;
  SELECT id, user_id INTO v_n_ctr, v_n_uid FROM public.contractors k
   WHERE k.is_test = true AND k.status = 'active' AND k.id NOT IN (v_sel_ctr, v_b_ctr) AND k.user_id NOT IN (v_owner, v_sel_uid, v_b_uid)
     AND NOT EXISTS (SELECT 1 FROM public.quotes q WHERE q.claim_id = v_claim AND q.contractor_id = k.id)
   ORDER BY k.id LIMIT 1;
  IF v_b_ctr IS NULL OR v_n_ctr IS NULL THEN RAISE EXCEPTION 'not enough is_test contractors'; END IF;

  v_out := v_out || format(E'auth users (digests): homeowner %s, selected contractor %s, non-selected bidder %s, non-bidder %s (all different)\n', left(v_owner::text,8), left(v_sel_uid::text,8), left(v_b_uid::text,8), left(v_n_uid::text,8));
  -- the is_test query and its result for every fixture row
  v_out := v_out || E'IS_TEST CHECK (select is_test from the row):\n';
  SELECT is_test INTO v_ist FROM public.claims WHERE id = v_claim;
  v_out := v_out || format(E'  claims %s is_test=%s\n', left(v_claim::text,8), v_ist);
  SELECT is_test INTO v_ist FROM public.contractors WHERE id = v_sel_ctr;
  v_out := v_out || format(E'  selected contractor %s is_test=%s\n', left(v_sel_ctr::text,8), v_ist);
  SELECT is_test INTO v_ist FROM public.contractors WHERE id = v_b_ctr;
  v_out := v_out || format(E'  non-selected bidder contractor %s is_test=%s\n', left(v_b_ctr::text,8), v_ist);
  SELECT is_test INTO v_ist FROM public.contractors WHERE id = v_n_ctr;
  v_out := v_out || format(E'  non-bidder contractor %s is_test=%s\n', left(v_n_ctr::text,8), v_ist);
  v_out := v_out || format(E'  homeowner (claims.user_id) %s; claim owner profile is_test=%s\n', left(v_owner::text,8), (SELECT is_test FROM public.profiles WHERE id = v_owner));

  -- fixture quote for the non-selected bidder, created inside this transaction (triggers off for the insert only)
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.quotes (claim_id, contractor_id, total_price, fee_percentage, fee_amount, is_test)
    VALUES (v_claim, v_b_ctr, 1, 0, 0, true);
  SET LOCAL session_replication_role = origin;
  v_out := v_out || format(E'FIXTURE: quote for non-selected bidder %s on claim %s inserted inside the transaction (is_test=true)\n', left(v_b_ctr::text,8), left(v_claim::text,8));

  SELECT array_agg(id) INTO v_pre FROM public.messages WHERE claim_id = v_claim;
  v_total := coalesce(array_length(v_pre,1),0);
  SELECT string_agg(left(qual,0) || md5(qual), '') INTO v_policy_before FROM pg_policies WHERE tablename='messages' AND policyname='contractor_messages';
  v_out := v_out || format(E'claim has %s pre-existing messages between homeowner and selected contractor; quotes on claim now: %s\n', v_total, (SELECT count(*) FROM public.quotes WHERE claim_id = v_claim));

  v_label := ARRAY['homeowner','selected contractor','NON-SELECTED bidder','non-bidder contractor'];
  v_uid   := ARRAY[v_owner, v_sel_uid, v_b_uid, v_n_uid];
  v_role  := ARRAY['homeowner','contractor','contractor','contractor'];

  FOR v_phase IN 1..2 LOOP
    IF v_phase = 2 THEN
      EXECUTE $m$ALTER POLICY contractor_messages ON public.messages
  USING (
    claim_id IN (
      SELECT quotes.claim_id
        FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
    AND claim_id IN (
      SELECT claims.id
        FROM claims
       WHERE claims.selected_contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
  )
  WITH CHECK (
    sender_id = (SELECT auth.uid() AS uid)
    AND sender_role = 'contractor'
    AND claim_id IN (
      SELECT quotes.claim_id
        FROM quotes
       WHERE quotes.contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
    AND claim_id IN (
      SELECT claims.id
        FROM claims
       WHERE claims.selected_contractor_id = (
         SELECT contractors.id FROM contractors
          WHERE contractors.user_id = (SELECT auth.uid() AS uid)
       )
    )
  );$m$;
      DELETE FROM public.messages WHERE claim_id = v_claim AND id <> ALL (v_pre);
      v_out := v_out || E'\n=== AFTER the migration (ALTER POLICY applied inside this transaction) ===\n';
      SELECT with_check INTO v_policy_after FROM pg_policies WHERE tablename='messages' AND policyname='contractor_messages';
      v_out := v_out || 'pg_policies contractor_messages WITH CHECK now contains selected_contractor_id: ' || (v_policy_after LIKE '%selected_contractor_id%') || E'\n';
    ELSE
      v_out := v_out || E'\n=== BEFORE the migration (production policy as it is today) ===\n';
      SELECT with_check INTO v_policy_before FROM pg_policies WHERE tablename='messages' AND policyname='contractor_messages';
      v_out := v_out || 'pg_policies contractor_messages WITH CHECK contains selected_contractor_id: ' || (v_policy_before LIKE '%selected_contractor_id%') || E'\n';
    END IF;
    FOR v_i IN 1..4 LOOP
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid[v_i], 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid[v_i]::text, true);
      SELECT count(*) INTO v_n FROM public.messages WHERE claim_id = v_claim AND id = ANY (v_pre);
      v_out := v_out || format(E'  %-22s select: sees %s of %s thread messages; ', v_label[v_i], v_n, v_total);
      BEGIN
        INSERT INTO public.messages (claim_id, sender_id, sender_role, body) VALUES (v_claim, v_uid[v_i], v_role[v_i], 'gh2619 proof');
        v_out := v_out || E'insert: SUCCEEDED\n';
      EXCEPTION WHEN OTHERS THEN
        v_out := v_out || 'insert: REFUSED (' || sqlerrm || E')\n';
      END;
      EXECUTE 'RESET ROLE';
    END LOOP;
  END LOOP;
  SELECT string_agg(policyname || ' ' || cmd, ', ' ORDER BY policyname) INTO v_policy_after FROM pg_policies WHERE tablename='messages';
  v_out := v_out || E'\npolicies on messages after: ' || v_policy_after || E'\n';
  RAISE EXCEPTION E'GH2619-PROOF-ROLLED-BACK\n%', v_out;
END
$proof$;
