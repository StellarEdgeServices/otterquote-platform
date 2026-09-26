-- gh-2121 HO-3 proof script (PR #2226 REVIEW D1, D2, D3, D12, D13, D15).
--
-- Asserts the security properties of migration
-- 20260926190000_gh2121_ho3_lead_measurement_noauth.sql at the SQL level --
-- the layer the Edge Function unit tests (which mock the RPCs) cannot reach.
-- Every assertion RAISEs on failure, so the script either finishes with
-- "HO-3 PROOF: ALL ASSERTIONS PASSED" or stops at the first broken property.
--
-- HOW TO RUN
--  A. Deploy gate, step 2 of the go-live order, right AFTER the migration is
--     applied to production (yeszghaspzwwstvsrioa). Run the WHOLE file as one
--     batch; it opens its own BEGIN and ends with ROLLBACK, so the synthetic
--     lead and tokens it creates never persist. Never change that to COMMIT.
--  B. Locally, against a throwaway PostgreSQL 16 cluster (what the PR author
--     ran; see the PR comment for the output):
--       initdb -D /var/tmp/pg -A trust -U postgres
--       pg_ctl -D /var/tmp/pg -o '-p 55433 -k /var/tmp/pg' start
--       export PGHOST=/var/tmp/pg PGPORT=55433 PGUSER=postgres
--       psql -v ON_ERROR_STOP=1 -f supabase/tests/gh2121_ho3_local_stub.sql
--       psql -v ON_ERROR_STOP=1 -f supabase/migrations/20260926190000_gh2121_ho3_lead_measurement_noauth.sql
--       psql -v ON_ERROR_STOP=1 -f supabase/tests/gh2121_ho3_lead_token_proof.sql
--
-- NEGATIVE CONTROL: running this file BEFORE the migration (or against the
-- first-draft migration at fb57e7f) fails -- at fb57e7f on assertion P1
-- (relrowsecurity false on lead_measurement_orders) and, if P1 is skipped, at
-- P5 (gen_random_bytes does not resolve under search_path=public).

\set ON_ERROR_STOP on
begin;

-- P1 (D1): RLS on all three new tables.
do $$
declare t text;
begin
  foreach t in array array['lead_access_tokens', 'lead_measurement_orders', 'lead_loss_sheet_uploads'] loop
    if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname = t) then
      raise exception 'P1 FAIL: RLS is not enabled on public.%', t;
    end if;
  end loop;
  raise notice 'P1 PASS: relrowsecurity = true on all three HO-3 tables';
end $$;

-- P2 (D1/D12): anon and authenticated hold NO privilege on the new tables;
-- service_role holds the ones the Edge Functions use.
do $$
declare t text; r text; p text;
begin
  foreach t in array array['public.lead_access_tokens', 'public.lead_measurement_orders', 'public.lead_loss_sheet_uploads'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, t, p) then
          raise exception 'P2 FAIL: % has % on %', r, p, t;
        end if;
      end loop;
    end loop;
    if not has_table_privilege('service_role', t, 'SELECT') or not has_table_privilege('service_role', t, 'INSERT') then
      raise exception 'P2 FAIL: service_role lacks SELECT/INSERT on %', t;
    end if;
  end loop;
  raise notice 'P2 PASS: anon/authenticated have no privileges; service_role has SELECT+INSERT';
end $$;

-- P3: the two RPCs are service_role-only.
do $$
begin
  if has_function_privilege('anon', 'public.issue_lead_access_token(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.issue_lead_access_token(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.resolve_lead_by_token(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.resolve_lead_by_token(text)', 'EXECUTE') then
    raise exception 'P3 FAIL: anon/authenticated can execute a HO-3 token RPC';
  end if;
  if not has_function_privilege('service_role', 'public.issue_lead_access_token(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.resolve_lead_by_token(text)', 'EXECUTE') then
    raise exception 'P3 FAIL: service_role cannot execute a HO-3 token RPC';
  end if;
  raise notice 'P3 PASS: token RPCs are service_role-only';
end $$;

