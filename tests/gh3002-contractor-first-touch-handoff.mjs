/**
 * gh-3002 -- contractor signups never recorded a first touch.
 *
 * A contractor magic link redirects to /contractor-pre-approval.html (not
 * /auth-callback.html). That page never called Auth.handleAuthCallback() or
 * Auth.recordFirstTouchAttribution(), so the oq_ft touch was never handed to
 * record_first_touch_attribution for contractors (prod profile cf12a80d, a
 * contractor, has a null first_touch_landing_path after #3211).
 *
 * 1. WIRING: contractor-pre-approval.html calls Auth.recordFirstTouchAttribution()
 *    in the load path, after the session is resolved and before the contractor
 *    record is read, inside a try block (non-fatal).
 * 2. REACHABILITY: sendMagicLink / contractor-join.html still route contractors
 *    to /contractor-pre-approval.html (if that changes, this guard must move).
 *
 * Override ROOT=<dir> for the negative control (a checkout of main).
 * Run: node tests/gh3002-contractor-first-touch-handoff.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT || path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL: ${name}\n  ${e.message}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

const page = read('contractor-pre-approval.html');
const auth = read('js/auth.js');
const join = read('contractor-join.html');

check('contractors are routed to contractor-pre-approval.html (reachability)', () => {
  ok(/role === 'contractor'\s*\?\s*'\/contractor-pre-approval\.html'/.test(auth), 'js/auth.js sendMagicLink contractor redirect changed');
  ok(join.includes('/contractor-pre-approval.html'), 'contractor-join.html redirect changed');
});

check('Auth.recordFirstTouchAttribution exists and is the write-once RPC caller', () => {
  ok(/async recordFirstTouchAttribution\(\)/.test(auth), 'missing in js/auth.js');
  ok(auth.includes("sb.rpc('record_first_touch_attribution'"), 'RPC call missing');
});

check('contractor-pre-approval.html records the first touch after the session resolves', () => {
  const sessionAt = page.indexOf('currentUser = session.user;');
  const recAt = page.indexOf('recordFirstTouchAttribution');
  const recordAt = page.indexOf("from('contractors')", sessionAt);
  ok(sessionAt > 0, 'session anchor not found');
  ok(recAt > sessionAt, 'recordFirstTouchAttribution is never called after the session is resolved');
  ok(recAt < recordAt, 'recordFirstTouchAttribution must run before the contractor record load');
  const around = page.slice(Math.max(0, recAt - 60), recAt + 200);
  ok(/try\s*\{/.test(around) && /catch/.test(around), 'call must be wrapped non-fatal');
});

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
