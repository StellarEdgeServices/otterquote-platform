// gh-3880 LOCAL proof (PGlite, a throwaway in-process Postgres; NOT production). Run: npm i --no-save @electric-sql/pglite && node supabase/tests/gh3880_notify_homeowner_bid_updated_proof_local.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const repo = new URL('../migrations_drafts/', import.meta.url).pathname;
const fwd = fs.readFileSync(process.env.GH3880_FWD || (repo + 'gh3880_notify_homeowner_bid_updated.sql'), 'utf8'); // GH3880_FWD: path of an older forward file, for the negative control
const rb = fs.readFileSync(repo + 'gh3880_notify_homeowner_bid_updated_rollback.sql', 'utf8');
const db = new PGlite();
const say = (s) => console.log(s);
await db.exec(`
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true)::json->>'role',''),'anon') $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
-- minimum stubs of the parent tables (only the columns the function reads)
CREATE TABLE public.claims (id uuid PRIMARY KEY, user_id uuid, status text DEFAULT 'bidding', contract_signed_at timestamptz, selected_contractor_id uuid);
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid, company_name text);
CREATE TABLE public.quotes (id uuid PRIMARY KEY, claim_id uuid REFERENCES claims(id), contractor_id uuid REFERENCES contractors(id), status text, bid_status text, expires_at timestamptz, updated_at timestamptz DEFAULT now());
CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$; -- production set_updated_at_quotes trigger
CREATE TRIGGER set_updated_at_quotes BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TABLE public.referral_agents (id uuid PRIMARY KEY);
-- notifications: production columns (information_schema read 2026-11-23)
CREATE TABLE public.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, claim_id uuid REFERENCES claims(id),
 channel text NOT NULL, notification_type text NOT NULL, recipient text NOT NULL, message_preview text,
 sent_at timestamptz DEFAULT now(), delivered boolean, twilio_sid text, mailgun_id text, created_at timestamptz DEFAULT now(),
 read_at timestamptz, referral_agent_id uuid REFERENCES referral_agents(id) ON DELETE SET NULL);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
-- the four production policies (pg_policy read 2026-11-23)
CREATE POLICY "Authenticated can insert notifications" ON public.notifications FOR INSERT TO public WITH CHECK ((user_id = (SELECT auth.uid())) AND (referral_agent_id IS NULL));
CREATE POLICY "Service role full access to notifications" ON public.notifications FOR ALL TO public USING (auth.role() = 'service_role');
CREATE POLICY "Users can update own notifications" ON public.notifications FOR UPDATE TO public USING (user_id = (SELECT auth.uid())) WITH CHECK ((user_id = (SELECT auth.uid())) AND (referral_agent_id IS NULL));
CREATE POLICY notifications_user_read ON public.notifications FOR SELECT TO public USING (user_id = (SELECT auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;
INSERT INTO claims (id,user_id,status) VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','bidding');
INSERT INTO contractors VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','Acme Roofing'),
                               ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b2','Other Co');
INSERT INTO quotes (id,claim_id,contractor_id,status,bid_status,expires_at,updated_at) VALUES ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000d1','submitted','active', NULL, now());
`);
const HO='00000000-0000-0000-0000-0000000000a1', C1='00000000-0000-0000-0000-0000000000b1', C2='00000000-0000-0000-0000-0000000000b2', Q='00000000-0000-0000-0000-0000000000e1', CL='00000000-0000-0000-0000-0000000000c1';
async function as(role, sub, sql) {
  await db.exec(`SET ROLE ${role}; SELECT set_config('request.jwt.claims', '${sub ? JSON.stringify({sub, role}) : JSON.stringify({role})}', false);`);
  try { return await db.query(sql); } catch (e) { return { err: e.code + ' ' + e.message }; } finally { await db.exec('RESET ROLE'); }
}
const cnt = async () => (await db.query(`select count(*)::int n from notifications where user_id='${HO}' and notification_type='bid_updated'`)).rows[0].n;
const ins = `insert into notifications(user_id,claim_id,channel,notification_type,recipient,message_preview) values ('${HO}','${CL}','dashboard','bid_updated','','x')`;
let bad = 0; const expect = (c, m) => { if (!c) { bad++; say('UNEXPECTED: ' + m); } };
say('--- BEFORE forward (today\'s main behaviour) ---');
let r = await as('authenticated', C1, ins); say('contractor direct INSERT for homeowner: ' + (r.err || 'SUCCEEDED')); expect(/^42501/.test(r.err || ''), 'direct insert should be refused');
say('bid_updated rows for homeowner: ' + await cnt());
await db.exec(fwd);
say('--- AFTER forward ---');
r = await as('authenticated', C1, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('owner contractor RPC: ' + JSON.stringify(r.rows || r.err)); expect(r.rows?.[0].ok === true && await cnt() === 1, 'owner delivers one row');
say('message: ' + (await db.query(`select message_preview m, channel, notification_type from notifications where user_id='${HO}'`)).rows.map(x=>JSON.stringify(x)).join());
r = await as('authenticated', C1, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('repeat call, bid not changed: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(r.rows?.[0].ok === false && await cnt() === 1, 'repeat with no change writes nothing');
await db.exec(`delete from notifications`);
r = await as('authenticated', C2, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('contractor who does NOT own the quote: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(r.rows?.[0].ok === false && await cnt() === 0, 'non-owner refused');
r = await as('authenticated', HO, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('homeowner calling it: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(await cnt() === 0, 'homeowner refused');
r = await as('authenticated', null, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('signed-in role without uid: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(await cnt() === 0, 'no uid refused');
r = await as('anon', null, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('anon: ' + (r.err || JSON.stringify(r.rows))); expect(/^42501/.test(r.err || ''), 'anon refused');
r = await as('authenticated', C1, ins); say('contractor direct INSERT still: ' + (r.err || 'SUCCEEDED (BAD)')); expect(/^42501/.test(r.err || ''), 'policy not loosened');
// ---- gate refusals (each must write no row; the old 10-minute-dedupe SQL writes a row in every one of these) ----
const reset = async () => { await db.exec(`delete from notifications; update claims set status='bidding', contract_signed_at=null, selected_contractor_id=null; update quotes set status='submitted', bid_status='active', expires_at=null`); };
const refuse = async (label, setup) => { await reset(); await db.exec(setup); const r = await as('authenticated', C1, `select public.notify_homeowner_bid_updated('${Q}') ok`); say(label + ': ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(r.rows?.[0].ok === false && await cnt() === 0, label + ' refused'); };
await refuse('withdrawn (bid_status cancelled)', `update quotes set bid_status='cancelled'`);
await refuse('declined quote', `update quotes set status='declined'`);
await refuse('superseded quote', `update quotes set status='declined', bid_status='superseded'`);
await refuse('selected quote', `update quotes set status='selected'`);
await refuse('expired bid_status', `update quotes set bid_status='expired'`);
await refuse('expires_at in the past', `update quotes set expires_at = now() - interval '1 hour'`);
await refuse('claim contract_signed (status)', `update claims set status='contract_signed'`);
await refuse('claim awarded (status)', `update claims set status='awarded'`);
await refuse('claim past bidding (contract_signed_at set)', `update claims set contract_signed_at = now()`);
await refuse('claim with a selected contractor', `update claims set selected_contractor_id='${'00000000-0000-0000-0000-0000000000d2'}'`);
await refuse('claim not yet open for bids (documents_needed)', `update claims set status='documents_needed'`);
// ---- repeat bound ----
await reset();
const call = async () => (await as('authenticated', C1, `select public.notify_homeowner_bid_updated('${Q}') ok`)).rows?.[0].ok;
await db.exec(`update quotes set bid_status='active'`); // a real save: set_updated_at moves updated_at
let ok1 = await call(); say('renewal 1 (bid saved, nothing unread): ' + ok1 + ', rows: ' + await cnt()); expect(ok1 === true && await cnt() === 1, 'renewal 1 writes');
await db.exec(`update quotes set bid_status='active'`);
let ok2 = await call(); say('renewal 2 while renewal 1 is still unread: ' + ok2 + ', rows: ' + await cnt()); expect(ok2 === false && await cnt() === 1, 'second renewal while unread adds no row (banner count stays 1)');
let n = 0; for (let i = 0; i < 25; i++) { await db.exec(`update quotes set bid_status='active'`); if (await call()) n++; }
say('25 more saves + calls while unread: new rows ' + n + ', total rows: ' + await cnt()); expect(n === 0 && await cnt() === 1, 'no stacking');
// another contractor's bid on the same claim still counts as its own row (banner = contractors)
await db.exec(`insert into quotes (id,claim_id,contractor_id,status,bid_status,expires_at,updated_at) values ('00000000-0000-0000-0000-0000000000e2','${CL}','00000000-0000-0000-0000-0000000000d2','submitted','active',null,now())`);
let r2 = await as('authenticated', C2, `select public.notify_homeowner_bid_updated('00000000-0000-0000-0000-0000000000e2') ok`); say('second contractor, own quote: ' + JSON.stringify(r2.rows || r2.err) + ', rows: ' + await cnt()); expect(r2.rows?.[0].ok === true && await cnt() === 2, 'distinct contractor gets its own row');
// after the homeowner reads (dismisses) the notice: saves made while it sat unread are still unannounced, so the next call notifies once;
// then, with the notice read and no further save, rule 4 (bid not changed since the last notice) refuses
await db.exec(`update notifications set read_at = now()`);
let ok3 = await call(); say('after read, saves made since the last notice: ' + ok3 + ', rows: ' + await cnt()); expect(ok3 === true && await cnt() === 3, 'unannounced change notifies after read');
await db.exec(`update notifications set read_at = now()`);
let ok4 = await call(); say('after read again, bid NOT changed since the last notice (rule 4 alone): ' + ok4 + ', rows: ' + await cnt()); expect(ok4 === false && await cnt() === 3, 'read notice + no change writes nothing');
await db.exec(`update quotes set bid_status='active' where id='${Q}'`);
let ok5 = await call(); say('after read, bid changed again: ' + ok5 + ', rows: ' + await cnt()); expect(ok5 === true && await cnt() === 4, 'changed again after read notifies');
say('unread rows per quote (banner basis): ' + JSON.stringify((await db.query(`select recipient, count(*)::int n from notifications where read_at is null group by 1`)).rows));
const proacl = (await db.query(`select p.proacl::text a, p.proconfig::text c, p.prosecdef d from pg_proc p where proname='notify_homeowner_bid_updated'`)).rows[0]; say('proacl/config: ' + JSON.stringify(proacl));  expect(!/(^|[{,])=X/.test(proacl.a) && !/anon=/.test(proacl.a) && /authenticated=X/.test(proacl.a), 'EXECUTE only to authenticated (no PUBLIC, no anon)'); expect(proacl.d === true && /search_path/.test(proacl.c), 'secdef + search_path');
say('--- ROLLBACK half ---');
await db.exec(rb);
const f = (await db.query(`select to_regprocedure('public.notify_homeowner_bid_updated(uuid)')::text f`)).rows[0].f;
say('function after rollback: ' + JSON.stringify(f)); expect(f === null, 'function gone');
process.exit(bad ? 1 : 0);