-- P4 (D12): acting AS anon, the table is unreadable and a planted token cannot
-- be inserted (this is the attack the reviewer described against the first
-- draft's leads.access_token column).
do $$
declare v_lead uuid;
begin
  insert into public.leads (email, name, is_synthetic)
  values ('ho3-proof-p4@otterquote-internal.test', 'HO3 proof P4', true)
  returning id into v_lead;

  set local role anon;
  begin
    insert into public.lead_access_tokens (token_sha256, lead_id, expires_at)
    values (repeat('a', 64), v_lead, 'infinity');
    reset role;
    raise exception 'P4 FAIL: anon inserted its own token row';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform 1 from public.lead_measurement_orders limit 1;
    reset role;
    raise exception 'P4 FAIL: anon can read lead_measurement_orders';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.lead_measurement_orders (lead_id, stripe_payment_intent_id, homeowner_charge_amount)
    values (v_lead, 'pi_forged', 1500);
    reset role;
    raise exception 'P4 FAIL: anon forged a paid order';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  raise notice 'P4 PASS: anon cannot plant a token, read orders, or forge an order';
end $$;

-- P5 (D2, D12): a fresh lead gets exactly one 192-bit URL-safe token; only its
-- sha256 is stored; resolve_lead_by_token finds the lead by it.
do $$
declare v_lead uuid; v_token text; v_exp timestamptz; v_rows int; v_resolved uuid; v_syn boolean;
begin
  insert into public.leads (email, name, is_synthetic)
  values ('ho3-proof-p5@otterquote-internal.test', 'HO3 proof P5', true)
  returning id into v_lead;

  select count(*) into v_rows from public.issue_lead_access_token(v_lead);
  if v_rows <> 1 then raise exception 'P5 FAIL: fresh lead got % rows, expected 1', v_rows; end if;

  select token, expires_at into v_token, v_exp from public.issue_lead_access_token(v_lead);
  if v_token !~ '^[A-Za-z0-9_-]{32}$' then raise exception 'P5 FAIL: token is not 32 URL-safe chars: %', length(v_token); end if;
  if v_exp < now() + interval '29 days' or v_exp > now() + interval '31 days' then raise exception 'P5 FAIL: expiry not ~30 days'; end if;

  if exists (select 1 from public.lead_access_tokens where token_sha256 = v_token) then
    raise exception 'P5 FAIL: plaintext token stored';
  end if;
  if not exists (select 1 from public.lead_access_tokens
                 where lead_id = v_lead and token_sha256 = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')) then
    raise exception 'P5 FAIL: sha256(token) not stored';
  end if;

  select lead_id, is_synthetic into v_resolved, v_syn from public.resolve_lead_by_token(v_token);
  if v_resolved is distinct from v_lead then raise exception 'P5 FAIL: token did not resolve to its lead'; end if;
  if v_syn is distinct from true then raise exception 'P5 FAIL: is_synthetic not carried through'; end if;

  -- Negative controls: a wrong token, a hash-as-token, a short string, NULL.
  if exists (select 1 from public.resolve_lead_by_token(v_token || 'x')) then raise exception 'P5 FAIL: wrong token resolved'; end if;
  if exists (select 1 from public.resolve_lead_by_token(encode(sha256(convert_to(v_token, 'UTF8')), 'hex'))) then
    raise exception 'P5 FAIL: the stored hash itself works as a token';
  end if;
  if exists (select 1 from public.resolve_lead_by_token('short')) then raise exception 'P5 FAIL: short token resolved'; end if;
  if exists (select 1 from public.resolve_lead_by_token(null)) then raise exception 'P5 FAIL: NULL resolved'; end if;
  raise notice 'P5 PASS: fresh lead mints a 32-char token, hash-only storage, resolves; wrong/hash/short/null do not';
end $$;

-- P6 (D3): a lead older than 30 minutes that ALREADY HAS a live token gets
-- nothing -- the freshness check runs before anything else.
do $$
declare v_lead uuid; v_rows int;
begin
  insert into public.leads (email, name, is_synthetic)
  values ('ho3-proof-p6@otterquote-internal.test', 'HO3 proof P6', true)
  returning id into v_lead;
  perform * from public.issue_lead_access_token(v_lead);
  if not exists (select 1 from public.lead_access_tokens where lead_id = v_lead and expires_at > now()) then
    raise exception 'P6 FAIL: setup -- no live token minted';
  end if;
  update public.leads set created_at = now() - interval '31 minutes' where id = v_lead;
  select count(*) into v_rows from public.issue_lead_access_token(v_lead);
  if v_rows <> 0 then raise exception 'P6 FAIL: out-of-window lead with a live token got % row(s)', v_rows; end if;
  select count(*) into v_rows from public.issue_lead_access_token(gen_random_uuid());
  if v_rows <> 0 then raise exception 'P6 FAIL: unknown lead id got a token'; end if;
  raise notice 'P6 PASS: >30-minute-old lead (with a live token) and unknown lead get nothing';
end $$;

-- P7: an expired token no longer resolves.
do $$
declare v_lead uuid; v_token text;
begin
  insert into public.leads (email, name, is_synthetic)
  values ('ho3-proof-p7@otterquote-internal.test', 'HO3 proof P7', true)
  returning id into v_lead;
  select token into v_token from public.issue_lead_access_token(v_lead);
  update public.lead_access_tokens set expires_at = now() - interval '1 second' where lead_id = v_lead;
  if exists (select 1 from public.resolve_lead_by_token(v_token)) then raise exception 'P7 FAIL: expired token resolved'; end if;
  raise notice 'P7 PASS: expired token rejected';
end $$;

-- P8: at most 5 live tokens per lead.
do $$
declare v_lead uuid; i int; v_rows int;
begin
  insert into public.leads (email, name, is_synthetic)
  values ('ho3-proof-p8@otterquote-internal.test', 'HO3 proof P8', true)
  returning id into v_lead;
  for i in 1..5 loop
    select count(*) into v_rows from public.issue_lead_access_token(v_lead);
    if v_rows <> 1 then raise exception 'P8 FAIL: mint % refused early', i; end if;
  end loop;
  select count(*) into v_rows from public.issue_lead_access_token(v_lead);
  if v_rows <> 0 then raise exception 'P8 FAIL: 6th mint was allowed'; end if;
  raise notice 'P8 PASS: 5 mints allowed, 6th refused';
end $$;

-- P9 (D5): stripe_payment_intent_id is unique, so a browser/webhook race can
-- write at most one order per charge; status and upload type/size are
-- constrained (D13 second layer).
do $$
declare v_lead uuid; v_rows int;
begin
  insert into public.leads (email, name, is_synthetic)
  values ('ho3-proof-p9@otterquote-internal.test', 'HO3 proof P9', true)
  returning id into v_lead;
  insert into public.lead_measurement_orders (lead_id, stripe_payment_intent_id, homeowner_charge_amount, is_test, recorded_by)
  values (v_lead, 'pi_ho3_proof_p9', 1500, true, 'webhook')
  on conflict (stripe_payment_intent_id) do nothing;
  insert into public.lead_measurement_orders (lead_id, stripe_payment_intent_id, homeowner_charge_amount, is_test, recorded_by)
  values (v_lead, 'pi_ho3_proof_p9', 1500, true, 'browser')
  on conflict (stripe_payment_intent_id) do nothing;
  select count(*) into v_rows from public.lead_measurement_orders where stripe_payment_intent_id = 'pi_ho3_proof_p9';
  if v_rows <> 1 then raise exception 'P9 FAIL: % rows for one PaymentIntent', v_rows; end if;
  if (select rebate_due from public.lead_measurement_orders where stripe_payment_intent_id = 'pi_ho3_proof_p9') then
    raise exception 'P9 FAIL: rebate_due defaulted to true (L2)';
  end if;
  begin
    insert into public.lead_loss_sheet_uploads (lead_id, storage_path, content_type, byte_size)
    values (v_lead, 'x/y.html', 'text/html', 10);
    raise exception 'P9 FAIL: text/html upload row accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.lead_loss_sheet_uploads (lead_id, storage_path, content_type, byte_size)
    values (v_lead, 'x/y.pdf', 'application/pdf', 6291457);
    raise exception 'P9 FAIL: oversize upload row accepted';
  exception when check_violation then null;
  end;
  raise notice 'P9 PASS: one order per PaymentIntent, rebate_due false, upload type/size constrained';
end $$;

-- P10 (D13): the bucket enforces the same limits.
do $$
begin
  if not exists (select 1 from storage.buckets
                 where id = 'lead-loss-sheets' and public = false and file_size_limit = 6291456
                   and allowed_mime_types @> array['application/pdf', 'image/jpeg', 'image/png', 'image/heic']
                   and array_length(allowed_mime_types, 1) = 4) then
    raise exception 'P10 FAIL: lead-loss-sheets bucket limits missing';
  end if;
  raise notice 'P10 PASS: bucket private, 6 MiB, four MIME types';
end $$;

-- P11: rate-limit rows exist for all four functions.
do $$
begin
  if (select count(*) from public.rate_limit_config where enabled and function_name in
      ('issue-lead-access-token', 'create-lead-payment-intent', 'create-lead-measurement-order', 'record-lead-loss-sheet-upload')) <> 4 then
    raise exception 'P11 FAIL: missing rate_limit_config rows';
  end if;
  raise notice 'P11 PASS: four rate_limit_config rows';
end $$;

select 'HO-3 PROOF: ALL ASSERTIONS PASSED' as result;
rollback;
