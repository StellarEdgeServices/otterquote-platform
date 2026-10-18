-- LOCAL-ONLY seed: re-creates, under the SAME ids, the is_test production fixtures that the gh-2479 proofs read
-- (so the proof files run unchanged here). All rows is_test = true. Nothing here is ever run on production.
INSERT INTO public.profiles (id, is_test) VALUES
  ('f6c14b57-59dc-43ce-b510-04277a71f5af', true),  -- o, homeowner
  ('6a9ec731-85d4-4076-ae99-bc77829ee393', true),  -- stranger, homeowner
  ('d4def812-aebc-444c-bdee-f68bccc19b61', true),  -- k1u, contractor login
  ('189b85ad-0ab0-4e54-9083-c51c3ef42a1d', true);  -- k2u
INSERT INTO public.contractors (id, user_id, is_test) VALUES
  ('986ce2b6-39fd-4a2c-aba4-a806c618c8c0', 'd4def812-aebc-444c-bdee-f68bccc19b61', true),  -- k1
  ('bb07fc40-3607-4f3f-ac44-dffd4ca95111', '189b85ad-0ab0-4e54-9083-c51c3ef42a1d', true);  -- k2
INSERT INTO public.referral_agents (id, agent_type, is_test, first_name, last_name)
SELECT gen_random_uuid(), 're_agent', true, 'Proof', 'Agent' || g FROM generate_series(1, 7) g;
-- seven is_test referrals on seven is_test re_agent agents, status clicked, created 1 day ago
WITH ag AS (SELECT id, row_number() OVER (ORDER BY last_name) rn FROM public.referral_agents),
     ids(rn, rid) AS (VALUES
       (1, '542e4374-40ef-497e-ad75-083ec981d2c5'::uuid), (2, '81c587fc-8dd0-4fac-a203-70f57f08d2b2'),
       (3, '94471cc8-4f59-487c-87ec-8d4b3bd9db92'), (4, '976bac64-f6b3-4e61-b818-a721cd4aa482'),
       (5, '770c7bd8-532b-4f75-8a82-dfca275fcd98'), (6, '0cf7eeeb-62cd-4eeb-9354-db98889bcd32'),
       (7, 'dd14c823-1edb-4cd1-90f1-aaa8ea5273b1'))
INSERT INTO public.referrals (id, referral_agent_id, status, created_at, is_test)
SELECT ids.rid, ag.id, 'clicked', now() - interval '1 day', true FROM ag JOIN ids USING (rn);
-- o's claims: c1 awarded (selected 13560 quote of k1), csig contract_signed, cbid bidding. is_test.
INSERT INTO public.claims (id, user_id, is_test, status, created_at, job_type, funding_type, selected_contractor_id, selected_bid_amount) VALUES
  ('4d764e19-0549-43db-a967-9ab564f05f23', 'f6c14b57-59dc-43ce-b510-04277a71f5af', true, 'awarded', now() - interval '3 days', 'retail', 'cash', '986ce2b6-39fd-4a2c-aba4-a806c618c8c0', 13560),
  ('6aea8081-a3a3-4a22-a1a8-1becb7fedcb6', 'f6c14b57-59dc-43ce-b510-04277a71f5af', true, 'contract_signed', now() - interval '3 days', 'retail', 'cash', NULL, NULL),
  ('374a2053-de6c-4f9a-9974-2e22714a4795', 'f6c14b57-59dc-43ce-b510-04277a71f5af', true, 'bidding', now() - interval '3 days', 'retail', 'cash', NULL, NULL);
INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, is_test, trade_type) VALUES
  ('ff1f8323-1e74-43d6-a6b4-116b940dfa65', '4d764e19-0549-43db-a967-9ab564f05f23', '986ce2b6-39fd-4a2c-aba4-a806c618c8c0', 13560, 5, 678, 'selected', true, 'roofing');
