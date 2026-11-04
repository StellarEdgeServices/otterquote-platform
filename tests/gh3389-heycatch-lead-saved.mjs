// gh-3389 (D-409): HeyCatch records ONE named goal event, `lead_saved`, after the leads row is really saved on the two
// public start pages, with no properties and no identity. No browser needed. Run: node tests/gh3389-heycatch-lead-saved.mjs
// Env GH3389_ROOT points the checks at another tree (used to run this test against the pre-change files as the failing control).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

const root = process.env.GH3389_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('ok   ' + name);
  else { failed++; console.log('FAIL ' + name + (detail ? '\n     ' + detail : '')); }
}

// Body of `function fireConversion(...) { ... }` by brace counting.
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  return null;
}

// (a) the tracker: name-allowlisted, name only
const priv = await import(pathToFileURL(path.join(root, 'js/heycatch-privacy.js')).href);
check('privacy module exports makeEventTracker', typeof priv.makeEventTracker === 'function');
if (typeof priv.makeEventTracker === 'function') {
  const calls = [];
  const track = priv.makeEventTracker(function () { calls.push(Array.from(arguments)); });
  check('lead_saved is sent once, with the name as the only argument', track('lead_saved') === true && calls.length === 1 && JSON.stringify(calls[0]) === '["lead_saved"]', JSON.stringify(calls));
  calls.length = 0;
  track('lead_saved', { email: 'a@b.com', lead_id: 'L1', event_id: 'E1' }, 'extra');
  check('properties passed by a caller are never forwarded (no email, lead id, event id)', calls.length === 1 && calls[0].length === 1, JSON.stringify(calls));
  calls.length = 0;
  for (const n of ['signup_completed', 'generate_lead', 'quote_generated', 'payment_succeeded', '$pageview', '', undefined, null, 'LEAD_SAVED'])
    check('event name outside the allowlist is dropped: ' + String(n), track(n) === false && calls.length === 0);
  const throwing = priv.makeEventTracker(function () { throw new Error('sdk down'); });
  check('a throwing SDK never throws into the page', throwing('lead_saved') === false);
}

// (b) the boot sets the hook after init, via the tracker, with the name only
const boot = read('js/heycatch-boot.js').replace(/^\s*\/\/.*$/gm, '');
check('boot imports makeEventTracker from the privacy module', /import\s*\{[^}]*makeEventTracker[^}]*\}\s*from\s*'\/js\/heycatch-privacy\.js'/.test(boot));
check('boot sets window.__oqHcTrack after analytics.init, through makeEventTracker', /analytics\.init\([\s\S]*?\);[\s\S]*window\.__oqHcTrack\s*=\s*makeEventTracker\(/.test(boot));
check('boot calls trackEvent with the name only', /trackEvent\(n\)/.test(boot) && (boot.match(/trackEvent\(/g) || []).length === 1);
check('boot adds no identity call (identify, setPersonProperties, alias, people)', !/\.(identify|setPersonProperties|alias|people|register)\s*\(/.test(boot));

// (c) the two fire sites: inside the once-only conversion function, right after the leads row is saved, hook-guarded
for (const [file, label] of [['js/router-variant-f.js', '/start'], ['js/ho6-start.js', '/ho6/start']]) {
  const src = read(file);
  const body = fnBody(src, 'fireConversion');
  check(label + ': fireConversion exists', !!body);
  if (!body) continue;
  check(label + ': fireConversion calls the hook with the literal name and nothing else', /window\.__oqHcTrack\('lead_saved'\)/.test(body) && (body.match(/__oqHcTrack\(/g) || []).length === 1);
  check(label + ': the call is guarded by typeof window.__oqHcTrack === \'function\' (no-op when HeyCatch did not load)', /typeof window\.__oqHcTrack === 'function'/.test(body));
  check(label + ': the only __oqHcTrack call in the file is that one', (src.match(/__oqHcTrack\(/g) || []).length === 1);
  check(label + ': fireConversion is only called from the saved-lead branch', (src.match(/fireConversion\(/g) || []).length === 2); // definition + one call, in saving.then
  // behaviour: run the real function with stubs
  const run = (hook) => {
    const hits = [];
    const win = hook ? { __oqHcTrack: function () { hits.push(Array.from(arguments)); } } : {};
    const ctx = { window: win, leadEventFired: false, eventFired: false, leadId: 'LEAD-1', bridge: { trackRouter() {} }, CORE: { trackEvent() {} }, stepParams: () => ({}), fbq() {} };
    vm.createContext(ctx);
    vm.runInContext(body + '\nfireConversion("LEAD-1"); fireConversion("LEAD-1");', ctx);
    return hits;
  };
  const withHook = run(true), without = run(false);
  check(label + ': one lead_saved with no properties, even when the conversion function runs twice', withHook.length === 1 && JSON.stringify(withHook[0]) === '["lead_saved"]', JSON.stringify(withHook));
  check(label + ': no hook, no error, no event', Array.isArray(without) && without.length === 0);
}

// (d) the page gate is untouched: both start pages are already on it, and no signed-in or post-OAuth page is
const gate = read('js/ga-gate.js');
const m = gate.match(/var HEYCATCH_ALLOWED_PATHS = \[([\s\S]*?)\];/);
const allowed = m ? Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]) : [];
check('gate lists /start and /ho6/start', allowed.includes('/start') && allowed.includes('/ho6/start'));
for (const p of ['/get-started', '/auth-callback', '/dashboard', '/contract-signing', '/login', '/bids'])
  check('gate does not list ' + p + ' (privacy 5.5A)', !allowed.includes(p));
const jsDir = readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js'));
const users = jsDir.filter((f) => /__oqHcTrack/.test(read('js/' + f))).sort();
check('only the boot and the two start pages reference the hook', JSON.stringify(users) === JSON.stringify(['heycatch-boot.js', 'ho6-start.js', 'router-variant-f.js']), JSON.stringify(users));

// (e) negative control: the pre-change shape of a fire site is detected
const pre = (fnBody(read('js/ho6-start.js'), 'fireConversion') || '').replace(/^.*__oqHcTrack.*\n/m, '');
check('negative control: a fire site without the call is detected', !/window\.__oqHcTrack\('lead_saved'\)/.test(pre));

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall gh3389 HeyCatch lead_saved checks passed');
