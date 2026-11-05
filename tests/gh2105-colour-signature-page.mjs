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

// G (gh-3287, Ben 2026-11-02T17:12Z, replacing 6581042504): the colour-save note is exactly the ruled sentence,
// with no "already signed" sentence and no contact clause around it
const RULED_NOTE = 'Your color choice is saved. Please confirm it with your contractor.';
const noteGuards = (h) => {
  const text = h.replace(/<\/?strong>/g, '');
  return {
    'G: the colour-save note is the ruled sentence, exactly': text.includes(RULED_NOTE),
    'G: the old "final contract documents" promise is gone': !/final contract documents/.test(h),
    'G: no "before you sign" in the note': !/before you sign/.test(h),
    'G: no "already signed" sentence on the page': !/already signed/.test(h),
    'G: no "lock it in" promise anywhere on the page': !/lock it in|enter it in the form below/.test(h),
    'G: no contact clause after the note': !/confirm directly with|Contact your contractor, \$\{/.test(h),
  };
};
for (const [label, ok] of Object.entries(noteGuards(stripComments(html)))) check(label, ok);
const brokenNote = noteGuards(html.replace('Your color choice is saved.', 'Color saved.'));
check('control: a reworded note is detected', !brokenNote['G: the colour-save note is the ruled sentence, exactly']);
const oldNote = noteGuards(html + ' Your contractor will include the color selection in your final contract documents.');
check('control: the old promise coming back is detected', !oldNote['G: the old "final contract documents" promise is gone']);
const signedNote = noteGuards(html + ' your contract is already signed');
check('control: the "already signed" sentence coming back is detected', !signedNote['G: no "already signed" sentence on the page']);
const beforeNote = noteGuards(html.replace('Please confirm it with your contractor.', 'Please confirm it with your contractor before you sign.'));
check('control: "before you sign" coming back is detected', !beforeNote['G: no "before you sign" in the note']);
const lockNote = noteGuards(html + " enter it in the form below to lock it in.");
check('control: the "lock it in" promise coming back is detected', !lockNote['G: no "lock it in" promise anywhere on the page']);
const clauseNote = noteGuards(html + ' You can also confirm directly with X at 1.');
check('control: the contact clause coming back is detected', !clauseNote['G: no contact clause after the note']);

// H (gh-3287, Ben's one ruling 6584752880 on list 6584500871): the ruled changes on the static page, in his words.
const H_ITEM27 = '<strong>After visualizing:</strong> Come back here and enter the color you selected.';
const rulingGuards = (h) => ({
  'H14-16: no Browse Colors card, catalog text or View Colors button': !/Browse Colors|View Colors|color catalog|option: 'browse'/.test(h),
  'H20: the new-tab note is built for the visualizer card only': /\$\{opt\.id === 'visualize' && \(this\.brand === 'GAF' \|\|/.test(h),
  'H2-3: the subtitle drops the contractor name when the name is missing': /const who = contractor\?\.company_name \? `Your contractor \$\{this\.contractorName\}` : 'Your contractor';/.test(h)
    && /`\$\{who\} uses \$\{this\.brand\}\./.test(h) && /`\$\{who\} will confirm the brand\./.test(h),
  'H27: the OC desktop note is the ruled sentence (same as item 29)': h.includes(H_ITEM27) && !/Once you've found a color you like/.test(h),
  'H45-49: the Request Visit panel is gone (card, section, button, handler, confirmations, mailto) and nothing replaces it (Ben 6668689264)': !/Request Visit|In-Person Color Samples|Prefer to See Colors In Person|Rather See Colors In Person|physical color boards|shingle samples|requestColorBoardVisit|inperson|color_board_request|Visit requested|Already requested|reach out within|in-person color samples|physical boards/i.test(h),
  'H69-71: the colour signing panel is gone (heading, body, frame title, builder)': !/Sign Color Addendum|Almost done|Color Addendum — E-Sign|showAddendumSigningIframe/.test(h),
});
import { readFileSync as __rf } from 'node:fs';
const __faq = __rf(new URL('../faq.html', import.meta.url), 'utf8');
check('FAQ: no "request a contractor visit" or physical-color-boards text (Ben 6669908503)', !/contractor visit|physical color boards/i.test(__faq));
check('control: the FAQ sentence coming back is detected', /contractor visit|physical color boards/i.test(__faq + ' Or you can request a contractor visit with physical color boards.'));
const htmlNoComments = stripComments(html);
for (const [label, ok] of Object.entries(rulingGuards(htmlNoComments))) check(label, ok);
// negative controls: each ruled change put back must be detected
const hc = (label, mutated, key) => check(`control: ${label}`, !rulingGuards(mutated)[key]);
hc('the Browse Colors card coming back is detected', htmlNoComments + " title: 'Browse Colors'", 'H14-16: no Browse Colors card, catalog text or View Colors button');
hc('the new-tab note on every card is detected', htmlNoComments.replace("${opt.id === 'visualize' && (this.brand === 'GAF' ||", "${(this.brand === 'GAF' ||"), 'H20: the new-tab note is built for the visualizer card only');
hc('the name coming back into the subtitle is detected', htmlNoComments.replace("const who = contractor?.company_name ? `Your contractor ${this.contractorName}` : 'Your contractor';", "const who = `Your contractor ${this.contractorName}`;"), 'H2-3: the subtitle drops the contractor name when the name is missing');
hc('the old fragment (item 27) coming back is detected', htmlNoComments.replace(H_ITEM27, "<strong>After visualizing:</strong> Once you've found a color you like."), 'H27: the OC desktop note is the ruled sentence (same as item 29)');
hc('"or physical boards" coming back is detected', htmlNoComments + ' from the tool above or physical boards.', 'H45-49: the Request Visit panel is gone (card, section, button, handler, confirmations, mailto) and nothing replaces it (Ben 6668689264)');
hc('the Request Visit button coming back is detected', htmlNoComments + ' <button>Request Visit</button>', 'H45-49: the Request Visit panel is gone (card, section, button, handler, confirmations, mailto) and nothing replaces it (Ben 6668689264)');
hc('the in-person section coming back is detected', htmlNoComments + ' <h3>Prefer to See Colors In Person?</h3>', 'H45-49: the Request Visit panel is gone (card, section, button, handler, confirmations, mailto) and nothing replaces it (Ben 6668689264)');
hc('the request handler coming back is detected', htmlNoComments + ' async requestColorBoardVisit() {}', 'H45-49: the Request Visit panel is gone (card, section, button, handler, confirmations, mailto) and nothing replaces it (Ben 6668689264)');
hc('the shingle-samples sentence coming back is detected', htmlNoComments + " We'll ask your contractor to bring shingle samples.", 'H45-49: the Request Visit panel is gone (card, section, button, handler, confirmations, mailto) and nothing replaces it (Ben 6668689264)');
hc('the signing panel coming back is detected', htmlNoComments + ' <h3>Sign Color Addendum</h3>', 'H69-71: the colour signing panel is gone (heading, body, frame title, builder)');

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

// D-407 / D-393 amended (#3287): the separate colour addendum is gone, so the page may not tell the
// homeowner they will sign one. Dustin approved deleting these two statements (#3253, 6527199786).
const addendumStatements = (html) => /separate addendum|addendum on your next contract review/.test(html);
check('page: no "separate addendum" / "addendum on your next contract review" copy (D-407)', !addendumStatements(stripComments(read('color-selection.html'))));
check('control: the addendum-copy guard detects the deleted sentence', addendumStatements('Your color selection will be added to your contract as a separate addendum for signature.'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
