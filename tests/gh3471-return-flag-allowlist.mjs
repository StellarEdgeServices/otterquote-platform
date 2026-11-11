/**
 * gh-3471 (D-419): the static site (js/auth.js) and the React app (react-app/app/lib/return-target.ts) must carry the SAME return-flag
 * allowlist, and every consumer must go through it. Static assertions, no browser. Exit 0 = all green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0; let fail = 0;
function ok(cond, label) { if (cond) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }

const auth = read('js/auth.js');
const lib = read('react-app/app/lib/return-target.ts');
const staticMap = /var RETURN_TARGETS = \{([^}]*)\};/.exec(auth);
const reactMap = /export const RETURN_TARGETS = \{([^}]*)\} as const;/.exec(lib);
ok(!!staticMap && !!reactMap, 'both allowlists found');
const entries = (m) => [...m[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((x) => [x[1], new URL(x[2], 'https://otterquote.com').pathname]);
ok(JSON.stringify(entries(staticMap)) === JSON.stringify(entries(reactMap)), 'static and React allowlists have the same tokens and paths: ' + JSON.stringify(entries(staticMap)));
ok(/hasOwnProperty\.call\(RETURN_TARGETS/.test(auth) && /hasOwnProperty\.call\(RETURN_TARGETS/.test(lib), 'both match on an own key only (no __proto__ / constructor)');
ok(!/location\.(href|replace|assign)\s*[=(]\s*[^;\n]*get\(\s*['"]return['"]\s*\)/.test(read('dashboard.html')), 'dashboard never navigates to a raw ?return= value');

// consumers go through the allowlist helpers
const dash = read('dashboard.html');
ok(/Auth\.returnTarget\(window\.location\.search\)/.test(dash), 'dashboard.html follows only Auth.returnTarget()');
for (const f of ['rcv', 'acv', 'cash']) ok(/Auth\.dashboardUrlWithReturn\(window\.location\.search\)/.test(read('project-info-' + f + '.html')), 'project-info-' + f + '.html forwards only through Auth.dashboardUrlWithReturn()');
// the dashboard reads it only after the sign-in check and the D-344 state gate
const iGate = dash.indexOf('showStateGateCard(currentClaim.property_state);'); const iRet = dash.indexOf('Auth.returnTarget(window.location.search)');
ok(iGate > 0 && iRet > iGate, 'dashboard.html reads the return token after the state gate (D-344), so the gate is not skipped');
for (const f of ['react-app/app/auth-callback/page.tsx', 'react-app/app/trade-selector/page.tsx', 'react-app/app/get-started/page.tsx']) ok(/lib\/return-target/.test(read(f)), f + ' uses lib/return-target');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
