/**
 * gh-2421 (D-344) -- dashboard.html's homeowner state gate must be a blocked
 * list (FL, LA, TX fallback; live list via get_homeowner_blocked_states rpc),
 * not the Indiana-only `!== 'IN'` check D-178 originally shipped.
 *
 * Static grep-based guard against the raw source of dashboard.html and the
 * React port's utils.ts, same style as gh2004-static-no-addressless-claim.mjs.
 *
 * Run: node tests/gh2421-static-homeowner-blocked-states.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const dash = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const reactUtils = fs.readFileSync(path.join(ROOT, 'react-app/app/(homeowner)/dashboard/utils.ts'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261003020711_gh2421_homeowner_blocked_states.sql'), 'utf8');

// ---- dashboard.html ----
ok(!/property_state\s*!==\s*['"]IN['"]/.test(dash), "dashboard.html: the Indiana-only `property_state !== 'IN'` gate literal is gone");
ok(/sb\.rpc\(\s*['"]get_homeowner_blocked_states['"]\s*\)/.test(dash), 'dashboard.html: reads the blocked list via sb.rpc(get_homeowner_blocked_states)');
ok(/DEFAULT_BLOCKED_STATES\s*=\s*\[\s*'FL'\s*,\s*'LA'\s*,\s*'TX'\s*\]/.test(dash), 'dashboard.html: hard-coded fallback list is exactly FL, LA, TX');
ok(/blockedStates\.includes\(\s*String\(currentClaim\.property_state\)\.trim\(\)\.toUpperCase\(\)\s*\)/.test(dash), 'dashboard.html: gate tests the trimmed, upper-cased property_state against the blocked list');
ok(/if \(CONFIG\.DEMO_MODE \|\| !sb\) return DEFAULT_BLOCKED_STATES;/.test(dash), 'dashboard.html: DEMO_MODE skips the rpc');
ok(/showStateGateCard\(currentClaim\.property_state\)/.test(dash), 'dashboard.html: blocked states still call showStateGateCard');
ok(/status:\s*'waitlisted'/.test(dash) && /expansion_waitlist/.test(dash), "dashboard.html: waitlisted status + expansion_waitlist handling retained");

// ---- React port ----
ok(!/property_state\s*!==\s*['"]IN['"]/.test(reactUtils.replace(/\/\*[\s\S]*?\*\//g, '')), "react utils.ts: no `property_state !== 'IN'` in code");
ok(/DEFAULT_BLOCKED_STATES[^=]*=\s*\[\s*'FL'\s*,\s*'LA'\s*,\s*'TX'\s*\]/.test(reactUtils), 'react utils.ts: exports default blocked list FL, LA, TX');

// ---- migration ----
ok(/'homeowner_blocked_states'\s*,\s*'\["FL","LA","TX"\]'::jsonb/.test(migration), 'migration: seeds homeowner_blocked_states = ["FL","LA","TX"]');
ok(/GRANT EXECUTE ON FUNCTION public\.get_homeowner_blocked_states\(\) TO authenticated/.test(migration) && !/TO anon/.test(migration.replace(/--.*$/gm, '')), 'migration: EXECUTE granted to authenticated only (never anon)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
