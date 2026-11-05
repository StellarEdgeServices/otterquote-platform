// gh-3409: proves the HTML bid form's insert shape against a REAL PostgREST (not a reading of its source) with the real supabase-js the form loads.
// Usage: node gh3409_postgrest_proof.mjs <postgrest-url> <jwt-secret> <seed.json> <texts.psql> <supabase-js dir>
// The runner starts PostgREST on a throwaway database that has the forward file applied. Output: PGRST|case|expected|actual|OK/FAIL, then PGRST_FAILING=n of m.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const [url, secret, seedFile, textsFile, jsDir] = process.argv.slice(2);
const require = createRequire(jsDir + '/package.json');
const { createClient } = require('@supabase/supabase-js');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`; };
// supabase-js addresses /rest/v1/...; Supabase's gateway strips that prefix before PostgREST, so this fetch does the same and changes nothing else (headers and body pass through untouched).
const gatewayFetch = (u, init) => fetch(String(u).replace('/rest/v1/', '/'), init);
const client = (claims) => { const t = jwt(claims); return createClient(url, t, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: gatewayFetch, headers: { Authorization: `Bearer ${t}` } } }); };
const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
const texts = {}; for (const l of fs.readFileSync(textsFile, 'utf8').split('\n')) { const m = /^\\set (\S+) '(.*)'$/.exec(l); if (m) texts[m[1]] = m[2]; }
const A = client({ sub: seed.a.user_id, role: 'authenticated', email: 'a@example.test' });
const ANON = client({ role: 'anon' });
const SVC = client({ role: 'service_role' });
let n = 0, bad = 0;
const rec = (name, expected, actual) => { n++; const ok = expected === actual; if (!ok) bad++; console.log(`PGRST|${name}|expected=${expected}|actual=${actual}|${ok ? 'OK' : 'FAIL'}`); };
const bid = (k) => seed.bids[k];
const row = (k, text, extra = {}) => ({ contractor_id: seed[k[0]].contractor_id, claim_id: bid(k).claim_id, bid_id: bid(k).bid_id, fee_pct: 5, fee_basis: 'bid_amount', fee_amount: 750, fee_text_displayed: text, accepted_at: new Date().toISOString(), ip_address: '203.0.113.7', user_agent: 'proof/1.0', ...extra });
const held = async (k) => { const { data, error } = await SVC.from('fee_acceptance_quarantine').select('id,reasons').eq('bid_id', bid(k).bid_id); if (error) return 'ERR ' + error.message; return String(data.length) + (data.length ? ':' + data.map((d) => d.reasons.join('+')).join(',') : ''); };
const recorded = async (k) => { const { data, error } = await SVC.from('fee_acceptances').select('id').eq('bid_id', bid(k).bid_id); return error ? 'ERR ' + error.message : String(data.length); };
const shape = (r) => (r.error ? `error ${r.error.code || r.error.message}` : `no error, data=${Array.isArray(r.data) ? "array(" + r.data.length + ")" : r.data === null ? "null" : "object"}`);

const good = texts.text_html_q2, goodReact = texts.text_react_q2, wrong = good.replace('$750.00', '$75.00');
// OLD form shape: insert(...).select('id').single()   NEW form shape: insert(...).select('id')   React form shape: insert(...) with no returning clause
// 1. genuine acceptance, old shape and new shape both work
let r = await A.from('fee_acceptances').insert(row('a1', good)).select('id').single();
rec('P1 genuine HTML text, old shape (.single())', 'no error, data=object; recorded=1 held=0', `${shape(r)}; recorded=${await recorded('a1')} held=${await held('a1')}`);
r = await A.from('fee_acceptances').insert(row('a2', good)).select('id');
rec('P2 genuine HTML text, new shape (no .single())', 'no error, data=array(1); recorded=1 held=0', `${shape(r)}; recorded=${await recorded('a2')} held=${await held('a2')}`);
r = await A.from('fee_acceptances').insert(row('a3', goodReact));
rec('P3 genuine React text, no returning clause', 'no error, data=null; recorded=1 held=0', `${shape(r)}; recorded=${await recorded('a3')} held=${await held('a3')}`);
// 2. a mismatching acceptance (the displayed fee is not the bid's): the OLD shape loses the record (the defect the review found), the NEW shape keeps it
r = await A.from('fee_acceptances').insert(row('a4', wrong, { fee_amount: 75 })).select('id').single();
rec('P4 mismatching text, OLD shape (.single()): PostgREST rolls the quarantine row back', 'error PGRST116; recorded=0 held=0', `${shape(r)}; recorded=${await recorded('a4')} held=${await held('a4')}`);
r = await A.from('fee_acceptances').insert(row('a5', wrong, { fee_amount: 75 })).select('id');
rec('P5 mismatching text, NEW shape (no .single()): the record is kept', 'no error, data=array(0); recorded=0 held=1:displayed_fee_differs', `${shape(r)}; recorded=${await recorded('a5')} held=${await held('a5')}`);
r = await A.from('fee_acceptances').insert(row('a6', wrong, { fee_amount: 75 }));
rec('P6 mismatching text, React shape (no returning clause): the record is kept', 'no error, data=null; recorded=0 held=1:displayed_fee_differs', `${shape(r)}; recorded=${await recorded('a6')} held=${await held('a6')}`);
// 3. the held copy is what the browser sent
{ const { data } = await SVC.from('fee_acceptance_quarantine').select('fee_text_displayed,fee_amount,fee_pct,contractor_id,bid_id').eq('bid_id', bid('a5').bid_id).single();
  rec('P7 held copy has the text and fee the browser sent', `${wrong}|75|5|true`, data ? `${data.fee_text_displayed}|${Number(data.fee_amount)}|${Number(data.fee_pct)}|${data.contractor_id === seed.a.contractor_id}` : 'none'); }
// 4. a second acceptance for a bid that already has one is kept, not refused and not recorded
r = await A.from('fee_acceptances').insert(row('a2', good)).select('id');
rec('P8 duplicate acceptance for a bid, new shape', 'no error, data=array(0); recorded=1 held=1:duplicate_bid', `${shape(r)}; recorded=${await recorded('a2')} held=${await held('a2')}`);
// 5. refused: another contractor's bid, and the anon key
r = await A.from('fee_acceptances').insert(row('b1', good, { contractor_id: seed.a.contractor_id })).select('id');
rec('P9 acceptance naming another contractor\'s bid', 'error 42501; recorded=0 held=0', `${shape(r)}; recorded=${await recorded('b1')} held=${await held('b1')}`);
r = await A.from('fee_acceptances').insert(row('b2', good)).select('id');
rec('P10 acceptance naming another contractor as the contractor', 'error 42501; recorded=0 held=0', `${shape(r)}; recorded=${await recorded('b2')} held=${await held('b2')}`);
r = await ANON.from('fee_acceptances').insert(row('a7', good)).select('id');
rec('P11 anon key', 'error 42501; recorded=0 held=0', `${shape(r)}; recorded=${await recorded('a7')} held=${await held('a7')}`);
// 6. the server-side path (stripe-webhook / edge functions use the service role) is not bound by the guard
r = await SVC.from('fee_acceptances').insert(row('a8', 'service role text')).select('id');
rec('P12 service_role insert is not bound', 'no error, data=array(1); recorded=1 held=0', `${shape(r)}; recorded=${await recorded('a8')} held=${await held('a8')}`);
// 7. the clients cannot read the quarantine table
r = await A.from('fee_acceptance_quarantine').select('id');
rec('P13 a signed-in contractor cannot read the quarantine table', 'error 42501', shape(r));
// 8. the quarantine writer is exposed as an RPC route (a SECURITY DEFINER function a trigger needs the caller to be able to run); calling it directly must not write
r = await A.rpc('fee_acceptance_quarantine_add', { p_row: { ...row('a9', 'forged direct call'), id: crypto.randomUUID() }, p_reasons: ['forged'], p_server_pct: 5, p_server_fee: 750 });
rec('P14 a contractor calling the quarantine writer directly over RPC', 'error 42501; held=0', `${shape(r)}; held=${await held('a9')}`);
console.log(`PGRST_FAILING=${bad} of ${n}`);
process.exit(bad ? 1 : 0);
