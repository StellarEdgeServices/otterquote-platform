/**
 * Regression test for gh-3704 (Sentry JAVASCRIPT-3T): TypeError
 * "Cannot add property __isAuthError, object is not extensible" thrown from
 * supabase-js@2.116.0 `new AuthError` (via `new AuthUnknownError` in
 * GoTrueClient._initialize's catch) and surfaced as an UNHANDLED REJECTION.
 *
 * Loads the REAL js/config.js then the REAL js/supabase-client.js in ONE shared global, in the
 * order the pages use (supabase UMD stub, config.js, supabase-client.js). config.js creates the
 * client at load time, so the guard must already be registered when createClient() runs.
 * Ruling (CEO RUN 152): preventDefault + ONE handled warning per page (fingerprint, UA,
 * occurrence count), never a silent drop; unrelated rejections reach Sentry unchanged.
 *
 * Run: node tests/gh3704-supabase-isautherror-unhandled-rejection.mjs
 * Exit 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : '  :: ' + detail));
  if (!ok) failures++;
}

// Reproduce the throw as supabase.js does when Error construction yields a non-extensible object.
class FrozenErrorBase { constructor(m) { return Object.freeze(new Error(m)); } }
class AuthError extends FrozenErrorBase { constructor(m) { super(m); this.__isAuthError = true; } }
let thrown = null;
try { new AuthError('Unexpected error during initialization'); } catch (e) { thrown = e; }
check('repro: constructing AuthError on a frozen base throws the Sentry TypeError',
  thrown instanceof TypeError && /Cannot add property __isAuthError, object is not extensible/.test(thrown.message), String(thrown));
const withStack = (e, stack) => { const c = new TypeError(e.message); c.stack = stack; return c; };
const SB_STACK = 'TypeError: x\n  at new Zn (/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js:7:34756)';
const known = withStack(thrown, SB_STACK);

function makeRun() {
  const listeners = []; const timers = []; const captured = [];
  let listenersAtCreateClient = -1;
  const g = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    navigator: { userAgent: 'TestUA/1.0' },
    location: { hostname: 'otterquote.com', protocol: 'https:', search: '', hash: '', pathname: '/dashboard.html', href: 'https://otterquote.com/dashboard.html' },
    document: { addEventListener() {}, readyState: 'loading', cookie: '' },
    addEventListener(t, fn, c) { listeners.push({ t, fn, capture: c === true || !!(c && c.capture) }); },
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    supabase: { createClient() { listenersAtCreateClient = listeners.filter(l => l.t === 'unhandledrejection').length; return { auth: { onAuthStateChange() { return { data: { subscription: {} } }; } } }; } },
  };
  g.window = g; g.self = g; g.globalThis = g;
  g.Sentry = { captureMessage: (m, ctx) => captured.push({ m, ctx }) };
  vm.createContext(g);
  for (const f of ['js/config.js', 'js/supabase-client.js']) vm.runInContext(read(f), g, { filename: f });
  const sentrySeen = [];
  g.addEventListener('unhandledrejection', ev => sentrySeen.push(ev.reason)); // Sentry's bubble handler, registered later
  function dispatch(reason) {
    const ev = { reason, defaultPrevented: false };
    let stopped = false;
    ev.stopImmediatePropagation = () => { stopped = true; };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    const ordered = listeners.filter(l => l.t === 'unhandledrejection' && l.capture).concat(listeners.filter(l => l.t === 'unhandledrejection' && !l.capture));
    for (const l of ordered) { if (stopped) break; l.fn(ev); }
    return ev;
  }
  return { g, captured, sentrySeen, dispatch, flush: () => { while (timers.length) timers.shift()(); }, listenersAtCreateClient: () => listenersAtCreateClient };
}

// Page-order check: the guard exists BEFORE config.js's createClient() runs.
const a = makeRun();
check('real page order: guard is registered before config.js calls createClient()', a.listenersAtCreateClient() >= 1,
  'listeners at createClient = ' + a.listenersAtCreateClient());
check('real page order: window.sb is set by config.js (supabase-client.js then returns early)', !!a.g.sb, 'sb unset');

const ev1 = a.dispatch(known);
check('matching rejection does not reach Sentry\'s unhandledrejection handler', a.sentrySeen.length === 0, 'seen ' + a.sentrySeen.length);
check('preventDefault was called on the matching rejection', ev1.defaultPrevented === true, 'not prevented');
a.dispatch(known); a.dispatch(known);
check('nothing is sent before the debounce fires', a.captured.length === 0, 'captured ' + a.captured.length);
a.flush();
check('exactly one handled warning is reported for 3 rejections', a.captured.length === 1, 'captured ' + a.captured.length);
const c = a.captured[0] || { m: '', ctx: {} };
check('event is level warning with the stable fingerprint',
  c.ctx.level === 'warning' && JSON.stringify(c.ctx.fingerprint) === '["gh3704-supabase-auth-init-nonextensible"]', JSON.stringify(c.ctx));
check('event carries message prefix, UA and occurrence count 3 (repeats counted, not dropped)',
  /Cannot add property __isAuthError/.test(c.m) && c.ctx.contexts && c.ctx.contexts.gh3704.userAgent === 'TestUA/1.0'
  && c.ctx.contexts.gh3704.occurrences === 3 && c.ctx.tags.occurrences === '3'
  && Object.keys(c.ctx.contexts.gh3704).sort().join() === 'occurrences,userAgent', JSON.stringify(c));

// Negative controls: must reach Sentry unchanged, and produce no handled event.
function control(name, reason) {
  const r = makeRun(); const ev = r.dispatch(reason); r.flush();
  check('control: ' + name + ' still reaches Sentry unchanged', r.sentrySeen.length === 1 && !ev.defaultPrevented && r.captured.length === 0,
    'seen ' + r.sentrySeen.length + ' prevented ' + ev.defaultPrevented + ' captured ' + r.captured.length);
}
control('an unrelated TypeError', new TypeError('Cannot read properties of undefined (reading "x")'));
control('same message with no supabase frame', withStack(thrown, 'TypeError: x\n  at somethingElse (/js/app.js:1:1)'));
control('same message from our own js/supabase-client.js frame', withStack(thrown, 'TypeError: x\n  at f (https://otterquote.com/js/supabase-client.js:9:9)'));
control('a string rejection', 'boom');

process.exit(failures ? 1 : 0);
