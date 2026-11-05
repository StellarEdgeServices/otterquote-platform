// gh-3409: the HTML bid form must not ask PostgREST for exactly one row when it inserts the fee acceptance.
// With the guard, a mismatching acceptance is diverted (zero rows come back); `.single()` then makes PostgREST answer 406 PGRST116 and roll the whole
// request back, including the quarantine row (proved against real PostgREST in gh3409_postgrest_proof.mjs, case P4). Usage: node gh3409_form_shape_check.mjs <html file>
import fs from 'node:fs';
const src = fs.readFileSync(process.argv[2] || 'contractor-bid-form.html', 'utf8');
const at = src.indexOf(".from('fee_acceptances').insert(");
if (at < 0) { console.log('FORMSHAPE|insert not found|FAIL'); process.exit(1); }
const end = src.indexOf(';', src.indexOf('user_agent', at));
const stmt = src.slice(at, end + 1);
const hasSingle = /\.(single|maybeSingle)\s*\(/.test(stmt), hasSelect = /\.select\('id'\)\s*;?$/.test(stmt) || /\.select\('id'\)/.test(stmt);
const ok = !hasSingle && hasSelect;
console.log(`FORMSHAPE|insert ends with .select('id') and no .single()/.maybeSingle()|${ok ? 'OK' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
