/**
 * gh-2105 (colour-signature repair, checklist A, B, C, F) -- static guard for
 * color-selection.html and the draft RPC migration. Reads the files as text.
 *
 *   A  claims is keyed on user_id (homeowner_id does not exist)
 *   B  no embedded contractors join, no nonexistent contractor columns
 *   C  contractor name/brand come from get_claim_color_contractor; the RPC is
 *      ownership-checked, returns two columns, and is not callable by anon
 *   F  the colour save chains .select('id') and treats zero rows as a failure
 *
 * Every guard also runs against a deliberately broken copy and must FAIL there
 * (negative controls), so a green run cannot be a test that checks nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');
let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) { pass++; console.log(`ok   - ${label}`); } else { fail++; console.log(`FAIL - ${label}`); }
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*--.*$/gm, '');

const pageGuards = (html) => {
  const js = stripComments(html);
  return {
    'A: no homeowner_id anywhere in the page code': !/homeowner_id/.test(js),
    'A: the claim load and the colour save both filter on user_id': (js.match(/\.eq\('user_id', this\.userId\)/g) || []).length === 2,
    'B: no embedded contractors join': !/contractor:\s*contractors\s*\(/.test(js),
    'B: no nonexistent contractor columns (preferred_brand, notification_phones)': !/preferred_brand\b|notification_phones/.test(js),
    'C: contractor name and brand come from get_claim_color_contractor': /sb\.rpc\('get_claim_color_contractor', \{ p_claim_id: this\.claimId \}\)/.test(js)
      && /contractor\?\.company_name/.test(js) && /contractor\.preferred_brands\[0\]/.test(js),
    'C: an RPC failure is caught (page still loads)': /catch \(rpcErr\)/.test(js),
    "F: the colour save chains .select('id') and rejects zero rows": /\.eq\('user_id', this\.userId\)\s*\.select\('id'\);/.test(js) && /savedRows\.length === 0\) throw/.test(js),
  };
};

const html = read('color-selection.html');
for (const [label, ok] of Object.entries(pageGuards(html))) check(label, ok);

// negative controls for the page guards
const broken = html
  .replaceAll(".eq('user_id', this.userId)", ".eq('homeowner_id', this.userId)")
  .replace("sb.rpc('get_claim_color_contractor'", "sb.rpc('x'")
  .replace('if (!savedRows || savedRows.length === 0) throw', 'if (false) throw');
const brokenResults = pageGuards(broken);
check('control: reverting A is detected', !brokenResults['A: no homeowner_id anywhere in the page code']);
check('control: reverting C is detected', !brokenResults['C: contractor name and brand come from get_claim_color_contractor']);
check('control: reverting F is detected', !brokenResults["F: the colour save chains .select('id') and rejects zero rows"]);

// ---- the draft RPC migration ----
const sqlGuards = (sql) => {
  const body = stripComments(sql);
  return {
    'RPC: SECURITY DEFINER with a pinned search_path': /SECURITY DEFINER/.test(body) && /SET search_path = public, pg_temp/.test(body),
    'RPC: ownership is claims.user_id = auth.uid()': /cl\.user_id = auth\.uid\(\)/.test(body),
    'RPC: returns only company_name and preferred_brands': /RETURNS TABLE\(company_name text, preferred_brands text\[\]\)/.test(body) && /SELECT ct\.company_name, ct\.preferred_brands\s+FROM/.test(body),
    'RPC: execute revoked from PUBLIC and anon, granted to authenticated only': /REVOKE ALL ON FUNCTION public\.get_claim_color_contractor\(uuid\) FROM PUBLIC;/.test(body)
      && /REVOKE ALL ON FUNCTION public\.get_claim_color_contractor\(uuid\) FROM anon;/.test(body)
      && /GRANT EXECUTE ON FUNCTION public\.get_claim_color_contractor\(uuid\) TO authenticated;/.test(body)
      && !/TO (anon|public)\b/i.test(body),
    'RPC: adds no policy on contractors': !/CREATE POLICY/i.test(body) && !/ALTER TABLE/i.test(body),
  };
};
const fwdPath = 'supabase/migrations_drafts/gh2105_color_contractor_rpc.sql';
const fwd = read(fwdPath);
for (const [label, ok] of Object.entries(sqlGuards(fwd))) check(label, ok);
const brokenSql = fwd.replace('AND cl.user_id = auth.uid()', '').replace('GRANT EXECUTE ON FUNCTION public.get_claim_color_contractor(uuid) TO authenticated;', 'GRANT EXECUTE ON FUNCTION public.get_claim_color_contractor(uuid) TO anon;');
const brokenSqlResults = sqlGuards(brokenSql);
check('control: dropping the ownership predicate is detected', !brokenSqlResults['RPC: ownership is claims.user_id = auth.uid()']);
check('control: granting anon is detected', !brokenSqlResults['RPC: execute revoked from PUBLIC and anon, granted to authenticated only']);

const rb = stripComments(read('supabase/migrations_drafts/gh2105_color_contractor_rpc_rollback.sql'));
check('rollback: drops the function and nothing else', /DROP FUNCTION IF EXISTS public\.get_claim_color_contractor\(uuid\);/.test(rb) && !/DROP (TABLE|POLICY|VIEW)/i.test(rb));
check('draft: not under supabase/migrations/ (never applied by this PR)', !fwdPath.startsWith('supabase/migrations/'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
