// CTO RUN 101: proof for supabase/migrations_drafts/cto101_revoke_anon_secdef_nonpublic.sql on a THROWAWAY in-memory Postgres (PGlite). Never production.
// Usage (from repo root): npm i --no-save @electric-sql/pglite@0.2.17 && node supabase/tests/cto101_anon_secdef_revoke_proof_run.mjs
// Models: gh3409_throwaway_schema.sql + the gh-3409 forward file (as production has it per the advisor) + the gh-2421 out-of-state trigger migration (net.http_post and the vault stubbed).
// Phases: BEFORE (negative control: anon holds EXECUTE) -> forward file -> AFTER (anon refused with "permission denied for function"; the client-role trigger paths still work) -> ROLLBACK (anon holds EXECUTE again).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const T = 'supabase/tests', D = 'supabase/migrations_drafts', M = 'supabase/migrations', RB = 'supabase/migrations_rollbacks';
const db = new PGlite();
let fails = 0;
const check = (name, ok, got) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${got === undefined ? '' : '  -> ' + got}`); };
const sqlOf = f => readFileSync(f, 'utf8').replace(/^\\set .*$/mg, '');

await db.exec(sqlOf(`${T}/gh3409_throwaway_schema.sql`));
await db.exec(`
  ALTER TABLE public.claims ADD COLUMN property_state text, ADD COLUMN is_test boolean DEFAULT false, ADD COLUMN user_id uuid;
  GRANT SELECT, UPDATE, INSERT ON public.claims TO authenticated;
  CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
  INSERT INTO vault.decrypted_secrets VALUES ('cron_service_role_key', 'stub');
  CREATE SCHEMA net; CREATE TABLE public.net_calls (at timestamptz DEFAULT now());
  CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.net_calls DEFAULT VALUES RETURNING 1::bigint $$;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
// the text-check function needs real texts only for genuine inserts; this proof drives the DIVERT path (wording not recognised), which is the one that calls fee_acceptance_quarantine_add
await db.exec(sqlOf(`${D}/gh3409_fee_acceptances_client_insert_guard.sql`));
await db.exec(sqlOf(`${M}/20261005154758_gh2421_out_of_state_claim_alert.sql`));
// the out-of-state migration's function was created after the default-privilege line above, so it carries the default anon grant, as production does
const U = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222';
await db.exec(`
  INSERT INTO public.contractors (id, user_id, address_state) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '${U}', 'IN');
  INSERT INTO public.claims (id, user_id) VALUES ('cccccccc-0000-0000-0000-000000000001', '${U2}');
  INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis)
    VALUES ('bbbbbbbb-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 10000, 5.00, 500.00, 5.00, 'bid_amount');`);

