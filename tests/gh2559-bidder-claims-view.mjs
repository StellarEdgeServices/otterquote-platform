/**
 * gh-2559 / D-368 -- a bidding contractor reads the claim SUMMARY view (public.bidder_claim_summary), never the
 * base claims row. Static checks over the bidder pages, the React app, the view's SQL and the proof file:
 *   1. none of the bidder call sites reads the base claims table (from('claims')) or selects '*' from the view;
 *   2. the column lists the pages select are the same strings in the page, the React constant and the proof file;
 *   3. every selected column is an output column of the view, and none is an identity, contact or reference-id
 *      column (the forbidden list below, which the proof file also asserts against the live view);
 *   4. the view's SQL carries the world match, security_barrier, no GRANT, and the revokes.
 * Run: node tests/gh2559-bidder-claims-view.mjs
 * GH2559_ROOT points at another tree for a negative control (a checkout of main or of PR #2569: expect failures).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2559_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

const FORBIDDEN = ['user_id', 'claim_number', 'homeowner_name', 'adjuster_id', 'adjuster_name', 'adjuster_email', 'adjuster_phone',
  'ingest_email', 'ingest_email_address', 'property_address', 'video_url', 'referral_code', 'referral_id', 'referral_source',
  'referral_agent_id', 'docusign_envelope_id', 'deductible_stripe_id', 'platform_fee_stripe_id', 'color_confirmation_envelope_id',
  'project_confirmation_envelope_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid',
  'first_touch_landing_path', 'first_touch_referrer', 'hover_order_id', 'itel_order_id', 'is_test', 'carrier_id', 'project_confirmation',
  'hover_measurements'];

const STATIC = ['contractor-opportunities.html', 'contractor-bid-form.html', 'contractor-dashboard.html'];
const REACT = ['react-app/app/contractor/opportunities/use-opportunities-data.ts', 'react-app/app/contractor/bid/[claimId]/page.tsx',
  'react-app/app/contractor/dashboard/use-dashboard-data.ts', 'react-app/app/contractor/dashboard/Messaging.tsx'];

// 1. no base-table read on a bidder path, no select-star from the view
for (const f of [...STATIC, ...REACT]) {
  const s = rd(f);
  ok(!/from\(\s*['"]claims['"]\s*\)/.test(s), `${f}: no .from('claims') (the base row is not read on a bidder path)`);
  ok(!/bidder_claim_summary['"]\s*\)\s*\.select\(\s*['"]\*/.test(s), `${f}: never select('*') from the view`);
  ok(/bidder_claim_summary/.test(s), `${f}: reads bidder_claim_summary`);
}

// view output columns, from the SQL
const sql = rd('supabase/migrations_drafts/gh2559_bidder_claims_view.sql');
const body = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const sel = body.slice(body.indexOf('SELECT') + 6, body.indexOf('FROM public.claims c'));
const items = []; { let d = 0, cur = ''; for (const ch of sel) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { items.push(cur); cur = ''; } else cur += ch; } items.push(cur); }
const viewCols = items.map((it) => { const t = it.trim().replace(/\s+/g, ' '); const m = t.match(/ AS (\w+)$/i); return m ? m[1] : t.split('.').pop(); });
ok(viewCols.length >= 30 && viewCols.includes('id') && viewCols.includes('location_city'), `parsed ${viewCols.length} output columns from the view SQL`);
ok(viewCols.every((c) => !FORBIDDEN.includes(c)), 'no output column of the view is an identity, contact or reference-id column');

// location and free text: what the view RETURNS is tested by behaviour on a throwaway Postgres
// (tools/gh2559-bidder-view-behaviour.py: planted street lines, units, boxes, lots, phones, emails). Here only
// the shape: the two location columns and the two free-text columns come from the guarded joins, never raw.
ok(/loc\.city\s+AS location_city/.test(body) && /loc\.zip\s+AS location_zip/.test(body), 'view: location_city and location_zip come from the guarded loc join');
ok(!/^\s*c\.homeowner_notes,\s*$/m.test(body), 'view: homeowner_notes is not selected raw');
ok(/CASE WHEN c\.selected_contractor_id = ct\.id THEN c\.homeowner_notes\s+WHEN c\.job_type = 'repair' THEN NULL\s+ELSE ft\.notes END\s+AS homeowner_notes/.test(body),
  'view: notes as typed only for the selected contractor; repair-intake notes withheld; redacted for everyone else');
