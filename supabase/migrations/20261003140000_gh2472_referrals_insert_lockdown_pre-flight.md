# Pre-flight: 20261003140000_gh2472_referrals_insert_lockdown (Tier 3B)

NOT APPLIED. Refs #2472 (sideways finding from the #2345 close-review). Protective only (R-134). Tier 3B because it drops an RLS policy and revokes a table grant: R-097 notice applies.

## What it does
- `DROP POLICY IF EXISTS "Public can insert referral clicks" ON public.referrals` (was `FOR INSERT TO public WITH CHECK (true)`).
- `REVOKE INSERT ON TABLE public.referrals FROM PUBLIC, anon, authenticated`.
- Leaves `"Service role full access"` (`FOR ALL TO public USING/WITH CHECK (auth.role() = 'service_role')`, i.e. service-role only, not a hole) and `"Agents can read own referrals"` (SELECT) untouched. SELECT/UPDATE/DELETE grants are untouched (no UPDATE/DELETE policy exists for client roles since v110, so RLS already denies those).

## Why option (b), not a pinned WITH CHECK
No browser path inserts into `referrals` directly any more:

| Path | Operation on `referrals` | Role | Columns written |
|---|---|---|---|
| `public.track_referral_click(text,text,text,text,text)` (v95, gh1302) | INSERT, `status='clicked'` only; 10 s dedupe | SECURITY DEFINER (owner: migration role, `postgres`, which owns the table); EXECUTE granted to anon, authenticated | referral_agent_id (resolved server-side from an active agent's code), status, landing_page, utm_source/medium/campaign, is_test (inherited from agent) |
| `ref.html`, `ref-re.html`, `ref-inspector.html`, `ref-insurance.html` | `sb.rpc('track_referral_click')` (ref-re/ref-inspector comments confirm the old direct `.insert()` was removed in #595) | anon or authenticated | via the RPC above |
| `refer-a-friend.html` ~L1276, `react-app/app/refer/page.tsx` ~L182 | SELECT `*` by referral_agent_id | authenticated | none |
| `partner-dashboard.html` ~L2254/2301/2363, `react-app/app/partner/dashboard/page.tsx` ~L113/147 | SELECT | authenticated | none |
| Edge Functions approve-payout, get-payout-completion-status, get-business-lines-dashboard | SELECT | service role | none |
| Edge Functions mark-job-complete, mark-payout-paid, send-partner-status-email | UPDATE (status / commission_paid_at / metadata) | service role | n/a, no INSERT |
| `advance_referral_registered`, `claims_advance_referral`, `apply_referral_commission` | UPDATE only | SECURITY DEFINER | n/a, no INSERT |

The only INSERT in the repo (`git grep`, all `.sql`, `.html`, `.js`, `.ts`, `.tsx`) is inside `track_referral_click`. Repo caveat: about 104 applied production migrations have no repo file (#385/#1438), so step 1 below re-reads the live state before applying.

## Danger-pattern check
- RLS policy DROP + table REVOKE: the intended change. No column, type, index, data or function change. `DROP POLICY IF EXISTS` and REVOKE are idempotent (applied twice in the scratch run).
- Risk: if the definer of `track_referral_click` were a role that neither owns `public.referrals` nor has BYPASSRLS, or if the table had FORCE ROW LEVEL SECURITY, the RPC's INSERT would start failing and its `EXCEPTION WHEN OTHERS -> RETURN NULL` would hide it (click tracking silently stops). Step 1 rules this out before applying.

## 1. Before applying (read-only)
```sql
SELECT pg_get_userbyid(p.proowner)  AS fn_owner,
       p.prosecdef                  AS security_definer,
       pg_get_userbyid(c.relowner)  AS table_owner,
       c.relforcerowsecurity        AS force_rls,
       o.rolbypassrls               AS fn_owner_bypassrls
  FROM pg_proc p
  JOIN pg_roles o ON o.oid = p.proowner
 CROSS JOIN pg_class c
 WHERE p.oid = 'public.track_referral_click(text,text,text,text,text)'::regprocedure
   AND c.oid = 'public.referrals'::regclass;
-- Proceed only if security_definer = true, force_rls = false, and
-- (fn_owner = table_owner OR fn_owner_bypassrls = true). Expected: postgres / true / postgres / false.

SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'referrals' ORDER BY policyname;
-- Expected: "Agents can read own referrals" SELECT; "Public can insert referral clicks" INSERT with_check true;
-- "Service role full access" ALL with qual/with_check (auth.role() = 'service_role'). Anything else: stop and re-read.
```

## 2. Negative control: paste BEFORE applying (closes-on)
Run the "closes-on proof" block below once before the migration. Expected result is an ERROR line (the block always raises, which rolls everything back) reading:
`... authenticated INSERT status=registered: ACCEPTED | anon INSERT status=registered: ACCEPTED | anon track_referral_click: id=<uuid> status=clicked`

## 3. Apply
`supabase/migrations/20261003140000_gh2472_referrals_insert_lockdown.sql`.

## 4. After applying: paste the same block again (closes-on)
Expected:
`... authenticated INSERT status=registered: REJECTED 42501 permission denied for table referrals | anon INSERT status=registered: REJECTED 42501 permission denied for table referrals | anon track_referral_click: id=<uuid> status=clicked`

If the RPC line reads `id=NULL`, the click path is broken (or the rate limiter refused this caller): roll back immediately, then investigate.

### Closes-on proof block (single paste; works in the SQL editor; nothing survives)
`set_config('role', x, true)` is `SET LOCAL ROLE x`; the final RAISE rolls back the whole block, including the test rows and the rate-limit counter write.
```sql
DO $proof$
DECLARE
  v_agent  uuid;
  v_code   text;
  v_role   text;
  v_id     uuid;
  v_status text;
  v_out    text := '';
BEGIN
  SELECT id, unique_code INTO v_agent, v_code
    FROM public.referral_agents
   WHERE is_test AND status = 'active'
   ORDER BY id LIMIT 1;
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'gh2472 proof: no active is_test referral agent to use';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    PERFORM set_config('request.jwt.claims',
      CASE v_role WHEN 'authenticated'
        THEN json_build_object('role', 'authenticated', 'sub', gen_random_uuid())::text
        ELSE '{"role":"anon"}' END, true);
    PERFORM set_config('role', v_role, true);           -- SET LOCAL ROLE
    BEGIN
      INSERT INTO public.referrals (referral_agent_id, status, is_test)
      VALUES (v_agent, 'registered', true);
      v_out := v_out || format(' | %s INSERT status=registered: ACCEPTED', v_role);
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || format(' | %s INSERT status=registered: REJECTED %s %s', v_role, SQLSTATE, SQLERRM);
    END;
    PERFORM set_config('role', 'none', true);           -- RESET ROLE
  END LOOP;

  -- legitimate click path, as anon (what ref.html / ref-*.html call)
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  PERFORM set_config('role', 'anon', true);
  v_id := public.track_referral_click(v_code, 'https://otterquote.com/gh2472-proof', NULL, NULL, NULL);
  PERFORM set_config('role', 'none', true);
  SELECT status INTO v_status FROM public.referrals WHERE id = v_id;
  v_out := v_out || format(' | anon track_referral_click: id=%s status=%s',
                           coalesce(v_id::text, 'NULL'), coalesce(v_status, '-'));

  RAISE EXCEPTION 'gh2472 proof (everything rolled back): %', v_out;
END
$proof$;
```

Equivalent psql form, one transaction per role (use instead of the block if preferred; `:agent` is an active is_test agent id):
```sql
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000001"}';
INSERT INTO public.referrals (referral_agent_id, status, is_test) VALUES (:'agent', 'registered', true);
-- after the fix: ERROR: permission denied for table referrals (42501). Before: INSERT 0 1.
ROLLBACK;

BEGIN;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
INSERT INTO public.referrals (referral_agent_id, status, is_test) VALUES (:'agent', 'registered', true);
ROLLBACK;
```

## 5. Blast radius (read-only, for Marty to paste on #2472 before the fix)
"First recorded status" cannot be read exactly: `referrals` has no status history table, no `updated_at`, and no audit trigger, so a row inserted at `registered` looks the same as a click later advanced to `registered`. Three proxies, strongest last:

```sql
-- (a) Non-clicked rows with no trace of a legitimate advance. claim_submitted and later are reached only via
--     claims_advance_referral, which needs a claims row whose referral_id = the referral; registered via
--     advance_referral_registered, which stamps homeowner_email from the caller's JWT.
SELECT r.is_test,
       r.status,
       count(*) AS rows_total,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.referral_id = r.id)
                          AND r.claim_id IS NULL)                              AS no_linked_claim,
       count(*) FILTER (WHERE r.status = 'registered' AND r.homeowner_email IS NULL) AS registered_without_email,
       count(*) FILTER (WHERE r.landing_page IS NULL)                         AS no_landing_page
  FROM public.referrals r
 WHERE r.status <> 'clicked'
 GROUP BY r.is_test, r.status
 ORDER BY r.is_test, r.status;

-- (b) Agent counter cross-check. referral_agents.total_referrals is incremented only by the AFTER UPDATE
--     trigger referrals_update_stats when a row LEAVES 'clicked'; a row inserted already past 'clicked'
--     never increments it. A positive gap = rows that (probably) never were 'clicked'. Inexact if the counter
--     was ever edited by hand or rows were deleted.
SELECT ra.is_test,
       count(*)                                     AS agents_with_gap,
       sum(x.non_clicked - coalesce(ra.total_referrals, 0)) AS rows_unaccounted
  FROM public.referral_agents ra
  JOIN (SELECT referral_agent_id, count(*) FILTER (WHERE status <> 'clicked') AS non_clicked
          FROM public.referrals GROUP BY referral_agent_id) x
    ON x.referral_agent_id = ra.id
 WHERE x.non_clicked > coalesce(ra.total_referrals, 0)
 GROUP BY ra.is_test;
```
(c) The only exact source is the API gateway log, within its retention window: any `POST /rest/v1/referrals` request is a direct client insert (the legitimate path is `POST /rest/v1/rpc/track_referral_click`). In the Supabase Logs Explorer: `select timestamp, event_message from edge_logs where regexp_contains(event_message, 'POST.*/rest/v1/referrals') order by timestamp desc limit 100`. Older inserts are not recoverable exactly.

## Rollback
`supabase/migrations_rollbacks/20261003140000_gh2472_referrals_insert_lockdown_rollback.sql` restores the policy (`WITH CHECK (true)`) and the anon/authenticated INSERT grant, which re-opens #2472. Use it only if a client insert path that depends on the grant turns up.

## Verification (author)
Local Postgres 16 scratch harness only: Supabase-like roles (anon, authenticated, service_role with BYPASSRLS), table and function owned by a non-superuser role without BYPASSRLS, the baseline `referrals` table, live policies, and `track_referral_click` copied verbatim from gh1302. Before: authenticated and anon inserts at `registered` succeed. After (applied twice): both fail with 42501 `permission denied for table referrals`, anon `clicked` direct insert fails too, the RPC as anon and as authenticated still returns an id with a `clicked` row, service_role insert still succeeds, `has_table_privilege(anon|authenticated, INSERT)` = false. Rollback restores the pre-fix behaviour; re-apply closes it again. The proof block above was run in both states on the harness. Not run against a Supabase branch or production.