const QA = `public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)`, OS = `public.notify_admin_out_of_state_claim()`;
// run sql as a client role inside a transaction that is always rolled back; returns {ok, msg, code, rows}
async function as(role, uid, sql) {
  await db.exec('BEGIN');
  try {
    await db.exec(`SET LOCAL ROLE ${role}; SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role })}', true);`);
    const r = await db.query(sql);
    await db.exec('ROLLBACK'); return { ok: true, rows: r.rows };
  } catch (e) { await db.exec('ROLLBACK'); return { ok: false, msg: e.message, code: e.code }; }
}
const one = async q => (await db.query(q)).rows[0];
const priv = async (role, fn) => (await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS p`)).p;
const CALL = `SELECT ${QA.replace('(public.fee_acceptances,text[],numeric,numeric)', '')}(ROW(gen_random_uuid(),'aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001',5,'bid_amount',500,'x',now(),NULL,NULL,NULL,NULL,NULL,now())::public.fee_acceptances, ARRAY['x'], 5, 500)`;
const FORGED = `INSERT INTO public.fee_acceptances (contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001', 0.01,'bid_amount',0.01,'I owe nothing')`;
const OOS = `UPDATE public.claims SET property_state = 'OH' WHERE id = 'cccccccc-0000-0000-0000-000000000001'`;
const phase = async (label, expectAnon) => {
  console.log(`== ${label}`);
  check(`anon EXECUTE on fee_acceptance_quarantine_add is ${expectAnon}`, (await priv('anon', QA)) === expectAnon);
  check(`anon EXECUTE on notify_admin_out_of_state_claim is ${expectAnon}`, (await priv('anon', OS)) === expectAnon);
  check('authenticated EXECUTE on fee_acceptance_quarantine_add kept', (await priv('authenticated', QA)) === true);
  check('service_role EXECUTE on fee_acceptance_quarantine_add kept', (await priv('service_role', QA)) === true);
  const a = await as('anon', '00000000-0000-0000-0000-000000000000', CALL);
  if (expectAnon) check('anon RPC call reaches the function (then its own trigger-depth guard refuses)', !a.ok && /runs only inside the fee_acceptances guard trigger/.test(a.msg), a.msg);
  else check('anon RPC call is refused at the privilege check', !a.ok && /permission denied for function/.test(a.msg), a.msg);
  const c = await as('authenticated', U, CALL);
  check('authenticated direct call still refused by the trigger-depth guard', !c.ok && /runs only inside the fee_acceptances guard trigger/.test(c.msg), c.msg);
  // trigger path as the contractor (role authenticated): forged wording is diverted into quarantine through fee_acceptance_quarantine_add
  const before = (await one('SELECT count(*)::int AS n FROM public.fee_acceptance_quarantine')).n;
  await db.exec('BEGIN');
  let fa, q, err = null;
  try {
    await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: U, role: 'authenticated' })}', true);`);
    await db.exec(FORGED);
    await db.exec('RESET ROLE');
    fa = (await one('SELECT count(*)::int AS n FROM public.fee_acceptances')).n; q = (await one('SELECT count(*)::int AS n FROM public.fee_acceptance_quarantine')).n;
  } catch (e) { err = e.message; }
  await db.exec('ROLLBACK');
  check('contractor (authenticated) forged insert: trigger path diverts to quarantine, nothing in fee_acceptances', err === null && fa === 0 && q === before + 1, err ?? `fee_acceptances=${fa} quarantine=${q} (was ${before})`);
  const an = await as('anon', '00000000-0000-0000-0000-000000000000', FORGED);
  check('anon forged insert refused by guard rule A (never needs quarantine_add)', !an.ok && /only be recorded by the contractor it names/.test(an.msg), an.msg);
  // out-of-state trigger still fires for the client role
  await db.exec('BEGIN');
  let calls, e2 = null;
  try {
    await db.exec(`SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '${JSON.stringify({ sub: U2, role: 'authenticated' })}', true);`);
    await db.exec(OOS); await db.exec('RESET ROLE');
    calls = (await one('SELECT count(*)::int AS n FROM public.net_calls')).n;
  } catch (e) { e2 = e.message; }
  await db.exec('ROLLBACK');
  check('claims property_state update as authenticated still fires the out-of-state trigger (net.http_post called once)', e2 === null && calls === 1, e2 ?? `net calls=${calls}`);
  const o = await as('anon', '00000000-0000-0000-0000-000000000000', `SELECT ${OS.replace('()', '')}()`);
  check('direct call of the trigger function is impossible for anon', !o.ok, o.msg);
};
await phase('BEFORE (gh-3409 as applied; negative control: anon holds EXECUTE)', true);
await db.exec(sqlOf(`${D}/cto101_revoke_anon_secdef_nonpublic.sql`));
await phase('AFTER forward file', false);
await db.exec(sqlOf(`${D}/cto101_revoke_anon_secdef_nonpublic.sql`)); // idempotent
check('forward file is idempotent', (await priv('anon', QA)) === false);
await db.exec(sqlOf(`${RB}/cto101_revoke_anon_secdef_nonpublic_rollback.sql`));
check('ROLLBACK restores anon EXECUTE on both', (await priv('anon', QA)) === true && (await priv('anon', OS)) === true);
console.log(fails === 0 ? 'ALL PASS' : `FAILURES: ${fails}`);
process.exit(fails ? 1 : 0);
