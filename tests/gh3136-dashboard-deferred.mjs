// gh-3136 (P14): dashboard receives the questions deferred out of sign-up / project-info.
// Static, no network. Run: node tests/gh3136-dashboard-deferred.mjs
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const cur = readFileSync('dashboard.html', 'utf8');
let main;
try { main = execSync('git show main:dashboard.html', { encoding: 'utf8', maxBuffer: 1 << 26 }); }
catch { main = execSync('git show origin/main:dashboard.html', { encoding: 'utf8', maxBuffer: 1 << 26 }); }

function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  const open = src.indexOf('{', i);
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
let n = 0; const ok = (m) => console.log('ok ' + (++n) + ' - ' + m);

// 1. Submit gate untouched
assert.equal(fnBody(cur, 'isChecklistComplete'), fnBody(main, 'isChecklistComplete'));
ok('isChecklistComplete body byte-identical to main');
const gate = fnBody(cur, 'isChecklistComplete');
assert.ok(!/deductible|referral/.test(gate));
ok('gate mentions neither deductible nor referral');

// 2. Deductible prompt conditioned on null
const ded = fnBody(cur, 'shouldShowDeductiblePrompt');
assert.match(ded, /funding_type === 'insurance'/);
assert.match(ded, /deductible_amount === null/);
assert.match(ded, /!!claim\.loss_sheet_parsed_at/);
assert.ok(!/has_estimate/.test(ded), 'has_estimate alone (parser not run) must not trigger the prompt');
ok('deductible prompt requires insurance + deductible_amount null + loss_sheet_parsed_at set (parser ran)');
const dsave = fnBody(cur, 'saveDeferredDeductible');
assert.match(dsave, /\.update\(\{ deductible_amount: n \}\)\.eq\('id', currentClaim\.id\)\.select\('id'\)/);
assert.match(dsave, /rows\.length === 0/);
ok('deductible save uses update().eq().select(id) and checks returned rows');
assert.match(cur, /Add your deductible &mdash; we couldn&rsquo;t read it from your estimate\./);
ok('deductible prompt string present');

// 3. How-heard card
const ref = fnBody(cur, 'shouldShowReferralCard');
assert.match(ref, /!claim\.referral_source \|\| claim\.referral_source === 'web'/);
assert.match(ref, /!claim\.referral_code && !claim\.referral_id/);
ok('referral card only while referral_source null/empty/web and no referral_code/referral_id');
const rsave = fnBody(cur, 'saveDeferredReferral');
assert.match(rsave, /update\(\{ referral_source: pick \}\)\.eq\('id', currentClaim\.id\)\.select\('id'\)/);
assert.match(rsave, /referring_agent_name/); assert.match(rsave, /referring_agent_email/);
assert.ok(!/from\('claims'\)\.update\([^)]*referring_agent/.test(rsave));
ok('referral save writes claims.referral_source; name/email go to profiles, not claims');
for (const v of ['insurance_agent', 'realtor', 'friend', 'web']) assert.ok(cur.includes(`value: '${v}'`), v);
for (const l of ['Insurance Agent', 'Realtor', 'Friend/Family', 'Found Online', 'Their Name', 'Their Email (optional)', 'How did you hear about us?', 'Skip'])
  assert.ok(cur.includes(l), l);
ok('four chips, follow-up labels, Skip present');

// 3b. per-claim localStorage key
assert.match(fnBody(cur, 'referralAnsweredKey'), /'oq_referral_answered_' \+ \(currentClaim && currentClaim\.id\)/);
ok('oq_referral_answered_ key is scoped per claim id');

// 4. Not wired into gate/submit
assert.ok(!/isChecklistComplete[^\n]*(deductible|referral)/.test(cur));
const sub = main.match(/async function submitForBids[\s\S]*?\n      }\n/);
if (sub) assert.ok(cur.includes(sub[0]));
ok('submitForBids unchanged');
console.log('PASS ' + n);
