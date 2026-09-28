-- gh-2121 (LRS HO-1 S16) proof, REVIEW: FAIL 5849942876 (D1/D2/D4/D5).
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against a database that already has supabase/migrations/20260924195639_
-- gh2121_lead_goal_writeback.sql AND supabase/migrations/20260926221500_
-- gh2121_s16_lead_goal_security_fix.sql applied. Never COMMIT.
--
-- NOT RUN BY THIS WORKER: the Code-lane dispatch this file was written
-- under is hard-limited from applying a migration or writing to any
-- database, in any circumstance -- including a BEGIN...ROLLBACK batch. Ben
-- (or Marty, or the executive-dispatched refuter -- comment 5849942876,
-- claim ceo-2026-09-26T16:23:19Z) has the DB access this proof needs. Apply
-- the two migrations above first (both currently shipped, NOT applied),
-- then run this file as one batch and paste the raw NOTICE output on
-- #2220/#2121 -- same convention as supabase/tests/gh2154_p1_proof.sql.
--
-- REVISION (this file), coordinator return on RW-EVIDENCE 5856309027: the
-- first cut of this proof had two real weaknesses that a Code-lane run
-- surfaced:
--   1. The original P2 checked a raw predicate on hover_orders' own columns
--      (homeowner_stripe_payment_intent_id IS NOT NULL AND
--      homeowner_charge_amount > 0) instead of querying lead_goal_events --
--      so it passed identically whether the fix migration was applied or
--      not, and never actually exercised the D1 defect through the real
--      view. Rewritten below: P2 now creates its OWN converted lead/account
--      (lead B / user B) whose ONLY hover_orders row is
--      status='pending', PaymentIntent NULL, amount NULL, created AFTER the
--      lead -- exactly the reviewer's "reload before paying" scenario --
--      then queries lead_goal_events for that lead and asserts no
--      measurement_purchase row. Run against 20260924195639 alone this
--      correctly FAILS (the pre-fix view has no payment predicate, so the
--      pending order is counted); with 20260926221500 applied it PASSES.
--   2. The original P1/P2/P3 fixture leads (A/B/C) all converted to the
--      SAME synthetic account (user_a). Since lead_goal_events joins
--      claim_goals on l.converted_user_id (i.e. one account's ENTIRE claim
--      history, not just the claim relevant to a given assertion), sharing
--      an account meant leads B and C's rows could pick up account A's
--      earlier goal too, with ties (same-transaction now()) broken only by
--      a random claim_id ordering -- a correctness dependency the test
--      author did not intend. Rewritten below: every scenario lead now
--      converts to its OWN dedicated synthetic account (users
--      a/b/c/d/h/attacker below), so no assertion's outcome depends on
--      another scenario's fixture rows or on tie-break ordering. The hijack
--      scenario (P5/P6) also now uses two DISTINCT accounts (a genuine
--      attacker uid vs. the legitimate owner uid), which is a more faithful
--      model of the real hijack than reusing one uid with two emails.
--
-- What each assertion checks, and against which reviewer defect:
--   P1  D1 (positive) : a PAID hover_orders row produces a measurement_purchase row.
--   P2  D1 fix (THE NEGATIVE CONTROL) : a lead whose only hover_orders row
--                is PENDING/unpaid (no PaymentIntent, no charge amount),
--                created after the lead, produces NO measurement_purchase
--                row in lead_goal_events -- the exact scenario the reviewer
--                described (reload before paying). Run against
--                20260924195639 alone (fix migration NOT applied) this
--                assertion FAILS -- that is the "negative control failing
--                on the pre-fix code" the coordinator required. Apply
--                20260926221500 and rerun -- P2 passes.
--   P3  loss-sheet path unaffected by D1/D5 -- claims.loss_sheet_parsed_at
--                still produces a loss_sheet_upload row (own dedicated
--                account, no shared-account tie-break).
--   P4  D5 fix : a claim's goal from BEFORE the lead's own created_at is
--                excluded (an existing customer's old paid order must not
--                be credited to a brand-new Arm F lead on the same user).
--   P5  D4 fix : set_lead_converted returns false (does not link) when the
--                caller's JWT email does not match the lead's email --
--                the hijack the reviewer described (editing ?lead= to
--                someone else's id). Attacker and legitimate owner are two
--                distinct synthetic accounts.
--   P6  D4 regression check: the legitimate owner's account, with a
--                matching email, still succeeds (returns true, links the
--                lead) -- the fix must not break the legitimate path.
--   P7  unconverted lead : no row in lead_goal_events at all.
--
-- To reproduce the "fails on pre-fix code" run for P2: apply only
-- 20260924195639 (not 20260926221500), run this file, and P2 will report
-- FAIL (a measurement_purchase row appears for the unpaid order). Then
-- apply 20260926221500 and rerun -- P2 passes. Paste both raw runs.
--
-- Everything this script writes is rolled back by the ROLLBACK that must
-- follow it -- no synthetic row may be left behind, and this must never be
-- run outside a transaction that ends in ROLLBACK.

DO $$
DECLARE
  v_lead_a         uuid;
  v_lead_b         uuid;
  v_lead_c         uuid;
  v_lead_d         uuid;
  v_lead_e         uuid;
  v_lead_h         uuid;
  v_user_a         uuid := gen_random_uuid();
  v_user_b         uuid := gen_random_uuid();
  v_user_c         uuid := gen_random_uuid();
  v_user_d         uuid := gen_random_uuid();
  v_user_h         uuid := gen_random_uuid();
  v_user_attacker  uuid := gen_random_uuid();
  v_claim_a        uuid;
  v_claim_b        uuid;
  v_claim_c        uuid;
  v_claim_d_old    uuid;
  v_row            record;
  v_ok             boolean;
  v_fail_count     int := 0;
BEGIN
  -- ── Fixture leads, each with its own dedicated synthetic account below ─
  INSERT INTO public.leads (email, name, source, created_at)
    VALUES ('proof-a@example.test', 'Proof A', 'facebook', now() - interval '2 hours')
    RETURNING id INTO v_lead_a;
  INSERT INTO public.leads (email, name, source, created_at)
    VALUES ('proof-b@example.test', 'Proof B', 'facebook', now() - interval '2 hours')
    RETURNING id INTO v_lead_b;
  INSERT INTO public.leads (email, name, source, created_at)
    VALUES ('proof-c@example.test', 'Proof C', 'facebook', now() - interval '2 hours')
    RETURNING id INTO v_lead_c;
  -- Lead D is created AFTER v_user_d's old claim/order below (P4/D5).
  INSERT INTO public.leads (email, name, source, created_at)
    VALUES ('proof-d@example.test', 'Proof D', 'facebook', now())
    RETURNING id INTO v_lead_d;
  INSERT INTO public.leads (email, name, source, created_at)
    VALUES ('proof-e@example.test', 'Proof E', 'facebook', now() - interval '2 hours')
    RETURNING id INTO v_lead_e;
  INSERT INTO public.leads (email, name, source, created_at)
    VALUES ('proof-h@example.test', 'Proof H', 'facebook', now() - interval '2 hours')
    RETURNING id INTO v_lead_h;

  -- ── P5/P6: D4 hijack guard (two DISTINCT synthetic accounts) ─────────
  -- Attacker (own account, own email, NOT the lead's) tries to link lead H
  -- -- must be rejected.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_attacker::text, 'email', 'attacker@example.test')::text, true);
  v_ok := public.set_lead_converted(v_lead_h);
  IF v_ok IS DISTINCT FROM false THEN
    RAISE NOTICE 'P5 FAIL: hijack attempt with mismatched email returned %, expected false', v_ok;
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P5 PASS: mismatched-email caller rejected (returned false), lead H still unclaimed';
  END IF;

  -- Legitimate owner (own account, matching email) links lead H -- must succeed.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_h::text, 'email', 'proof-h@example.test')::text, true);
  v_ok := public.set_lead_converted(v_lead_h);
  IF v_ok IS DISTINCT FROM true THEN
    RAISE NOTICE 'P6 FAIL: matching-email caller returned %, expected true', v_ok;
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P6 PASS: matching-email caller linked lead H to %', v_user_h;
  END IF;

  -- Link leads A/B/C/D each to their OWN dedicated account -- no lead
  -- shares an account with another scenario lead, so no assertion below
  -- depends on another scenario's fixture rows or on tie-break ordering.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'email', 'proof-a@example.test')::text, true);
  PERFORM public.set_lead_converted(v_lead_a);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_b::text, 'email', 'proof-b@example.test')::text, true);
  PERFORM public.set_lead_converted(v_lead_b);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_c::text, 'email', 'proof-c@example.test')::text, true);
  PERFORM public.set_lead_converted(v_lead_c);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_d::text, 'email', 'proof-d@example.test')::text, true);
  PERFORM public.set_lead_converted(v_lead_d);
  -- Lead E is intentionally left unconverted for P7.

  -- ── P1: paid hover_orders -> measurement_purchase ───────────────────
  INSERT INTO public.claims (user_id, status) VALUES (v_user_a, 'documents_needed') RETURNING id INTO v_claim_a;
  INSERT INTO public.hover_orders (claim_id, user_id, status, homeowner_stripe_payment_intent_id, homeowner_charge_amount, created_at)
    VALUES (v_claim_a, v_user_a, 'paid', 'pi_proof_paid_a', 1500, now());

  SELECT * INTO v_row FROM public.lead_goal_events WHERE lead_id = v_lead_a;
  IF v_row.lead_id IS NULL OR v_row.goal_type IS DISTINCT FROM 'measurement_purchase' THEN
    RAISE NOTICE 'P1 FAIL: expected lead A row goal_type=measurement_purchase, got %', to_jsonb(v_row);
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P1 PASS: lead A -> measurement_purchase, goal_at=%', v_row.goal_at;
  END IF;

  -- ── P2: pending/unpaid hover_orders -> NO measurement_purchase row (D1) ──
  -- THIS IS THE D1 NEGATIVE CONTROL. Lead B's account (user_b) has exactly
  -- ONE claim and exactly ONE hover_orders row: status='pending', NO
  -- PaymentIntent, NO charge amount, created AFTER lead B itself -- the
  -- reviewer's "reload before paying" scenario, queried through the REAL
  -- lead_goal_events view (not a raw column predicate). Against
  -- 20260924195639 alone (no payment filter in the view's lateral join)
  -- this MUST fail: the pending row's created_at still satisfies
  -- MIN(ho.created_at), so claim_goal_type resolves to
  -- 'measurement_purchase' and a row appears. Against 20260926221500 (this
  -- PR's fix) the lateral join's payment predicate excludes the pending
  -- row entirely, so the claim's own goal_type/goal_at are both NULL, and
  -- either no row is returned for lead B or a row is returned with
  -- goal_type IS NULL -- both are accepted as PASS since either shape means
  -- "no measurement_purchase was recorded for the unpaid order."
  INSERT INTO public.claims (user_id, status) VALUES (v_user_b, 'documents_needed') RETURNING id INTO v_claim_b;
  INSERT INTO public.hover_orders (claim_id, user_id, status, homeowner_stripe_payment_intent_id, homeowner_charge_amount, created_at)
    VALUES (v_claim_b, v_user_b, 'pending', NULL, NULL, now());

  SELECT * INTO v_row FROM public.lead_goal_events WHERE lead_id = v_lead_b;
  IF v_row.goal_type IS NOT DISTINCT FROM 'measurement_purchase' THEN
    RAISE NOTICE 'P2 FAIL: unpaid/pending hover_orders row for lead B produced goal_type=measurement_purchase (should be no row, or goal_type NULL): %', to_jsonb(v_row);
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P2 PASS: unpaid/pending hover_orders row for lead B produces no measurement_purchase row in lead_goal_events (row=%)', to_jsonb(v_row);
  END IF;

  -- ── P3: loss-sheet path still works (own dedicated account) ─────────
  INSERT INTO public.claims (user_id, status, loss_sheet_parsed_at) VALUES (v_user_c, 'documents_needed', now()) RETURNING id INTO v_claim_c;
  SELECT * INTO v_row FROM public.lead_goal_events WHERE lead_id = v_lead_c;
  IF v_row.lead_id IS NULL OR v_row.goal_type IS DISTINCT FROM 'loss_sheet_upload' THEN
    RAISE NOTICE 'P3 FAIL: expected lead C row goal_type=loss_sheet_upload, got %', to_jsonb(v_row);
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P3 PASS: lead C -> loss_sheet_upload, goal_at=%', v_row.goal_at;
  END IF;

  -- ── P4: D5 -- a claim from BEFORE the lead's created_at is excluded ──
  INSERT INTO public.claims (user_id, status) VALUES (v_user_d, 'documents_needed') RETURNING id INTO v_claim_d_old;
  INSERT INTO public.hover_orders (claim_id, user_id, status, homeowner_stripe_payment_intent_id, homeowner_charge_amount, created_at)
    VALUES (v_claim_d_old, v_user_d, 'paid', 'pi_proof_old_d', 1500, now() - interval '3 hours');
  -- v_lead_d.created_at = now() (set above), i.e. AFTER this claim's paid order.
  SELECT * INTO v_row FROM public.lead_goal_events WHERE lead_id = v_lead_d;
  IF v_row.lead_id IS NOT NULL THEN
    RAISE NOTICE 'P4 FAIL: lead D picked up a pre-existing claim''s goal from before it was created: %', to_jsonb(v_row);
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P4 PASS: lead D (created after user_d''s only paid claim) produces no row -- old purchase not misattributed';
  END IF;

  -- ── P7: unconverted lead -> no row ───────────────────────────────────
  SELECT * INTO v_row FROM public.lead_goal_events WHERE lead_id = v_lead_e;
  IF v_row.lead_id IS NOT NULL THEN
    RAISE NOTICE 'P7 FAIL: unconverted lead E unexpectedly produced a row: %', to_jsonb(v_row);
    v_fail_count := v_fail_count + 1;
  ELSE
    RAISE NOTICE 'P7 PASS: unconverted lead E produces no lead_goal_events row';
  END IF;

  IF v_fail_count = 0 THEN
    RAISE NOTICE 'HO-1 S16 PROOF: ALL ASSERTIONS PASSED';
  ELSE
    RAISE NOTICE 'HO-1 S16 PROOF: % ASSERTION(S) FAILED', v_fail_count;
  END IF;
END $$;

-- Caller must issue ROLLBACK here -- never COMMIT.
