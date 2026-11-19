-- gh-2479 / gh-2519 / gh-2626 / gh-2864 / gh-3219 / gh-3560 / gh-3203 proof: quotes + referral_agents guards, the legitimate award, renewal and
-- referral-commission paths, and the #3203 login detach.   REFRESHED 2026-11-19 (refs #3203; replaces the 2026-10-05 version, blob 5ee3973e).
-- Run against production (yeszghaspzwwstvsrioa) in ONE statement batch that is forced to roll back. Needs Dustin's word for each production run.
-- The last statement is a deliberate RAISE EXCEPTION 'GH2479_QUOTES_FORCED_ROLLBACK...', so every fixture change below is undone; the raw findings are
-- the exception text. Each group runs inside its own savepoint (a block that raises P0U01 and catches it), so one group's writes never feed the next.
--
-- RESULT STYLE: every checked line starts PASS, FAIL or INFO. PASS/FAIL compares the observed result with the expectation printed on that line and the
-- guard / migration / decision that makes it so. INFO = observed, with no assertion, or an expectation this script cannot justify from a guard or decision.
-- The SUMMARY line counts them. The proof run is good when FAIL=0.
--
-- WHAT THE BATCH EXECUTES (statement classes; the ask for a production run must list exactly these):
--   CREATE FUNCTION in pg_temp (7 helpers and the scenario function) and one DO block that raises the forced rollback;
--   SELECTs on public tables, pg_trigger, pg_sequences, net.http_request_queue (count only), public.resolved_user_role;
--   UPDATE/INSERT on is_test fixture rows, each inside a savepoint that is rolled back: quotes (ff1f8323, 0a334300, be305d7c, 6e3d1807),
--     claims (4d764e19, 8dcf76f1, 374a2053 and three new claims), contractors (986ce2b6, bb07fc40, 2bc792be, and #3203 ee452a12),
--     referral_agents (02fbf1c3, 56c1319a, and #3203 1927861f), profiles (3ea4d929), auth.users.created_at (f6c14b57 only; auth.users has no UPDATE trigger),
--     one new referrals row per click (track_referral_click) and one payout_approvals row (apply_referral_commission);
--   the #3203 detach and its rollback exactly as PR #3674 carries them (BEGIN/COMMIT removed: this batch owns the transaction).
-- SIDE EFFECTS THAT CAN OUTLIVE THE ROLLBACK (measured by the SEQ and NETQ lines at the end): sequences advance (nextval is never rolled back);
--   pg_net: apply_referral_commission() calls net.http_post twice (notify-payout-pending, send-partner-status-email). net.http_post INSERTs into
--   net.http_request_queue inside THIS transaction (function body read from production); the pg_net worker reads only committed rows, so a rolled-back
--   row is never sent. The NETQ lines show the queue count before, inside the commission savepoint and after it. The #3203 contractor rollback step
--   would fire trg_notify_admin_new_contractor; on production this script first changes that contractor's email to an otterquote-internal.test address
--   (rolled back), which the trigger's own test-account skip turns into a no-op, so no net.http_post is attempted from that trigger at all.
-- Everything touched is is_test. Quote 403940dc (claim cbf2c780) is never addressed. FINGERPRINT (below) lets a SELECT after the run prove the
-- fixture rows are byte-for-byte what they were before it:
--   SELECT md5(string_agg(t, '|' ORDER BY k)) FROM (SELECT 'q'||id k, to_jsonb(q)::text t FROM public.quotes q WHERE id IN ('ff1f8323-1e74-43d6-a6b4-116b940dfa65','0a334300-2a4a-4ba6-ac77-efea0fa73179','be305d7c-7982-4e37-89a3-95b2ae79ce63','6e3d1807-b96c-4595-8153-ad7e39dc4aa7','6fd064f1-4d3f-4fda-af82-da9363a6812f','471b2b5a-fb94-4558-aaf7-aa1670d000a2') UNION ALL SELECT 'c'||id, to_jsonb(c)::text FROM public.claims c WHERE id IN ('4d764e19-0549-43db-a967-9ab564f05f23','8dcf76f1-f518-4363-a37f-192dec10b9bb','374a2053-de6c-4f9a-9974-2e22714a4795') UNION ALL SELECT 'k'||id, to_jsonb(k)::text FROM public.contractors k WHERE id IN ('986ce2b6-39fd-4a2c-aba4-a806c618c8c0','bb07fc40-3607-4f3f-ac44-dffd4ca95111','2bc792be-b677-4ac1-bc68-94b1561d9757','ee452a12-c16e-4d30-9d2c-df8128fbce52') UNION ALL SELECT 'a'||id, to_jsonb(a)::text FROM public.referral_agents a WHERE id IN ('02fbf1c3-6063-4b9e-98d0-387560ed6d97','56c1319a-6376-4405-8ccc-88a574d7ede4','1927861f-8836-49ce-a528-08c432cc69cc') UNION ALL SELECT 'p'||id, to_jsonb(p)::text FROM public.profiles p WHERE id IN ('f6c14b57-59dc-43ce-b510-04277a71f5af','3ea4d929-b916-4cc9-a285-d052df397992') UNION ALL SELECT 'u'||id, created_at::text FROM auth.users WHERE id='f6c14b57-59dc-43ce-b510-04277a71f5af' UNION ALL SELECT 't', (SELECT count(*) FROM public.claims)||'/'||(SELECT count(*) FROM public.quotes)||'/'||(SELECT count(*) FROM public.referrals)||'/'||(SELECT count(*) FROM public.payout_approvals)) s;
--
-- EXPECTATIONS (each cites what makes it so; where the old 2026-10-05 header differs, the old line is wrong now, not the product):
--   Guards (migration 20261005173827 gh-2479, 20261015205902 gh-2519, 20261015205851 gh-2626, 20261018195342 gh-2564, 20261020164812 gh-2864):
--     V2, P1, P2, P3, P3b, P4, K4, K5, A1 REJECTED 42501 (as before); P5 REJECTED (INSERT arm, D-199 bid gate); P6 REJECTED 42501;
--     P0, K6 rows=0 (RLS controls); K1 ACCEPTED (a contractor revising their own submitted bid).
--   CHANGED since the old header: H1, K3 REJECTED 42501 (gh-2864: signature stamps are platform-only, docusign-webhook); K2 REJECTED 42501 (the gh-2519
--     allow-list refuses bid_status and expires_at; the old 23514 came from a path that no longer reaches the table); K2b REJECTED 42501 (expires_at,
--     gh-2519 residual 3). Renewal is proven through renew_quote() (gh-3560, ledger 20261110201420; contractor-bid-form.html and bid-form.tsx call it).
--   H blocks: the fixture quotes are first put in the state a legitimate award needs (submitted, active, on a claim open for bids, contractor with a
--     payment method; superuser statements inside the savepoint), then accept_bid() succeeds (gh-2626 conditions) and direct owner updates that are not
--     awards of a live bid are rejected. Against the production fixtures as they stand (declined / superseded), the old H2b, H2c, H3 and H4 reject by design.
--   Referral step (D-402 items 2 and 3; migration 20261030144528 gh-3219 claims_apply_locked_referral, CREATION-CHECK n.created_at <= auth.users.created_at):
--     OWED case: homeowner account created AFTER the click, claim's selected contractor set, a selected quote of 15000 from that contractor ->
--     commission 200.00 and one payout_approvals row of 200. CONTROL: click AFTER account creation -> commission null, no payout row (credit never locked).
--   #3203 (D block): detach statements run first, as the batch's own role with no JWT claim set (how the apply runs them); proves what each row becomes.

CREATE FUNCTION pg_temp.try_su(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 140);
  END;
END $f$;

CREATE FUNCTION pg_temp.try_as(p_role text, p_sub uuid, p_sql text, p_email text DEFAULT 'gh2479-proof@example.invalid') RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', p_email)::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXECUTE 'RESET ROLE';
    RETURN 'rows=' || n || CASE WHEN n > 0 THEN ' ACCEPTED' ELSE ' (no row changed)' END;
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 140);
  END;
END $f$;

CREATE FUNCTION pg_temp.q_as(p_role text, p_sub uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims', CASE WHEN p_role = 'anon' THEN json_build_object('role', 'anon')::text
    ELSE json_build_object('sub', p_sub, 'role', p_role, 'email', 'gh2479-proof@example.invalid')::text END, true);
  PERFORM set_config('role', p_role, true);
  BEGIN
    EXECUTE p_sql INTO v;
    EXECUTE 'RESET ROLE';
    RETURN COALESCE(v, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    EXECUTE 'RESET ROLE';
    RETURN 'REJECTED ' || SQLSTATE || ' ' || left(SQLERRM, 140);
  END;
END $f$;

CREATE FUNCTION pg_temp.acc(p_ref uuid) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE r record; n int; s numeric; t text;
BEGIN
  SELECT status, commission_amount INTO r FROM public.referrals WHERE id = p_ref;
  SELECT count(*), COALESCE(sum(amount), 0), string_agg(DISTINCT is_test::text, ',')
    INTO n, s, t FROM public.payout_approvals WHERE referral_id = p_ref;
  RETURN format('referral %s status=%s commission=%s | payout_approvals rows=%s sum=%s is_test=%s',
                left(p_ref::text, 8), r.status, COALESCE(r.commission_amount::text, 'null'), n, s, COALESCE(t, '-'));
END $f$;

-- one result line: PASS / FAIL by regex on the observed text, with the cited guard, migration or decision
CREATE FUNCTION pg_temp.mk(p_id text, p_desc text, p_got text, p_pat text, p_cite text) RETURNS text LANGUAGE sql AS $f$
  SELECT E'\n' || CASE WHEN p_got ~ p_pat THEN 'PASS' ELSE 'FAIL' END || ' ' || p_id || ' ' || p_desc || ': ' || p_got
         || ' [expect /' || p_pat || '/ per ' || p_cite || ']'
$f$;

CREATE FUNCTION pg_temp.qn() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM net.http_request_queue;
  RETURN n::text;
EXCEPTION WHEN OTHERS THEN RETURN 'n/a(' || SQLSTATE || ')';
END $f$;

CREATE FUNCTION pg_temp.seqsnap() RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  RETURN (SELECT COALESCE(jsonb_object_agg(schemaname || '.' || sequencename, COALESCE(last_value, 0)), '{}'::jsonb) FROM pg_sequences);
EXCEPTION WHEN OTHERS THEN RETURN '{}'::jsonb;
END $f$;

CREATE FUNCTION pg_temp.gh2479_quotes_scenario() RETURNS text
LANGUAGE plpgsql AS $s$
DECLARE
  o    constant uuid := 'f6c14b57-59dc-43ce-b510-04277a71f5af'; -- is_test homeowner
  stranger constant uuid := '6a9ec731-85d4-4076-ae99-bc77829ee393'; -- another is_test homeowner
  c1   constant uuid := '4d764e19-0549-43db-a967-9ab564f05f23'; -- o's claim; production: bidding, selected contractor 8fa0d121
  q1   constant uuid := 'ff1f8323-1e74-43d6-a6b4-116b940dfa65'; -- production: declined/superseded 13560 on c1, contractor k1, both signature stamps set
  k1   constant uuid := '986ce2b6-39fd-4a2c-aba4-a806c618c8c0'; k1u constant uuid := 'd4def812-aebc-444c-bdee-f68bccc19b61';
  cs   constant uuid := '8dcf76f1-f518-4363-a37f-192dec10b9bb'; -- o's claim; production: awarded to k3 (the H blocks reopen it for bids)
  qs   constant uuid := '0a334300-2a4a-4ba6-ac77-efea0fa73179'; -- production: declined/cancelled 15000 on cs, contractor k2
  cb   constant uuid := '374a2053-de6c-4f9a-9974-2e22714a4795'; -- o's claim; production: awarded to k3
  qb   constant uuid := 'be305d7c-7982-4e37-89a3-95b2ae79ce63'; -- production: declined/active 15000 on cb, contractor k2
  k2   constant uuid := 'bb07fc40-3607-4f3f-ac44-dffd4ca95111'; k2u constant uuid := '189b85ad-0ab0-4e54-9083-c51c3ef42a1d';
  k3   constant uuid := '2bc792be-b677-4ac1-bc68-94b1561d9757'; -- is_test contractor with has_payment_method = true
  q2   constant uuid := '6e3d1807-b96c-4595-8153-ad7e39dc4aa7'; -- production: selected/active 15000, contractor k2, on a contract_signed claim of o
  rx   constant uuid := '770c7bd8-532b-4f75-8a82-dfca275fcd98'; -- another agent's referral, clicked
  insp_agent constant uuid := '56c1319a-6376-4405-8ccc-88a574d7ede4'; insp_user constant uuid := 'ac869f4e-9afe-4244-a390-0fff42cdc6e9'; -- otq-test-partner@otterquote.com (re_agent; gh-3203)
  -- gh-3203: the login and the three rows its detach touches
  login constant uuid := '3ea4d929-b916-4cc9-a285-d052df397992';
  dctr  constant uuid := 'ee452a12-c16e-4d30-9d2c-df8128fbce52';
  dagt  constant uuid := '1927861f-8836-49ce-a528-08c432cc69cc';
  c3 uuid := gen_random_uuid(); c4 uuid := gen_random_uuid(); c5 uuid := gen_random_uuid();
  v text := ''; t text; g text; rnew uuid; seq0 jsonb; seq1 jsonb; nq0 text; nq1 text; nq2 text; nq3 text;
  local_run boolean := COALESCE(current_setting('oq.proof_local', true), '') = '1';
  d_ctr_email text; r record;
BEGIN
  v := v || E'\nFIXTURES ' || format('owner_is_test=%s stranger_is_test=%s claims(c1,cs,cb)_is_test=%s quotes(q1,qs,qb,q2)_is_test=%s contractors(k1,k2,k3)_is_test=%s k3_has_payment_method=%s rx_is_test=%s insp_agent_is_test=%s',
    (SELECT is_test FROM profiles WHERE id = o), (SELECT is_test FROM profiles WHERE id = stranger),
    (SELECT bool_and(is_test) FROM claims WHERE id IN (c1, cs, cb)), (SELECT bool_and(is_test) FROM quotes WHERE id IN (q1, qs, qb, q2)),
    (SELECT bool_and(is_test) FROM contractors WHERE id IN (k1, k2, k3)), (SELECT has_payment_method FROM contractors WHERE id = k3), (SELECT is_test FROM referrals WHERE id = rx),
    (SELECT is_test FROM referral_agents WHERE id = insp_agent));
  v := v || E'\nFIXTURE-STATE ' || format('q1=%s/%s qs=%s/%s qb=%s/%s q2=%s/%s | claims c1=%s cs=%s cb=%s',
    (SELECT status FROM quotes WHERE id = q1), (SELECT bid_status FROM quotes WHERE id = q1), (SELECT status FROM quotes WHERE id = qs), (SELECT bid_status FROM quotes WHERE id = qs),
    (SELECT status FROM quotes WHERE id = qb), (SELECT bid_status FROM quotes WHERE id = qb), (SELECT status FROM quotes WHERE id = q2), (SELECT bid_status FROM quotes WHERE id = q2),
    (SELECT status FROM claims WHERE id = c1), (SELECT status FROM claims WHERE id = cs), (SELECT status FROM claims WHERE id = cb));
  v := v || E'\nGUARDS ' || format('quotes_guard_homeowner_columns=%s referral_agents_guard_agent_type=%s quotes_refuse_client_signature_change=%s claims_lock_referral=%s',
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'quotes_guard_homeowner_columns' AND NOT tgisinternal),
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'referral_agents_guard_agent_type' AND NOT tgisinternal),
    (SELECT count(*) FROM pg_proc WHERE proname = 'quotes_refuse_client_signature_change'),
    (SELECT count(*) FROM pg_trigger WHERE tgname = 'claims_lock_referral' AND NOT tgisinternal));
  v := v || E'\nINFO SESSION ' || format('current_user=%s jwt_claims=%s proof_local=%s', current_user, COALESCE(current_setting('request.jwt.claims', true), '<unset>'), local_run);
  seq0 := pg_temp.seqsnap(); nq0 := pg_temp.qn();
  v := v || E'\nINFO NETQ-start net.http_request_queue rows=' || nq0;

  -- ======================= D: #3203 detach of dustinstohler1@gmail.com (login 3ea4d929) =======================
  -- Runs FIRST, before any set_config() below, so the session carries no JWT claim, as when the apply is run as the project's database role.
  v := v || E'\nINFO D0 READ (no change) contractor ' || COALESCE((SELECT format('%s status=%s user_id=%s is_test=%s email=%s', left(id::text,8), status, left(user_id::text,8), is_test, email) FROM contractors WHERE id = dctr), 'MISSING');
  v := v || E'\nINFO D0 READ (no change) referral_agent ' || COALESCE((SELECT format('%s status=%s user_id=%s is_test=%s agent_type=%s', left(id::text,8), status, left(user_id::text,8), is_test, agent_type) FROM referral_agents WHERE id = dagt), 'MISSING');
  v := v || E'\nINFO D0 READ (no change) profile ' || COALESCE((SELECT format('%s role=%s is_test=%s', left(id::text,8), role, is_test) FROM profiles WHERE id = login), 'MISSING');
  v := v || E'\nINFO D0 READ (no change) resolved_user_role ' || COALESCE((SELECT format('is_contractor=%s is_active_partner=%s partner_agent_type=%s owns_claim=%s profile_role=%s derived_role=%s', is_contractor, is_active_partner, partner_agent_type, owns_claim, profile_role, derived_role) FROM public.resolved_user_role WHERE user_id = login), 'no row');
  v := v || E'\nINFO D0 READ (no change) claims/quotes tied to the login or contractor: ' || format('claims.user_id=%s claims.selected_contractor=%s quotes.contractor=%s', (SELECT count(*) FROM claims WHERE user_id = login), (SELECT count(*) FROM claims WHERE selected_contractor_id = dctr), (SELECT count(*) FROM quotes WHERE contractor_id = dctr));
  v := v || E'\nINFO D0 triggers on the three tables (enabled, non-internal): ' || (SELECT string_agg(c.relname || '.' || t.tgname, ', ' ORDER BY c.relname, t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND c.relnamespace = 'public'::regnamespace AND c.relname IN ('contractors', 'referral_agents', 'profiles'));
  -- PHASE 1: the statements exactly as PR #3674 carries them (supabase/migrations_drafts/gh3203_detach_admin_login_test_roles.sql, head e56a6388, sha256 7e973e5c81f35f6f...),
  -- BEGIN/COMMIT removed, run bare: the batch's own role, no JWT claim (how the apply runs them).
  BEGIN
    g := pg_temp.try_su($dg$DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.contractors
   WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND is_test = true;
  IF n <> 1 THEN RAISE EXCEPTION 'gh3203 guard: contractor ee452a12 not in expected pre-state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.referral_agents
   WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND is_test = true;
  IF n <> 1 THEN RAISE EXCEPTION 'gh3203 guard: agent 1927861f not in expected pre-state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.claims WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992'
     OR selected_contractor_id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 guard: % claims reference the login/contractor; stop and ask', n; END IF;
END $$;$dg$);
    v := v || pg_temp.mk('D1', 'detach pre-state guard (contractor, agent, no claims)', CASE WHEN g LIKE 'REJECTED%' THEN g ELSE 'ok' END, '^ok$', 'PR #3674 guard DO block');
    g := pg_temp.try_su($d1$UPDATE public.contractors SET status = 'inactive', user_id = NULL
 WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992';$d1$);
    v := v || pg_temp.mk('D2', 'contractors ee452a12 -> status inactive, user_id NULL (bare)', g, '^rows=1 ACCEPTED$', 'PR #3674 UPDATE 1; trg_contractors_privileged_guard passes when no JWT claim is set (request_is_privileged), contractors_freeze_privileged_columns exempts non-authenticated roles, trg_notify_admin_new_contractor returns early for status <> pending_approval');
    g := pg_temp.try_su($d2$UPDATE public.referral_agents SET status = 'suspended'
 WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND status = 'active';$d2$);
    v := v || pg_temp.mk('D3', 'FINDING: referral_agents 1927861f -> suspended, run bare, is REFUSED (PR #3674 UPDATE 2 needs a service_role claim)', g, '^REJECTED 42501 referral_agents: payout-governing columns can only be changed by service_role or an admin \(gh-886\)', 'referral_agents_guard_payout_columns (gh-886): status is pinned unless auth.role() = service_role or is_admin_email(); a bare apply as the database role has neither, so the PR''s BEGIN..COMMIT would abort at statement 2 (safe, but the draft does not apply as written)');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-A aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-REF-b aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-REF-a aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-S aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-H5 aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-H aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-R aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-K aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-P aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-V aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-D-phase2 aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
    WHEN OTHERS THEN v := v || format(E'\nFAIL BLOCK-D-phase1 aborted by an unexpected error %s %s (its writes are rolled back)', SQLSTATE, left(SQLERRM, 200));
  END;
  -- PHASE 2: the same statements with ONE added line first (the proposed fix for PR #3674): the service_role claim, transaction-local.
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    g := pg_temp.try_su($dg$DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.contractors
   WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND is_test = true;
  IF n <> 1 THEN RAISE EXCEPTION 'gh3203 guard: contractor ee452a12 not in expected pre-state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.referral_agents
   WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND is_test = true;
  IF n <> 1 THEN RAISE EXCEPTION 'gh3203 guard: agent 1927861f not in expected pre-state (found %)', n; END IF;
  SELECT count(*) INTO n FROM public.claims WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992'
     OR selected_contractor_id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 guard: % claims reference the login/contractor; stop and ask', n; END IF;
END $$;$dg$);
    v := v || pg_temp.mk('D1b', 'detach pre-state guard under the service_role claim', CASE WHEN g LIKE 'REJECTED%' THEN g ELSE 'ok' END, '^ok$', 'PR #3674 guard DO block');
    v := v || pg_temp.mk('D2b', 'contractors ee452a12 -> inactive, user_id NULL', pg_temp.try_su($d1$UPDATE public.contractors SET status = 'inactive', user_id = NULL
 WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id = '3ea4d929-b916-4cc9-a285-d052df397992';$d1$), '^rows=1 ACCEPTED$', 'PR #3674 UPDATE 1 (request_is_privileged: role service_role)');
    v := v || pg_temp.mk('D3b', 'referral_agents 1927861f -> suspended', pg_temp.try_su($d2$UPDATE public.referral_agents SET status = 'suspended'
 WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND status = 'active';$d2$), '^rows=1 ACCEPTED$', 'PR #3674 UPDATE 2; referral_agents_guard_payout_columns returns early for auth.role() = service_role');
    v := v || pg_temp.mk('D4', 'profiles 3ea4d929 -> role homeowner', pg_temp.try_su($d3$UPDATE public.profiles SET role = 'homeowner'
 WHERE id = '3ea4d929-b916-4cc9-a285-d052df397992' AND role = 'contractor';$d3$), '^rows=1 ACCEPTED$', 'PR #3674 UPDATE 3; profiles_freeze_privileged_columns only constrains anon/authenticated');
    g := pg_temp.try_su($dp$DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.contractors WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 post-check: login still owns % contractors rows', n; END IF;
  SELECT count(*) INTO n FROM public.referral_agents WHERE user_id = '3ea4d929-b916-4cc9-a285-d052df397992' AND status = 'active';
  IF n <> 0 THEN RAISE EXCEPTION 'gh3203 post-check: login still has % active agent rows', n; END IF;
END $$;$dp$);
    v := v || pg_temp.mk('D5', 'detach post-check (login owns no contractors row, no active agent row)', CASE WHEN g LIKE 'REJECTED%' THEN g ELSE 'ok' END, '^ok$', 'PR #3674 post-check DO block');
    v := v || E'\nINFO D6 after detach: contractor ' || COALESCE((SELECT format('status=%s user_id=%s', status, COALESCE(left(user_id::text,8),'NULL')) FROM contractors WHERE id = dctr), 'MISSING')
      || ' | agent ' || COALESCE((SELECT status FROM referral_agents WHERE id = dagt), 'MISSING') || ' | profile role ' || COALESCE((SELECT role FROM profiles WHERE id = login), 'MISSING')
      || ' | resolved_user_role ' || COALESCE((SELECT format('is_contractor=%s is_active_partner=%s derived_role=%s', is_contractor, is_active_partner, derived_role) FROM public.resolved_user_role WHERE user_id = login), 'no row');
    v := v || pg_temp.mk('D6s', 'what each row becomes', (SELECT format('contractor=%s/%s agent=%s role=%s', c.status, COALESCE(left(c.user_id::text,8),'NULL'), a.status, p.role) FROM contractors c, referral_agents a, profiles p WHERE c.id = dctr AND a.id = dagt AND p.id = login), '^contractor=inactive/NULL agent=suspended role=homeowner$', 'PR #3674 intended result');
    v := v || pg_temp.mk('D7', 'derived role no longer contractor or partner for the login (no row = nothing derived)', COALESCE((SELECT format('is_contractor=%s is_active_partner=%s', is_contractor, is_active_partner) FROM public.resolved_user_role WHERE user_id = login), 'no row'), '^(is_contractor=(false|f) is_active_partner=(false|f)|no row)$', '20260819224215_v113_derived_role_view: is_contractor = EXISTS(contractors row for the user), is_active_partner = status active');
    v := v || E'\nINFO D8 admin access is the admin_emails allowlist, not a role row, so the detach does not touch it; allowlist has the login email: ' || COALESCE((SELECT (EXISTS (SELECT 1 FROM public.admin_emails ae WHERE ae.email = (SELECT email FROM profiles WHERE id = login)))::text), 'n/a');
    -- the rollback, exactly as supabase/migrations_drafts/gh3203_detach_admin_login_test_roles_rollback.sql carries it (sha256 82df2ac7a6dc3fb6...)
    SELECT email INTO d_ctr_email FROM contractors WHERE id = dctr;
    IF NOT local_run THEN
      -- production belt: trg_notify_admin_new_contractor skips test-account emails, so no net.http_post is attempted from it. Rolled back with the batch.
      UPDATE public.contractors SET email = 'gh3203-proof@otterquote-internal.test' WHERE id = dctr;
      v := v || E'\nINFO D9 production run: contractor email set to an otterquote-internal.test address inside the batch so trg_notify_admin_new_contractor skips (its own test-account guard); rolled back';
    END IF;
    v := v || E'\nINFO D9b pg_net overloads of http_post visible here: ' || COALESCE((SELECT string_agg(p.oid::regprocedure::text, ', ') FROM pg_proc p WHERE p.pronamespace = 'net'::regnamespace AND p.proname = 'http_post'), 'none')
      || ' | notify_admin_new_contractor passes body := ...::text::bytea: ' || (SELECT (pg_get_functiondef(p.oid) ~ '::text::bytea')::text FROM pg_proc p WHERE p.proname = 'notify_admin_new_contractor' AND p.pronamespace = 'public'::regnamespace LIMIT 1);
    nq1 := pg_temp.qn();
    g := pg_temp.try_su($r1$UPDATE public.contractors SET status = 'pending_approval', user_id = '3ea4d929-b916-4cc9-a285-d052df397992'
 WHERE id = 'ee452a12-c16e-4d30-9d2c-df8128fbce52' AND user_id IS NULL;$r1$);
    v := v || pg_temp.mk('D10', 'rollback UPDATE 1: contractor back to pending_approval + user_id 3ea4d929 (fires trg_notify_admin_new_contractor)', g, '^rows=1 ACCEPTED$', 'rollback file UPDATE 1');
    nq2 := pg_temp.qn();
    v := v || E'\nINFO D10b net.http_request_queue rows before / after the rollback UPDATE: ' || nq1 || ' / ' || nq2
      || CASE WHEN local_run THEN ' (local run, real email ' || COALESCE(d_ctr_email,'') || ', stand-in pg_net with the same http_post signature)' ELSE ' (production run, test-address email: trigger skips)' END;
    v := v || pg_temp.mk('D11', 'rollback UPDATE 2: agent back to active', pg_temp.try_su($r2$UPDATE public.referral_agents SET status = 'active'
 WHERE id = '1927861f-8836-49ce-a528-08c432cc69cc' AND status = 'suspended';$r2$), '^rows=1 ACCEPTED$', 'rollback file UPDATE 2');
    v := v || pg_temp.mk('D12', 'rollback UPDATE 3: profile role back to contractor', pg_temp.try_su($r3$UPDATE public.profiles SET role = 'contractor'
 WHERE id = '3ea4d929-b916-4cc9-a285-d052df397992' AND role = 'homeowner';$r3$), '^rows=1 ACCEPTED$', 'rollback file UPDATE 3');
    v := v || pg_temp.mk('D13', 'rows are what D0 read (status / user_id / role)',
      (SELECT format('contractor=%s/%s agent=%s role=%s', c.status, left(c.user_id::text,8), a.status, p.role) FROM contractors c, referral_agents a, profiles p WHERE c.id = dctr AND a.id = dagt AND p.id = login),
      '^contractor=pending_approval/3ea4d929 agent=active role=contractor$', 'rollback file restores the pre-state read by D0');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  nq3 := pg_temp.qn();
  v := v || pg_temp.mk('D14', 'after the D savepoint rolled back, the three rows are untouched', (SELECT format('contractor=%s/%s agent=%s role=%s', c.status, left(c.user_id::text,8), a.status, p.role) FROM contractors c, referral_agents a, profiles p WHERE c.id = dctr AND a.id = dagt AND p.id = login),
    '^contractor=[a-z_]+/(3ea4d929|NULL) agent=[a-z]+ role=[a-z]+$', 'savepoint rollback (compare with D0, INFO lines above)');
  v := v || E'\nINFO D15 net.http_request_queue rows after the D savepoint: ' || nq3 || ' (before D: ' || nq0 || ')';

  -- ======================= V: the refuter's attack (#2479 comment 5998207363, V1-V3) =======================
  BEGIN
    v := v || E'\nINFO V1 OWNER INSERT new claim c3 with referral_id=rx (initial state): ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.claims (id,user_id,is_test,referral_id) VALUES (%L,%L,true,%L)', c3, o, rx));
    UPDATE public.claims SET status = 'contract_signed' WHERE id = c3; -- fixture (superuser)
    v := v || E'\nINFO V1 RESULT ' || pg_temp.acc(rx);
    v := v || pg_temp.mk('V2', 'OWNER UPDATE quotes.claim_id onto c3', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET claim_id=%L WHERE id=%L', c3, q1)), '^REJECTED 42501 quotes: claim_id and contractor_id can only be changed', 'gh-2479 quotes_guard_homeowner_columns (20261005173827)');
    v := v || E'\nINFO V2 STATE ' || format('quote.claim_id=c3:%s quote.claim_id=c1:%s quote.status=%s total_price=%s', (SELECT claim_id = c3 FROM quotes WHERE id = q1), (SELECT claim_id = c1 FROM quotes WHERE id = q1), (SELECT status FROM quotes WHERE id = q1), (SELECT total_price FROM quotes WHERE id = q1));
    v := v || E'\nINFO V3 service_role UPDATE c3.completion_date: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', c3));
    v := v || pg_temp.mk('V3r', 'no commission from the attack claim (null is over-determined: rx was clicked after the owner account existed, so gh-3219 cleared it at INSERT; c3 also has no selected contractor)', pg_temp.acc(rx), 'commission=null \| payout_approvals rows=0 ', 'gh-2479 + gh-3219 (20261030144528) + D-402 item 3');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= P: #2519 and the other homeowner writes that must be refused =======================
  -- Fixture (superuser, rolled back): qs is a submitted, active bid on cs (open for bids); q1 is selected on c1. The refusals are then tested against the states they were written for.
  BEGIN
    UPDATE public.quotes SET status = 'declined', bid_status = 'superseded' WHERE claim_id IN (cs, cb) AND id NOT IN (qs, qb); -- fixture: production also holds selected test quotes 6fd064f1 (cs) and 471b2b5a (cb); retire them so the states below are the ones named
    UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = cs;
    UPDATE public.quotes SET status = 'submitted', bid_status = 'active', cancelled_at = NULL, expired_at = NULL, expires_at = now() + interval '14 days' WHERE id = qs;
    UPDATE public.quotes SET status = 'selected', bid_status = 'active', cancelled_at = NULL WHERE id = q1;
    v := v || E'\nINFO P-fixture ' || format('qs=%s/%s q1=%s/%s cs=%s', (SELECT status FROM quotes WHERE id = qs), (SELECT bid_status FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = q1), (SELECT bid_status FROM quotes WHERE id = q1), (SELECT status FROM claims WHERE id = cs));
    v := v || pg_temp.mk('P0', 'CONTROL stranger UPDATE qs.total_price', pg_temp.try_as('authenticated', stranger, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', qs)), '^rows=0 \(no row changed\)$', 'quotes RLS: a stranger sees no row');
    v := v || pg_temp.mk('P1', 'OWNER UPDATE qs.total_price=99999 (#2519 closes-on)', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', qs)), '^REJECTED 42501 quotes: total_price can only be changed by the bidding contractor', 'gh-2519 (20261015205902)');
    v := v || pg_temp.mk('P1s', 'qs total_price unchanged', (SELECT total_price::text FROM quotes WHERE id = qs), '^15000\.00$', 'rejection leaves the row as it was');
    v := v || pg_temp.mk('P2', 'OWNER UPDATE qs total_price=99999 + status=selected in one statement (refuter V4)', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=99999, status=''selected'' WHERE id=%L', qs)), '^REJECTED 42501 quotes: total_price can only be changed by the bidding contractor', 'gh-2519');
    v := v || pg_temp.mk('P2s', 'qs still submitted at 15000', (SELECT status || '/' || total_price FROM quotes WHERE id = qs), '^submitted/15000\.00$', 'rejection leaves the row as it was (this is a real check now: qs starts submitted)');
    v := v || pg_temp.mk('P3', 'OWNER UPDATE q1.status selected -> submitted', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''submitted'' WHERE id=%L', q1)), '^REJECTED 42501 quotes: status can only be set to selected or declined by the claim owner', 'gh-2479');
    v := v || pg_temp.mk('P3b', 'OWNER UPDATE qs.status submitted -> expired', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''expired'' WHERE id=%L', qs)), '^REJECTED 42501 quotes: status can only be set to selected or declined by the claim owner', 'gh-2479');
    v := v || pg_temp.mk('P4', 'OWNER UPDATE qs.contractor_id to another contractor', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET contractor_id=%L WHERE id=%L', k1, qs)), '^REJECTED 42501 quotes: claim_id and contractor_id can only be changed', 'gh-2479');
    v := v || pg_temp.mk('P5', 'OWNER upsert q1 (INSERT ON CONFLICT (id) DO UPDATE SET claim_id)', pg_temp.try_as('authenticated', o, format('INSERT INTO public.quotes (id,claim_id,contractor_id,total_price) VALUES (%L,%L,%L,13560) ON CONFLICT (id) DO UPDATE SET claim_id=excluded.claim_id', q1, cs, k1)), '^REJECTED (P0001 D-199 bid gate|42501)', 'the INSERT arm is checked first (D-199 bid gate / quotes INSERT guard)');
    v := v || pg_temp.mk('P6', 'anon UPDATE qs.total_price', pg_temp.try_as('anon', NULL, format('UPDATE public.quotes SET total_price=99999 WHERE id=%L', qs)), '^REJECTED 42501 permission denied for table quotes', 'anon holds no UPDATE on quotes');
    v := v || pg_temp.mk('P7', 'OWNER re-selects a quote that is not a live submitted bid (qs forced to declined/cancelled first)', (SELECT pg_temp.try_su(format('UPDATE public.quotes SET status=''declined'', bid_status=''cancelled'' WHERE id=%L', qs)) || ' then ' ||
        pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qs))), 'REJECTED 42501 quotes: only a submitted, active bid can be selected by the claim owner', 'gh-2626 (20261015205851)');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= K: contractor writes =======================
  BEGIN
    UPDATE public.quotes SET status = 'declined', bid_status = 'superseded' WHERE claim_id IN (cs, cb) AND id NOT IN (qs, qb); -- fixture: production also holds selected test quotes 6fd064f1 (cs) and 471b2b5a (cb); retire them so the states below are the ones named
    UPDATE public.quotes SET status = 'submitted', bid_status = 'active', cancelled_at = NULL, expired_at = NULL, expires_at = now() + interval '7 days' WHERE id = qb; -- fixture: a live submitted bid of k2 on cb (7 days, so the 14-day payloads below are a real change; now() is one value for the whole batch)
    UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = cb;
    UPDATE public.quotes SET status = 'selected', bid_status = 'active', cancelled_at = NULL WHERE id = q1; -- fixture: k1's selected quote
    v := v || pg_temp.mk('K1', 'LEGIT CONTRACTOR revises own submitted bid qb (total_price, fee, scope, notes, updated_at)', pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15500, fee_percentage=fee_percentage, fee_amount=fee_amount, scope_summary=''gh2479 proof'', notes=''gh2479 proof'', updated_at=now() WHERE id=%L', qb)), '^rows=1 ACCEPTED$', 'gh-2519 allow-list: total_price, scope_summary, notes are contractor columns while the bid is not selected');
    v := v || pg_temp.mk('K2', 'CONTRACTOR renewal payload on qb (bid_status=submitted, expires_at; the pre-gh-3560 client payload)', pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15600, bid_status=''submitted'', expired_at=NULL, expires_at=now()+interval ''14 days'' WHERE id=%L', qb)), '^REJECTED 42501 quotes: .*expires_at.* can only be changed by service_role or an admin \(gh-2519\)', 'gh-2519 residual-3 allow-list (20261015205902); renewal moved to renew_quote() (gh-3560)');
    v := v || pg_temp.mk('K2b', 'CONTRACTOR renewal payload without bid_status (price, expired_at, expires_at)', pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET total_price=15600, expired_at=NULL, expires_at=now()+interval ''14 days'' WHERE id=%L', qb)), '^REJECTED 42501 quotes: .*expires_at.* can only be changed by service_role or an admin \(gh-2519\)', 'gh-2519 residual-3 allow-list');
    v := v || pg_temp.mk('K3', 'CONTRACTOR stamps contractor_signed_at on own selected quote q1', pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET contractor_signed_at=now() WHERE id=%L', q1)), '^REJECTED 42501 quotes: a signature stamp .* can only be written by the platform', 'gh-2864 quotes_refuse_client_signature_change (20261020164812; docusign-webhook writes the stamps)');
    v := v || pg_temp.mk('K4', 'CONTRACTOR UPDATE own qb.claim_id to another claim', pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET claim_id=%L WHERE id=%L', cs, qb)), '^REJECTED 42501 quotes: claim_id and contractor_id can only be changed', 'gh-2479');
    v := v || pg_temp.mk('K5', 'CONTRACTOR UPDATE own qb.status=selected (self-award)', pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qb)), '^REJECTED 42501 quotes: status can only be set to selected or declined by the claim owner', 'gh-2479');
    v := v || pg_temp.mk('K6', 'CONTROL other contractor UPDATE qb.total_price', pg_temp.try_as('authenticated', k1u, format('UPDATE public.quotes SET total_price=1 WHERE id=%L', qb)), '^rows=0 \(no row changed\)$', 'quotes RLS: another contractor sees no row');
    v := v || pg_temp.mk('KR', 'qb after K: price 15500, still submitted, still on cb', (SELECT format('total_price=%s status=%s claim=cb:%s', total_price, status, claim_id = cb) FROM quotes WHERE id = qb), '^total_price=15500\.00 status=submitted claim=cb:t(rue)?$', 'K1 landed; K2-K5 left no trace');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= R: renewal through renew_quote() (gh-3560) =======================
  BEGIN
    UPDATE public.quotes SET status = 'declined', bid_status = 'superseded' WHERE claim_id IN (cs, cb) AND id NOT IN (qs, qb); -- fixture: production also holds selected test quotes 6fd064f1 (cs) and 471b2b5a (cb); retire them so the states below are the ones named
    UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = cb;
    UPDATE public.quotes SET status = 'submitted', bid_status = 'expired', expired_at = now() - interval '1 day', expires_at = now() - interval '1 day', cancelled_at = NULL WHERE id = qb; -- fixture: an expired bid of k2
    v := v || E'\nINFO R-fixture ' || format('qb=%s/%s contractor_can_bid(k2)=%s cb=%s', (SELECT status FROM quotes WHERE id = qb), (SELECT bid_status FROM quotes WHERE id = qb), public.contractor_can_bid(k2), (SELECT status FROM claims WHERE id = cb));
    v := v || pg_temp.mk('R0', 'CONTROL other contractor calls renew_quote on k2''s bid', pg_temp.try_as('authenticated', k1u, format('SELECT public.renew_quote(%L, ''renew'')', qb)), '^REJECTED 42501 renew_quote: this bid is not yours', 'gh-3560 (20261110201420) ownership gate');
    v := v || pg_temp.mk('R1', 'LEGIT CONTRACTOR renews own expired bid through renew_quote(qb, renew)', pg_temp.try_as('authenticated', k2u, format('SELECT public.renew_quote(%L, ''renew'')', qb)), '^rows=1 ACCEPTED$', 'gh-3560: SECURITY DEFINER, contractor_can_bid(k2) true, status submitted, bid_status expired');
    v := v || pg_temp.mk('R1s', 'qb is active again with a fresh 14-day window and no expired_at', (SELECT format('bid_status=%s expired_at=%s window_days=%s', bid_status, COALESCE(expired_at::text, 'NULL'), round(extract(epoch FROM (expires_at - now())) / 86400)) FROM quotes WHERE id = qb), '^bid_status=active expired_at=NULL window_days=14$', 'renew_quote sets exactly bid_status active, expired_at NULL, expires_at now()+14 days (D-150)');
    v := v || pg_temp.mk('R2', 'renewing an already-active bid is refused', pg_temp.try_as('authenticated', k2u, format('SELECT public.renew_quote(%L, ''renew'')', qb)), '^REJECTED 55000 renew_quote: mode renew needs a expired bid', 'gh-3560 state gate');
    v := v || pg_temp.mk('R3', 'the same renewal as a direct UPDATE is still refused (the allow-list is not widened)', pg_temp.try_as('authenticated', k2u, format('UPDATE public.quotes SET bid_status=''active'', expires_at=now()+interval ''30 days'' WHERE id=%L', qb)), '^REJECTED 42501 quotes: .*expires_at.* can only be changed by service_role or an admin \(gh-2519\)', 'gh-2519 allow-list (gh-3560 header: "the allow-list is NOT widened")');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= H: homeowner writes the product makes =======================
  -- H1 = contract-signing. Fixture (superuser, inside the savepoint): claims cs and cb open for bids, qs and qb live submitted bids from k3 (payment method on file).
  BEGIN
    UPDATE public.quotes SET status = 'declined', bid_status = 'superseded' WHERE claim_id IN (cs, cb) AND id NOT IN (qs, qb); -- fixture: production also holds selected test quotes 6fd064f1 (cs) and 471b2b5a (cb); retire them so the states below are the ones named
    UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id IN (cs, cb);
    UPDATE public.quotes SET claim_id = cs, contractor_id = k3, status = 'submitted', bid_status = 'active', cancelled_at = NULL, expired_at = NULL, expires_at = now() + interval '14 days' WHERE id IN (qs, qb);
    v := v || E'\nINFO H-fixture ' || format('qs=%s/%s qb=%s/%s on cs=%s cs=%s k3_pm=%s', (SELECT status FROM quotes WHERE id = qs), (SELECT bid_status FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = qb), (SELECT bid_status FROM quotes WHERE id = qb), (SELECT (claim_id = cs)::text FROM quotes WHERE id = qb), (SELECT status FROM claims WHERE id = cs), (SELECT has_payment_method FROM contractors WHERE id = k3));
    v := v || pg_temp.mk('H1', 'OWNER stamps homeowner_signed_at on q1 directly', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET homeowner_signed_at=now() WHERE id=%L', q1)), '^REJECTED 42501 quotes: a signature stamp .* can only be written by the platform', 'gh-2864 (20261020164812)');
    v := v || pg_temp.mk('H4', 'LEGIT OWNER accept_bid(cs, qs) RPC on a live submitted bid', pg_temp.q_as('authenticated', o, format('SELECT ''quote='' || left(out_quote_id::text,8) || '' amount='' || out_amount || '' declined='' || out_declined_count FROM public.accept_bid(%L,%L)', cs, qs)), '^quote=0a334300 amount=15000\.00 declined=1$', 'accept_bid (gh-2626 / gh-2519 / gh-1532): bid submitted + active, claim bidding, contractor has a payment method; declines the other submitted bid');
    v := v || pg_temp.mk('H4s', 'after accept_bid: qs selected, qb declined, claim awarded to k3', (SELECT format('qs=%s qb=%s claim cs=%s selected_contractor=k3:%s amount=%s', (SELECT status FROM quotes WHERE id = qs), (SELECT status FROM quotes WHERE id = qb), c.status, c.selected_contractor_id = k3, c.selected_bid_amount) FROM claims c WHERE c.id = cs), '^qs=selected qb=declined claim cs=awarded selected_contractor=k3:t(rue)? amount=15000\.00$', 'accept_bid body (read from the repo migrations and production)');
    v := v || pg_temp.mk('H4r', 'repeat accept_bid on the live winner writes nothing and returns it', pg_temp.q_as('authenticated', o, format('SELECT ''quote='' || left(out_quote_id::text,8) || '' declined='' || out_declined_count FROM public.accept_bid(%L,%L)', cs, qs)), '^quote=0a334300 declined=0$', 'gh-2519 "already the live selected bid" return');
    v := v || pg_temp.mk('H2b', 'OWNER direct UPDATE re-selects the declined loser qb', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qb)), '^REJECTED 42501 quotes: only a submitted, active bid can be selected by the claim owner', 'gh-2626 (a declined bid is not selectable)');
    v := v || pg_temp.mk('H2c', 'OWNER direct UPDATE declines the winner qs', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''declined'' WHERE id=%L', qs)), '^REJECTED 42501 quotes: only a submitted bid can be declined by the claim owner', 'gh-2626 (decline only from submitted)');
    v := v || pg_temp.mk('H2d', 'OWNER direct UPDATE of the selected quote''s price', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET total_price=1 WHERE id=%L', qs)), '^REJECTED 42501 quotes: total_price can only be changed by the bidding contractor', 'gh-2519 / gh-2564 price lock');
    v := v || pg_temp.mk('H4x', 'accept_bid on the declined loser qb is refused', pg_temp.q_as('authenticated', o, format('SELECT ''quote='' || left(out_quote_id::text,8) FROM public.accept_bid(%L,%L)', cs, qb)), '^REJECTED 42501 accept_bid: another bid on this claim is already selected; a second bid cannot be selected beside it \(gh-2519\)', 'accept_bid gh-2519 one-selected-bid-per-claim check (qb is declined, which gh-2626 would let through, but qs is the live selected bid of the claim)');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- H5: the direct-update award path (React awardClaimToContractor before gh-2914), on a live state: refused since gh-2819.
  BEGIN
    UPDATE public.quotes SET status = 'declined', bid_status = 'superseded' WHERE claim_id IN (cs, cb) AND id NOT IN (qs, qb); -- fixture: production also holds selected test quotes 6fd064f1 (cs) and 471b2b5a (cb); retire them so the states below are the ones named
    UPDATE public.claims SET status = 'bidding', selected_contractor_id = NULL, selected_bid_amount = NULL WHERE id = cs;
    UPDATE public.quotes SET claim_id = cs, contractor_id = k3, status = 'submitted', bid_status = 'active', cancelled_at = NULL, expired_at = NULL, expires_at = now() + interval '14 days' WHERE id = qs;
    v := v || E'\nINFO H5a OWNER direct claims UPDATE to awarded with selected contractor k3 at qs price: ' || pg_temp.try_as('authenticated', o, format('UPDATE public.claims SET selected_contractor_id=%L, selected_bid_amount=15000, status=''awarded'' WHERE id=%L', k3, cs)) || ' [observed only: claims_guard_award_columns (gh-2626) and claims_enforce_payment_method_on_award (gh-1532/gh-2620) decide]';
    v := v || pg_temp.mk('H5b', 'OWNER direct UPDATE selects a live submitted, active bid (the old H2b path)', pg_temp.try_as('authenticated', o, format('UPDATE public.quotes SET status=''selected'' WHERE id=%L', qs)), '^REJECTED 42501 quotes: a bid can only be marked selected by accept_bid\(\); a direct status write is refused \(gh-2819\)', 'gh-2819 (20261019220737): selection only through accept_bid()');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= S: service_role writes =======================
  BEGIN
    v := v || pg_temp.mk('S1', 'LEGIT service_role UPDATE qb total_price + status=expired + claim_id', pg_temp.try_as('service_role', NULL, format('UPDATE public.quotes SET total_price=15001, status=''expired'', claim_id=%L WHERE id=%L', cs, qb)), '^rows=1 ACCEPTED$', 'guards constrain anon/authenticated only (current_user and auth.role())');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= REF: referral commission, D-402 items 2 and 3 =======================
  -- OWED: the click happens, then the homeowner's account is created (auth.users.created_at moved to one minute after the click, inside the batch),
  -- then the claim is filed with the click's referral; the claim's selected contractor is k2 with a selected 15000 quote (q2); service_role completes it.
  BEGIN
    t := pg_temp.q_as('anon', NULL, 'SELECT public.track_referral_click(''8C61OKGF'',''gh2479-quotes-proof'',NULL,NULL,NULL)::text');
    IF t ~ '^[0-9a-f-]{36}$' THEN
      rnew := t::uuid;
      v := v || E'\nINFO REF-a click ' || format('referral %s is_test=%s agent=%s recruited_by_id=%s', left(rnew::text,8), (SELECT is_test FROM referrals WHERE id = rnew), (SELECT left(referral_agent_id::text,8) FROM referrals WHERE id = rnew), (SELECT COALESCE(left(recruited_by_id::text,8),'none') FROM referral_agents WHERE unique_code = '8C61OKGF'));
      g := pg_temp.try_su(format('UPDATE auth.users SET created_at = now() + interval ''1 minute'' WHERE id = %L', o)); -- fixture: account created after the click (auth.users has no UPDATE trigger)
      IF g NOT LIKE 'rows=1%' THEN v := v || E'\nFAIL REF-a fixture: could not move auth.users.created_at: ' || g; END IF;
      v := v || E'\nINFO REF-a OWNER INSERT claim c4 with that referral (account created after the click): ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.claims (id,user_id,is_test,referral_id) VALUES (%L,%L,true,%L)', c4, o, rnew));
      v := v || pg_temp.mk('REF-a1', 'the referral survives the INSERT (credit locks to the owner: referral_id kept, homeowner lock set)', (SELECT format('claim.referral_id=rnew:%s referral.homeowner_user_id=owner:%s', referral_id = rnew, (SELECT homeowner_user_id = o FROM referrals WHERE id = rnew)) FROM claims WHERE id = c4), '^claim\.referral_id=rnew:t(rue)? referral\.homeowner_user_id=owner:t(rue)?$', 'D-402 item 3; claims_apply_locked_referral CREATION-CHECK (gh-3219): click created_at <= auth.users.created_at');
      UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = k2, selected_bid_amount = 15000 WHERE id = c4; -- fixture (superuser)
      UPDATE public.quotes SET claim_id = c4, contractor_id = k2, status = 'selected', bid_status = 'active', total_price = 15000 WHERE id = q2; -- fixture: the selected quote of the claim's selected contractor
      nq1 := pg_temp.qn();
      v := v || E'\nINFO REF-a service_role completion of c4: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', c4));
      nq2 := pg_temp.qn();
      v := v || pg_temp.mk('REF-a2', 'commission IS owed: 200.00 and one payout_approvals row of 200', pg_temp.acc(rnew), 'commission=200\.00 \| payout_approvals rows=1 sum=200(\.00)? ', 'apply_referral_commission (gh-3321, 20261110182332): referrer re_agent, v4 gate not applicable, property_state not excluded, selected quote >= 10000, claim and referral and referrer all is_test; D-402 items 2-3');
      v := v || E'\nINFO NETQ-commission net.http_request_queue rows before / inside the commission savepoint: ' || nq1 || ' / ' || nq2 || ' (apply_referral_commission queues notify-payout-pending and send-partner-status-email; discarded with this savepoint)';
    ELSE
      v := v || E'\nFAIL REF-a click returned ' || t;
    END IF;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;
  v := v || E'\nINFO NETQ-after-commission-savepoint net.http_request_queue rows=' || pg_temp.qn() || ' (equals the start count: the queued rows were discarded with the savepoint)';

  -- CONTROL: the click comes AFTER account creation (the account keeps its real created_at, months before the click) -> credit never locks, commission null.
  BEGIN
    t := pg_temp.q_as('anon', NULL, 'SELECT public.track_referral_click(''8C61OKGF'',''gh2479-quotes-proof'',NULL,NULL,NULL)::text');
    IF t ~ '^[0-9a-f-]{36}$' THEN
      rnew := t::uuid;
      v := v || E'\nINFO REF-b OWNER INSERT claim c5 with a referral clicked after the account existed: ' || pg_temp.try_as('authenticated', o, format('INSERT INTO public.claims (id,user_id,is_test,referral_id) VALUES (%L,%L,true,%L)', c5, o, rnew));
      v := v || pg_temp.mk('REF-b1', 'the referral is cleared at INSERT (claim.referral_id NULL)', (SELECT COALESCE(referral_id::text, 'NULL') FROM claims WHERE id = c5), '^NULL$', 'claims_apply_locked_referral CREATION-CHECK (gh-3219): n.created_at <= auth.users.created_at fails; D-402 item 3');
      UPDATE public.claims SET status = 'contract_signed', selected_contractor_id = k2, selected_bid_amount = 15000 WHERE id = c5; -- fixture (superuser)
      UPDATE public.quotes SET claim_id = c5, contractor_id = k2, status = 'selected', bid_status = 'active', total_price = 15000 WHERE id = q2;
      v := v || E'\nINFO REF-b service_role completion of c5: ' || pg_temp.try_as('service_role', NULL, format('UPDATE public.claims SET completion_date=now() WHERE id=%L', c5));
      v := v || pg_temp.mk('REF-b2', 'no commission, no payout row (control)', pg_temp.acc(rnew), 'commission=null \| payout_approvals rows=0 ', 'apply_referral_commission returns at NEW.referral_id IS NULL; D-402 item 3 "a later partner click does not move it"');
    ELSE
      v := v || E'\nFAIL REF-b click returned ' || t;
    END IF;
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= A: referral_agents.agent_type =======================
  BEGIN
    UPDATE public.referral_agents SET agent_type = 'home_inspector' WHERE id = insp_agent; -- fixture: A1 only tests the guard when the row starts as home_inspector
    v := v || pg_temp.mk('A1', 'home_inspector PARTNER UPDATE own agent_type=re_agent', pg_temp.try_as('authenticated', insp_user, format('UPDATE public.referral_agents SET agent_type=''re_agent'' WHERE id=%L', insp_agent)), '^REJECTED 42501 referral_agents: agent_type can only be changed by service_role or an admin', 'gh-2479 referral_agents_guard_agent_type');
    v := v || pg_temp.mk('A1s', 'agent_type unchanged', (SELECT agent_type FROM referral_agents WHERE id = insp_agent), '^home_inspector$', 'rejection leaves the row as it was');
    v := v || pg_temp.mk('A2', 'LEGIT PARTNER profile save (name, phone, bio; agent_type re-sent unchanged)', pg_temp.try_as('authenticated', insp_user, format('UPDATE public.referral_agents SET first_name=first_name, phone=''3175550100'', bio=''gh2479 proof'', agent_type=agent_type WHERE user_id=%L', insp_user)), '^rows=1 ACCEPTED$', 'the guard fires only when agent_type changes');
    v := v || pg_temp.mk('A3', 'LEGIT ADMIN UPDATE agent_type (admin-referrals setAgentType)', pg_temp.try_as('authenticated', o, format('UPDATE public.referral_agents SET agent_type=''other'' WHERE id=%L', insp_agent), 'dustin@otterquote.com'), '^rows=1 ACCEPTED$', 'is_admin_email() (admin_emails allowlist)');
    v := v || pg_temp.mk('A4', 'LEGIT service_role UPDATE agent_type', pg_temp.try_as('service_role', NULL, format('UPDATE public.referral_agents SET agent_type=''home_inspector'' WHERE id=%L', insp_agent)), '^rows=1 ACCEPTED$', 'auth.role() = service_role');
    RAISE EXCEPTION 'undo' USING ERRCODE = 'P0U01';
  EXCEPTION WHEN SQLSTATE 'P0U01' THEN NULL;
  END;

  -- ======================= ESCAPES: what a rollback does not undo =======================
  seq1 := pg_temp.seqsnap();
  v := v || E'\nINFO SEQ sequences advanced by this batch (never rolled back): ' || COALESCE((SELECT string_agg(k || ' ' || (seq0 ->> k) || ' -> ' || (seq1 ->> k), '; ' ORDER BY k) FROM jsonb_object_keys(seq1) k WHERE (seq1 ->> k) IS DISTINCT FROM (seq0 ->> k)), 'none');
  nq3 := pg_temp.qn();
  v := v || pg_temp.mk('NETQ', 'net.http_request_queue row count after every savepoint equals the start (nothing queued survives to be sent)', nq3 || ' vs ' || nq0, '^(.+) vs \1$|^n/a', 'pg_net queues inside the caller''s transaction; rolled back rows are never read by the worker');
  v := v || E'\nINFO FINGERPRINT-start-compare run the FINGERPRINT query in the header before and after the batch; the two values must be equal (this batch changes nothing that commits).';
  v := v || E'\nSUMMARY ' || format('PASS=%s FAIL=%s INFO=%s', regexp_count(v, E'\nPASS '), regexp_count(v, E'\nFAIL '), regexp_count(v, E'\nINFO '));
  RETURN v;
END $s$;

DO $proof$
BEGIN
  RAISE EXCEPTION E'GH2479_QUOTES_FORCED_ROLLBACK%', pg_temp.gh2479_quotes_scenario();
END
$proof$;
