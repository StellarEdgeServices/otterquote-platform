/**
 * Regression test for gh-3704 (Sentry JAVASCRIPT-3T): TypeError
 * "Cannot add property __isAuthError, object is not extensible" thrown from
 * supabase-js@2.116.0 `new AuthError` (called by `new AuthUnknownError` in
 * GoTrueClient._initialize's catch) and surfaced as an UNHANDLED REJECTION.
 *
 * The throw is in CDN vendor code; js/supabase-client.js must keep this one
 * environment fault from reaching Sentry's unhandledrejection listener while
 * letting every other rejection through. Reproduces the throw for real with a
 * base class that returns a frozen Error (exact V8 message), then drives a fake
 * window with a capture-phase-first dispatcher and a Sentry-like listener.
 *
 * Run: node tests/gh3704-supabase-isautherror-unhandled-rejection.mjs
 * Exit 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'supabase-client.js'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (ok ? '' : '  :: ' + detail));
  if (!ok) failures++;
}

// 1. Reproduce the throw exactly as supabase.js does (class extends Error, this.__isAuthError = true)
//    when Error construction yields a non-extensible object.
class FrozenErrorBase { constructor(m) { return Object.freeze(new Error(m)); } }
class AuthError extends FrozenErrorBase {
  constructor(m) { super(m); this.__isAuthError = true; }
}
let thrown = null;
try { new AuthError('Unexpected error during initialization'); } catch (e) { thrown = e; }
check('repro: constructing AuthError on a frozen base throws the Sentry TypeError',
  thrown instanceof TypeError && /Cannot add property __isAuthError, object is not extensible/.test(thrown.message),
  String(thrown));
// give it a supabase-looking stack like the production event
thrown.stack = 'TypeError: ' + thrown.message + '\n  at new Zn (/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js:7:34756)';

// 2. Fake window: capture listeners run before bubble listeners, stopImmediatePropagation honoured.
function makeWindow() {
  const ls = [];
  return {
    location: { hostname: 'otterquote.com', protocol: 'https:' },
    addEventListener(type, fn, opts) { ls.push({ type, fn, capture: opts === true || !!(opts && opts.capture) }); },
    dispatch(type, ev) {
      let stopped = false;
      ev.stopImmediatePropagation = () => { stopped = true; };
      ev.preventDefault = () => { ev.defaultPrevented = true; };
      const ordered = ls.filter(l => l.type === type && l.capture).concat(ls.filter(l => l.type === type && !l.capture));
      for (const l of ordered) { if (stopped) break; l.fn(ev); }
    },
  };
}

function run(reason) {
  const window = makeWindow();
  const sentrySeen = [];
  const sandbox = {
    window, CONFIG: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON: 'anon' },
    console: { warn() {}, log() {}, error() {} },
  };
  window.supabase = { createClient: () => ({ auth: {} }) };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  // Sentry-like listener registered AFTER supabase-client.js, bubble phase (as Sentry.init does later)
  window.addEventListener('unhandledrejection', ev => sentrySeen.push(ev.reason));
  window.dispatch('unhandledrejection', { reason });
  return sentrySeen;
}

const seenKnown = run(thrown);
check('the known supabase __isAuthError rejection does NOT reach Sentry', seenKnown.length === 0,
  'Sentry-like listener received ' + seenKnown.length + ' event(s)');

// Negative controls: unrelated and lookalike rejections must still be reported.
const other = new TypeError('Cannot read properties of undefined (reading "x")');
check('control: an unrelated TypeError still reaches Sentry', run(other).length === 1, 'dropped');
const lookalike = new TypeError('Cannot add property __isAuthError, object is not extensible');
lookalike.stack = 'TypeError: ...\n  at somethingElse (/js/app.js:1:1)';
check('control: same message with no supabase frame still reaches Sentry', run(lookalike).length === 1, 'dropped');
check('control: a non-Error rejection (string) still reaches Sentry', run('boom').length === 1, 'dropped');

process.exit(failures ? 1 : 0);