ok(!/urgency_reason/.test(body.replace(/--[^\n]*/g, '')), 'view: urgency_reason is not exposed at all (no bidder page shows it; review 6050015567, structural fix)');
ok(!/urgency_reason/.test(rd('contractor-opportunities.html').match(/BIDDER_CLAIM_OPP_COLS = '[^']*'/)[0]), 'opportunities page: urgency_reason is not in the column list read from the view');
ok(!/urgency_reason/.test(rd('react-app/app/contractor/opportunities/utils.ts').match(/BIDDER_CLAIM_OPP_COLS =\s*'[^']*'/)[0]), 'React opportunities: urgency_reason is not in the column list read from the view');
ok(/fx\.brand ~\* .*length\(fx\.brand\) > 60/.test(body) && /fx\.color ~\* .*length\(fx\.color\) > 60/.test(body) && /measurement_shape IN \('basic', 'full'\)/.test(body), 'view: the typed catalogue columns carry a shape guard on the folded text (no @, web address with or without a scheme, "at"/"dot", phone-shaped run, street word with a digit, 60 characters at most); measurement_shape is a closed list');
ok(!/^\s*c\.damage_type,\s*$/m.test(body) && /WHEN c\.damage_type IS NULL OR btrim\(c\.damage_type\) = ''/.test(body) && /ELSE 'Other' END\s+AS damage_type/.test(body), 'view: damage_type (typed text) is returned only through the damage-word allow-list, else Other (review 6051111207 finding 1)');
ok(/normalize\(/.test(body) && /NFKD/.test(body) && /name_nl/.test(body), 'view: names and notes are compared after one Unicode fold (NFKD, combining marks, zero-width, full-width) and non-Latin name tokens are removed as exact text');
ok(/regexp_split_to_table\(idn\.street_words, '\[\|\]'\)/.test(body) && /length\(regexp_replace\(w, '\[\^a-z\]', '', 'g'\)\) >= 5/.test(body)
  && /WHEN idn5\.own5 IS NOT NULL\s+AND v\.raw ~\* \('\\m\(' \|\| idn5\.own5 \|\| '\)\\M'\) THEN '\[removed\]'/.test(body),
  'view: a note is removed whole when it holds one of the claim\'s own street-name words of five letters or more, house number or not (CEO ruling 6063622505)');
ok(/CREATE OR REPLACE VIEW public\.bidder_claim_summary/.test(body) && !/^\s*CREATE VIEW/m.test(body), 'view file is idempotent (CREATE OR REPLACE VIEW; a second run succeeds)');
ok(!/substring\(c\.property_address FROM '\\d\{5\}'\)/.test(body), 'view: the zip is never the first five-digit run of the address');
ok(!/bid-release gate/.test(sql), 'view SQL no longer rests the summary on a bid-release gate that does not exist');

// the street address outside the view (CEO return 6045859470; review 6047719061 finding 4)
{
  const form = rd('contractor-bid-form.html');
  ok(!/textContent = (data|payload)\.job_address/.test(form) && !/job_address: data\.job_address/.test(form), 'static bid form: never prints or caches job_address');
  const card = rd('react-app/app/contractor/bid/[claimId]/home-photos-card.tsx');
  ok(!/\{payload\.job_address\}/.test(card) && !/job_address: \(data\?\.job_address/.test(card), 'React bid form photo card: never prints or caches job_address');
  const fn = rd('supabase/functions/get-hover-siding-data/index.ts');
  ok(!/job_address: jobAddress,/.test(fn) && /job_address: jobAddressFor\(mayReceiveAddress, jobAddress\)/.test(fn) && /let mayReceiveAddress = isServiceRole;/.test(fn)
    && /mayReceiveAddress = await mayReceiveJobAddress\(supabase, claim_id, user\);/.test(fn),
    'get-hover-siding-data: job_address goes through the owner-or-selected gate');
}

// 2/3. the column lists
function lists(file, re) { const s = rd(file); const out = []; let m; while ((m = re.exec(s))) out.push(m[1]); return out; }
const csv = (x) => x.split(',').map((c) => c.trim());
const pairs = [
  ['OPP', 'contractor-opportunities.html', /BIDDER_CLAIM_OPP_COLS = '([^']+)'/g, 'react-app/app/contractor/opportunities/utils.ts', /BIDDER_CLAIM_OPP_COLS =\s*'([^']+)'/g, 'c_opp'],
  ['BID', 'contractor-bid-form.html', /BIDDER_CLAIM_BID_COLS = '([^']+)'/g, 'react-app/app/contractor/bid/[claimId]/utils.ts', /BIDDER_CLAIM_BID_COLS =\s*'([^']+)'/g, 'c_bid'],
  ['DASH', 'contractor-dashboard.html', /BIDDER_CLAIM_DASH_COLS = '([^']+)'/g, 'react-app/app/contractor/dashboard/utils.ts', /BIDDER_CLAIM_DASH_COLS = '([^']+)'/g, 'c_dash'],
  ['PEND', 'contractor-dashboard.html', /BIDDER_CLAIM_PEND_COLS = '([^']+)'/g, 'react-app/app/contractor/dashboard/utils.ts', /BIDDER_CLAIM_PEND_COLS = '([^']+)'/g, 'c_pend'],
];
const proof = rd('supabase/tests/gh2559_bidder_claims_view_proof.sql');
for (const [name, hf, hre, tf, tre, pv] of pairs) {
  const h = lists(hf, hre), t = lists(tf, tre);
  const p = (proof.match(new RegExp(pv + " +constant text := '([^']+)'")) || [])[1];
  ok(h.length === 1 && t.length === 1 && !!p, `${name}: one list in the static page, one in the React app, one in the proof`);
  ok(h[0] === t[0] && t[0] === p, `${name}: the three lists are the same string`);
  const cols = csv(h[0] || '');
  ok(cols.every((c) => viewCols.includes(c)), `${name}: every selected column is an output column of the view`);
  ok(cols.every((c) => !FORBIDDEN.includes(c)), `${name}: no selected column is identity, contact or a reference id`);
}
{ // Messaging selects its own two-column list
  const s = rd('react-app/app/contractor/dashboard/Messaging.tsx') + rd('contractor-dashboard.html');
  ok(/select\(['"]id, location_city, location_zip['"]\)/.test(s), 'messaging labels read id, location_city, location_zip from the view');
}

// 4. the view's SQL
ok(/c\.is_test = ct\.is_test/.test(body), 'view: world match c.is_test = ct.is_test');
ok(/security_barrier = true/.test(body), 'view: security_barrier = true');
ok(!/\bGRANT\b/.test(body.replace(/RAISE EXCEPTION '[^']*'/g, '')), 'view: no GRANT statement (nothing for the permissions ratchet to flag)');
ok(/REVOKE ALL ON public\.bidder_claim_summary FROM anon/.test(body) && /REVOKE ALL ON public\.bidder_claim_summary FROM PUBLIC/.test(body), 'view: revokes anon and PUBLIC');
ok(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.bidder_claim_summary FROM authenticated/.test(body), 'view: authenticated keeps SELECT only');
ok(/auth\.uid\(\)/.test(body) && /ct\.status = 'active'/.test(body), 'view: keyed to the caller and requires an active contractor on the open-for-bids branch');
ok(/CASE WHEN c\.selected_contractor_id = ct\.id THEN c\.estimate_filename END/.test(body) && /CASE WHEN c\.selected_contractor_id = ct\.id THEN c\.measurements_filename END/.test(body), 'view: file names only for the selected contractor');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
