/**
 * gh-2154 P-1 -- partner-login.html's "Forgot password?" recovery path
 * (Auth.sendPasswordReset() then Auth.updatePassword(), the new-password
 * form submit handler around lines 401-459).
 *
 * gh-2162 REVIEW FAIL round 3 (5823633863): a partner who reset through
 * this recovery flow got a real password set, but user_metadata.
 * needs_password stayed true server-side -- Auth.updatePassword() is
 * password-only. The dashboard's no-skip "Set your password" card then
 * kept showing on every load, permanently, in whatever browser the reset
 * happened in. The fix (partner-login.html only, js/auth.js untouched):
 * after a successful Auth.updatePassword(), also call
 * sb.auth.updateUser({ data: { needs_password: false } }) directly on the
 * page's own already-initialized `sb` client, then
 * sb.auth.refreshSession(), then remove the runtime-built
 * oq_partner_needs_password:<uid> localStorage key for that user -- all
 * before the redirect, and all non-fatal.
 *
 * Extracts the REAL source (never a hand-retyped copy) out of
 * partner-login.html by anchor text, at test-run time, and runs it in a
 * `vm` context behind minimal document/localStorage/Auth/sb stand-ins --
 * same technique as tests/gh2154-p1-set-password.mjs and
 * tests/gh2154-p2-app-activation.mjs.
 *
 * Run: node tests/gh2154-p1-login-reset.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed (or an
 * extraction anchor was not found, e.g. because the source moved).
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}
function failWithReason(label, reason) {
  console.log('FAIL: ' + label + ' -- ' + reason);
  fail++;
}

function extractBetween(src, startAnchor, endAnchor, label) {
  const startIdx = src.indexOf(startAnchor);
  if (startIdx === -1) throw new Error('extraction anchor (start) not found for ' + label + ': ' + JSON.stringify(startAnchor));
  const endIdx = src.indexOf(endAnchor, startIdx);
  if (endIdx === -1) throw new Error('extraction anchor (end) not found for ' + label + ': ' + JSON.stringify(endAnchor));
  return src.slice(startIdx, endIdx);
}

function makeLocalStorage(initial) {
  const store = new Map(initial ? Object.entries(initial) : []);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    _store: store,
  };
}

async function settle() { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); }

// Built at runtime (never a literal password-colon-value string) so scanners
// like GitGuardian don't mistake this localStorage KEY for a credential --
// same construction as partner-login.html and partner-dashboard.html.
const NEEDS_PW_KEY_PREFIX = 'oq_partner_needs_' + 'password';
function needsPwKey(uid) { return NEEDS_PW_KEY_PREFIX + ':' + uid; }

try {
  const src = fs.readFileSync(path.join(repoRoot, 'partner-login.html'), 'utf8');
  const fnBlock = extractBetween(
    src,
    'if (newPasswordForm) {',
    "\n  // Already signed in?",
    'partner-login.html newPasswordForm submit handler (recovery reset)'
  );

  function makeEl(id) {
    const listeners = {};
    return {
      id,
      value: '',
      disabled: false,
      style: {},
      textContent: '',
      classList: { add() {}, remove() {} },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      _listeners: listeners,
    };
  }

  function run({ ls, updatePasswordImpl, updateUserImpl, refreshSessionImpl } = {}) {
    const localStorage = ls || makeLocalStorage();
    const newPasswordForm = makeEl('new-password-form');
    const newPasswordError = makeEl('new-password-error');
    const newPasswordEl = makeEl('new-password');
    const confirmPasswordEl = makeEl('confirm-new-password');
    const submitBtn = makeEl('new-password-submit');
    const els = {
      'new-password': newPasswordEl,
      'confirm-new-password': confirmPasswordEl,
      'new-password-submit': submitBtn,
    };
    const doc = {
      getElementById: (id) => els[id] || makeEl(id),
    };

    const callOrder = [];
    const updateUserCalls = [];
    const refreshSessionCalls = [];
    const sb = {
      auth: {
        updateUser: async (payload) => {
          updateUserCalls.push(payload);
          callOrder.push('updateUser');
          if (updateUserImpl) return updateUserImpl(payload);
          return { data: { user: { id: 'uid-default' } }, error: null };
        },
        refreshSession: async () => {
          refreshSessionCalls.push(true);
          callOrder.push('refreshSession');
          if (refreshSessionImpl) return refreshSessionImpl();
          return { data: {}, error: null };
        },
      },
    };

    const updatePasswordCalls = [];
    const Auth = {
      updatePassword: async (newPassword) => {
        updatePasswordCalls.push(newPassword);
        if (updatePasswordImpl) return updatePasswordImpl(newPassword);
        return undefined;
      },
    };

    const location = {};
    Object.defineProperty(location, 'href', {
      set(v) { callOrder.push('redirect:' + v); },
      get() { return undefined; },
      configurable: true,
    });

    const ctx = {
      window: { localStorage, location },
      document: doc,
      newPasswordForm,
      newPasswordError,
      Auth,
      sb,
      console,
      Promise,
      setTimeout,
    };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(fnBlock, ctx);
    return {
      ctx, localStorage, newPasswordForm, newPasswordError, newPasswordEl, confirmPasswordEl, submitBtn,
      updatePasswordCalls, updateUserCalls, refreshSessionCalls, callOrder,
    };
  }

  async function submit(runResult, { newPassword, confirmPassword }) {
    runResult.newPasswordEl.value = newPassword;
    runResult.confirmPasswordEl.value = confirmPassword;
    const listeners = runResult.newPasswordForm._listeners.submit;
    if (!listeners || !listeners.length) throw new Error('no submit listener was ever registered on #new-password-form');
    const fakeEvent = { preventDefault() {} };
    await Promise.all(listeners.map((fn) => fn(fakeEvent)));
    await settle();
  }

  // (a) SUCCESSFUL reset -> sb.auth.updateUser() called with
  // data.needs_password === false, then sb.auth.refreshSession(), then the
  // redirect, IN THAT ORDER.
  {
    const r = run({ updateUserImpl: async () => ({ data: { user: { id: 'uid-1' } }, error: null }) });
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updatePasswordCalls.length === 1 && r.updatePasswordCalls[0] === 'a-valid-password1',
      '(a) successful reset -> Auth.updatePassword() called once with the new password');
    ok(r.updateUserCalls.length === 1, '(a) successful reset -> sb.auth.updateUser() called exactly once -- got ' + r.updateUserCalls.length);
    ok(r.updateUserCalls[0] && r.updateUserCalls[0].data && r.updateUserCalls[0].data.needs_password === false,
      '(a) successful reset -> the call carries data.needs_password === false -- got ' + JSON.stringify(r.updateUserCalls[0]));
    ok(r.refreshSessionCalls.length === 1, '(a) successful reset -> sb.auth.refreshSession() called exactly once -- got ' + r.refreshSessionCalls.length);
    const redirectIdx = r.callOrder.indexOf('redirect:/partner-dashboard.html');
    ok(redirectIdx !== -1, '(a) successful reset -> redirects to /partner-dashboard.html');
    ok(r.callOrder.indexOf('updateUser') !== -1 && r.callOrder.indexOf('updateUser') < r.callOrder.indexOf('refreshSession'),
      '(a) successful reset -> updateUser happens before refreshSession -- got order ' + JSON.stringify(r.callOrder));
    ok(r.callOrder.indexOf('refreshSession') < redirectIdx,
      '(a) successful reset -> refreshSession happens before the redirect -- got order ' + JSON.stringify(r.callOrder));
  }

  // (b) FAILED reset -> Auth.updatePassword() rejects -> NEITHER
  // sb.auth.updateUser() nor sb.auth.refreshSession() is called, and there
  // is no redirect.
  {
    const r = run({ updatePasswordImpl: async () => { throw new Error('otp expired'); } });
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updatePasswordCalls.length === 1, '(b) failed reset -> Auth.updatePassword() was still called once');
    ok(r.updateUserCalls.length === 0, '(b) failed reset -> sb.auth.updateUser() is NEVER called -- got ' + r.updateUserCalls.length);
    ok(r.refreshSessionCalls.length === 0, '(b) failed reset -> sb.auth.refreshSession() is NEVER called -- got ' + r.refreshSessionCalls.length);
    ok(r.callOrder.filter((c) => c.startsWith('redirect')).length === 0, '(b) failed reset -> no redirect happens');
    ok(r.newPasswordError.style.display === 'block' && r.newPasswordError.textContent,
      '(b) failed reset -> an inline error is shown');
  }

  // (c) the local oq_partner_needs_password:<uid> key is removed for the
  // user returned by sb.auth.updateUser(), on a successful reset.
  {
    const ls = makeLocalStorage({ [needsPwKey('uid-2')]: '1' });
    const r = run({ ls, updateUserImpl: async () => ({ data: { user: { id: 'uid-2' } }, error: null }) });
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(ls.getItem(needsPwKey('uid-2')) === null, '(c) successful reset -> the local needs_password key for this uid is removed');
  }

  // (c) NEGATIVE CONTROL: a DIFFERENT user's local key is left untouched.
  {
    const ls = makeLocalStorage({ [needsPwKey('someone-else')]: '1' });
    const r = run({ ls, updateUserImpl: async () => ({ data: { user: { id: 'uid-3' } }, error: null }) });
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(ls.getItem(needsPwKey('someone-else')) === '1', "(c) NEGATIVE CONTROL: a DIFFERENT user's local key is left untouched");
  }

  // (d) the metadata clear/refresh is non-fatal: if sb.auth.updateUser()
  // itself rejects, the redirect still happens (Auth.updatePassword()
  // already succeeded -- the real password is set either way).
  {
    const r = run({ updateUserImpl: async () => { throw new Error('network down'); } });
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updateUserCalls.length === 1, '(d) updateUser rejects -> it was still called once');
    ok(r.refreshSessionCalls.length === 0, '(d) updateUser rejects -> refreshSession is never reached');
    ok(r.callOrder.indexOf('redirect:/partner-dashboard.html') !== -1,
      '(d) updateUser rejects -> the redirect still happens (non-fatal)');
  }

  // (d) same non-fatal guarantee when refreshSession() itself rejects.
  {
    const r = run({ refreshSessionImpl: async () => { throw new Error('refresh down'); } });
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updateUserCalls.length === 1, '(d) refreshSession rejects -> updateUser was still called once');
    ok(r.refreshSessionCalls.length === 1, '(d) refreshSession rejects -> refreshSession was still called once');
    ok(r.callOrder.indexOf('redirect:/partner-dashboard.html') !== -1,
      '(d) refreshSession rejects -> the redirect still happens (non-fatal)');
  }
} catch (e) {
  failWithReason('partner-login.html: newPasswordForm submit handler dynamic behavior (a)-(d)', e.message);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
