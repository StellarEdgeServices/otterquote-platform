// gh-3880 LOCAL proof (PGlite, a throwaway in-process Postgres; NOT production). Run: npm i --no-save @electric-sql/pglite && node supabase/tests/gh3880_notify_homeowner_bid_updated_proof_local.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const repo = new URL('../migrations_drafts/', import.meta.url).pathname;
const fwd = fs.readFileSync(repo + 'gh3880_notify_homeowner_bid_updated.sql', 'utf8');
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
CREATE TABLE public.claims (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid, company_name text);
CREATE TABLE public.quotes (id uuid PRIMARY KEY, claim_id uuid REFERENCES claims(id), contractor_id uuid REFERENCES contractors(id), status text, bid_status text);
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
INSERT INTO claims VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1');
INSERT INTO contractors VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','Acme Roofing'),
                               ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b2','Other Co');
INSERT INTO quotes VALUES ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000d1','submitted','active');
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
r = await as('authenticated', C1, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('repeat within 10 min: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(await cnt() === 1, 'dedupe');
await db.exec(`delete from notifications`);
r = await as('authenticated', C2, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('contractor who does NOT own the quote: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(r.rows?.[0].ok === false && await cnt() === 0, 'non-owner refused');
r = await as('authenticated', HO, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('homeowner calling it: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(await cnt() === 0, 'homeowner refused');
r = await as('authenticated', null, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('signed-in role without uid: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(await cnt() === 0, 'no uid refused');
r = await as('anon', null, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('anon: ' + (r.err || JSON.stringify(r.rows))); expect(/^42501/.test(r.err || ''), 'anon refused');
r = await as('authenticated', C1, ins); say('contractor direct INSERT still: ' + (r.err || 'SUCCEEDED (BAD)')); expect(/^42501/.test(r.err || ''), 'policy not loosened');
await db.exec(`update quotes set bid_status='cancelled'`);
r = await as('authenticated', C1, `select public.notify_homeowner_bid_updated('${Q}') ok`); say('withdrawn (cancelled) quote: ' + JSON.stringify(r.rows || r.err) + ', rows: ' + await cnt()); expect(await cnt() === 0, 'withdrawn refused');
say('--- ROLLBACK half ---');
await db.exec(rb);
const f = (await db.query(`select to_regprocedure('public.notify_homeowner_bid_updated(uuid)')::text f`)).rows[0].f;
say('function after rollback: ' + JSON.stringify(f)); expect(f === null, 'function gone');
process.exit(bad ? 1 : 0);
