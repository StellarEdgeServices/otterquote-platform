/**
 * gh-2431 -- profiles.address_state no longer defaults to 'IN'. The migration
 * draft must drop the default and stop handle_new_user() seeding it, change
 * nothing else in that function, add no trigger and touch no row; and every
 * reader of a homeowner profile's address_state must already treat NULL as
 * "unknown" (never as Indiana).
 *
 * Static source guard, same style as gh2421-static-homeowner-blocked-states.mjs.
 * Run: node tests/gh2431-profiles-address-state-null.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }
const code = (s) => s.replace(/--.*$/gm, '');

const fwd = code(rd('supabase/migrations_drafts/gh2431_profiles_address_state_default.sql'));
const rb = code(rd('supabase/migrations_rollbacks/gh2431_profiles_address_state_default_rollback.sql'));

// ---- forward migration ----
ok(/ALTER TABLE public\.profiles ALTER COLUMN address_state DROP DEFAULT;/.test(fwd), 'forward: drops the address_state default');
ok(/CREATE OR REPLACE FUNCTION public\.handle_new_user\(\)/.test(fwd), 'forward: replaces handle_new_user() (extends the existing function)');
ok(!/CREATE\s+(OR REPLACE\s+)?TRIGGER/i.test(fwd) && !/DROP\s+TRIGGER/i.test(fwd), 'forward: adds no second trigger');
ok(!/\b(UPDATE|DELETE\s+FROM)\s+public\./i.test(fwd) && !/INSERT\s+INTO\s+(?!public\.profiles \(id, email, full_name, created_at, updated_at\))/i.test(fwd.replace(/\$function\$[\s\S]*?\$function\$/, m => m)), 'forward: backfills and rewrites no existing row');
const fwdFn = fwd.match(/\$function\$([\s\S]*?)\$function\$/)[1];
const rbFn = rb.match(/\$function\$([\s\S]*?)\$function\$/)[1];
ok(!/address_state/.test(fwdFn) && !/'IN'/.test(fwdFn), "forward: new handle_new_user() neither names address_state nor writes 'IN'");
ok(/address_state/.test(rbFn) && /'IN',/.test(rbFn), "rollback: restores the previous handle_new_user() (writes 'IN')");
// the two function bodies differ by exactly the column list line and the 'IN' value line
const a = rbFn.split('\n'), b = fwdFn.split('\n');
const onlyInRb = a.filter(l => !b.includes(l));
const onlyInFwd = b.filter(l => !a.includes(l));
ok(onlyInFwd.length === 1 && /\(id, email, full_name, created_at, updated_at\)/.test(onlyInFwd[0])
   && onlyInRb.length === 2 && onlyInRb.some(l => /\(id, email, full_name, address_state, created_at, updated_at\)/.test(l)) && onlyInRb.some(l => l.trim() === "'IN',"),
   'forward vs rollback function body: every other line identical, only the column list and the IN value line differ');
ok(/ALTER COLUMN address_state SET DEFAULT 'IN'::text;/.test(rb), "rollback: restores DEFAULT 'IN'");

// ---- readers: NULL means unknown, never Indiana ----
const ts = rd('trade-selector.html');
ok(/property_state:\s*profile\?\.address_state\s*\|\|\s*null/.test(ts), 'trade-selector.html: claim property_state is the profile value or null (no IN fallback)');
ok(/\[profile\.address_street, profile\.address_city, profile\.address_state, profile\.address_zip\]\s*\.filter\(Boolean\)/.test(ts), 'trade-selector.html: address string skips a NULL state');
const tsx = rd('react-app/app/trade-selector/page.tsx');
ok(/state:\s*\(profileRow\?\.address_state \|\| ''\)\.trim\(\) \|\| null/.test(tsx), 'react trade-selector: profile state NULL becomes null, not a default');
const dash = rd('dashboard.html');
ok(/if \(currentClaim\?\.property_state\) \{/.test(dash) && /address_state:\s*signupData\.address_state \|\| null/.test(dash), 'dashboard.html: gate runs only on a set property_state; profile state falls to null');
const utils = rd('react-app/app/(homeowner)/dashboard/utils.ts');
ok(/return !!state && blockedStates\.includes/.test(utils), 'react isStateGated: NULL state is not gated and is never coerced to IN');
ok(/address_state:\s*profile\?\.address_state \|\| ''/.test(rd('react-app/app/(homeowner)/help-measurements/utils.ts')), 'help-measurements: NULL state becomes empty string');
ok(/\[homeownerProfileRow\?\.address_state, homeownerProfileRow\?\.address_zip\]\.filter\(Boolean\)/.test(rd('supabase/functions/create-docusign-envelope/index.ts')), 'create-docusign-envelope: customer_city_zip skips a NULL state');
ok(/\[p\.address_city, p\.address_state, p\.address_zip\]\.filter\(Boolean\)/.test(rd('supabase/functions/notify-admin-new-homeowner/templates.ts')), 'notify-admin-new-homeowner: location line skips a NULL state');
// no reader of a profile row falls back to IN
for (const f of ['trade-selector.html', 'react-app/app/trade-selector/page.tsx', 'react-app/app/(homeowner)/help-measurements/utils.ts', 'supabase/functions/create-docusign-envelope/index.ts']) {
  ok(!/(profile|profileRow|homeownerProfileRow)\??\.address_state\s*(\|\||\?\?)\s*['"]IN['"]/.test(rd(f)), `${f}: no profile.address_state || 'IN' fallback`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
