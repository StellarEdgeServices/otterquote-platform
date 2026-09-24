/**
 * gh-2154 P-1 -- the one-time "Set your password" card on
 * partner-dashboard.html. Shown when the signed-in partner's account was
 * created via the passwordless short-signup flow (the oq_partner_needs_
 * password localStorage flag, keyed by user id, set by the signup pages) and
 * hasn't set a real password yet. No skip/dismiss control (Ben's ruling,
 * #2154 comment 5820448800) -- the card is hidden only by a successful
 * Auth.updatePassword() call, and reappears on every load until that
 * succeeds.
 *
 * Extracts the REAL source (never a hand-retyped copy) out of
 * partner-dashboard.html by anchor text, at test-run time, and runs it in a
 * `vm` context behind minimal document/localStorage/Auth stand-ins -- same
 * technique as tests/gh2154-p2-app-activation.mjs.
 *
 * Run: node tests/gh2154-p1-set-password.mjs
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
// like GitGuardian don't mistake this localStorage KEY for a credential.
const NEEDS_PW_KEY_PREFIX = 'oq_partner_needs_' + 'password';
function needsPwKey(uid) { return NEEDS_PW_KEY_PREFIX + ':' + uid; }

// ── (a) card markup exists, has no skip/dismiss control ─────────────────
{
  const html = fs.readFileSync(path.join(repoRoot, 'partner-dashboard.html'), 'utf8');
  const cardStart = html.indexOf('id="setPasswordCard"');
  ok(cardStart !== -1, 'partner-dashboard.html: #setPasswordCard markup exists');
  if (cardStart !== -1) {
    const cardEnd = html.indexOf('</div>', html.indexOf('</form>', cardStart));
    const cardHtml = html.slice(Math.max(0, html.lastIndexOf('<div', cardStart)), cardEnd + '</div>'.length);
    ok(/Set your password/i.test(cardHtml), 'partner-dashboard.html: card shows the "Set your password" heading');
    ok(/Set a password so you can sign in to the app\./.test(cardHtml), 'partner-dashboard.html: card shows the approved sentence verbatim');
    ok(!/skip for now/i.test(cardHtml), 'partner-dashboard.html: NO "Skip for now" text anywhere in the card');
    ok(!/\bdismiss\b/i.test(cardHtml), 'partner-dashboard.html: NO dismiss control anywhere in the card');
    // No close/skip control: every interactive element in the card must be
    // either a form input or the submit button -- no second button/link.
    const buttonsAndLinks = (cardHtml.match(/<(button|a)\b[^>]*>/gi) || []);
    ok(buttonsAndLinks.length === 1 && /type="submit"/.test(buttonsAndLinks[0]),
      'partner-dashboard.html: the ONLY control in the card is the submit button (no skip/close) -- found: ' + JSON.stringify(buttonsAndLinks));
  } else {
    failWithReason('partner-dashboard.html: card shows the "Set your password" heading', 'card markup not found');
    failWithReason('partner-dashboard.html: card shows the approved sentence verbatim', 'card markup not found');
    failWithReason('partner-dashboard.html: NO "Skip for now" text anywhere in the card', 'card markup not found');
    failWithReason('partner-dashboard.html: NO dismiss control anywhere in the card', 'card markup not found');
    failWithReason('partner-dashboard.html: the ONLY control in the card is the submit button (no skip/close)', 'card markup not found');
  }
}

// ── (b)-(e): dynamic behavior -- run the REAL extracted script in a vm ──
// Wrapped in try/catch (rather than letting extractBetween throw) so that
// running this file against a pre-fix head (e.g. 7314dc6e, before this
// feature existed at all) still reports every dependent scenario below as a
// clean FAIL with a reason, instead of crashing the whole test file.
try {
  const src = fs.readFileSync(path.join(repoRoot, 'partner-dashboard.html'), 'utf8');
  const fnBlock = extractBetween(
    src,
    'let setPasswordUserId = null;',
    '\n        // D-319 (gh-1509 half A): reads platform_settings.w9_gate_retired —',
    'partner-dashboard.html setPasswordUserId/refreshSetPasswordCard/initSetPasswordForm'
  );

  function makeEl(id) {
    const listeners = {};
    return {
      id,
      value: '',
      disabled: false,
      style: {},
      textContent: '',
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      _listeners: listeners,
    };
  }

  function run({ ls, updateUserImpl, currentUser } = {}) {
    const localStorage = ls || makeLocalStorage();
    const els = {
      setPasswordCard: makeEl('setPasswordCard'),
      setPasswordForm: makeEl('setPasswordForm'),
      setPasswordStatus: makeEl('setPasswordStatus'),
      setPasswordNew: makeEl('setPasswordNew'),
      setPasswordConfirm: makeEl('setPasswordConfirm'),
      setPasswordSubmit: makeEl('setPasswordSubmit'),
    };
    els.setPasswordCard.style.display = 'none';
    // gh-2162 review fix (3): initSetPasswordForm() now calls
    // sb.auth.updateUser({ password, data: { needs_password: false } })
    // directly (this page's own already-initialized client) instead of
    // Auth.updatePassword() -- a single round trip that clears the
    // server-visible flag at the same time it sets the real password.
    const updateUserCalls = [];
    const sb = {
      auth: {
        updateUser: async (payload) => {
          updateUserCalls.push(payload);
          if (updateUserImpl) return updateUserImpl(payload);
          return { data: {}, error: null };
        },
      },
    };
    const doc = {
      getElementById: (id) => els[id] || makeEl(id),
    };
    const ctx = {
      window: { localStorage },
      document: doc,
      sb,
      // gh-2162 review fix (3): refreshSetPasswordCard() now also checks
      // the module-scope `currentUser` variable (set by init() elsewhere in
      // the real file, outside this extraction span) for
      // user_metadata.needs_password === true -- provided here as a plain
      // context global so the extracted block's bare reference resolves to
      // it, same as it would as a same-file module-scope variable.
      currentUser: currentUser || null,
      console,
      Promise,
      setTimeout,
    };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(fnBlock, ctx);
    return { ctx, els, localStorage, updateUserCalls };
  }

  async function submit(runResult, { newPassword, confirmPassword }) {
    runResult.els.setPasswordNew.value = newPassword;
    runResult.els.setPasswordConfirm.value = confirmPassword;
    const listeners = runResult.els.setPasswordForm._listeners.submit;
    if (!listeners || !listeners.length) throw new Error('no submit listener was ever registered on #setPasswordForm');
    const fakeEvent = { preventDefault() {} };
    await Promise.all(listeners.map((fn) => fn(fakeEvent)));
    await settle();
  }

  // (b) flag set -> card rendered (shown).
  {
    const ls = makeLocalStorage({ [needsPwKey('user-1')]: '1' });
    const r = run({ ls });
    r.ctx.refreshSetPasswordCard('user-1');
    ok(r.els.setPasswordCard.style.display === 'block', '(b) flag set for this user -> card is shown');
  }

  // (e) NEGATIVE CONTROLS: flag not set -> no card; a DIFFERENT user's flag -> no card.
  {
    const ls = makeLocalStorage(); // no flag at all
    const r = run({ ls });
    r.ctx.refreshSetPasswordCard('user-2');
    ok(r.els.setPasswordCard.style.display === 'none', '(e) NEGATIVE CONTROL: no flag set for this user -> card stays hidden');
  }
  {
    const ls = makeLocalStorage({ [needsPwKey('someone-else')]: '1' });
    const r = run({ ls });
    r.ctx.refreshSetPasswordCard('user-3');
    ok(r.els.setPasswordCard.style.display === 'none', "(e) NEGATIVE CONTROL: a DIFFERENT user's flag is set -> card stays hidden for this user");
  }

  // (d) submit with mismatched confirm -> no updateUser call, error shown, flag untouched.
  {
    const ls = makeLocalStorage({ [needsPwKey('user-4')]: '1' });
    const r = run({ ls });
    r.ctx.refreshSetPasswordCard('user-4');
    await submit(r, { newPassword: 'longenough1', confirmPassword: 'different1' });
    ok(r.updateUserCalls.length === 0, '(d) mismatched confirm -> zero sb.auth.updateUser() calls');
    ok(/do not match/i.test(r.els.setPasswordStatus.textContent), '(d) mismatched confirm -> inline error shown');
    ok(ls.getItem(needsPwKey('user-4')) === '1', '(d) mismatched confirm -> flag is kept');
    ok(r.els.setPasswordCard.style.display !== 'none', '(d) mismatched confirm -> card stays visible (not hidden)');
  }

  // (d) submit too-short password -> same minimum length as partner-login.html (8).
  {
    const ls = makeLocalStorage({ [needsPwKey('user-4b')]: '1' });
    const r = run({ ls });
    r.ctx.refreshSetPasswordCard('user-4b');
    await submit(r, { newPassword: 'short1', confirmPassword: 'short1' });
    ok(r.updateUserCalls.length === 0, '(d) too-short password (< 8 chars) -> zero sb.auth.updateUser() calls');
    ok(/at least 8 characters/i.test(r.els.setPasswordStatus.textContent), '(d) too-short password -> the same minimum-length error partner-login.html uses');
    ok(ls.getItem(needsPwKey('user-4b')) === '1', '(d) too-short password -> flag is kept');
  }

  // (d) submit valid -> a SINGLE sb.auth.updateUser() call carries both the
  // new password AND user_metadata.needs_password=false (gh-2162 review fix
  // 3 -- not Auth.updatePassword() followed by a second round trip), the
  // localStorage cache is cleared, and the card is hidden.
  {
    const ls = makeLocalStorage({ [needsPwKey('user-5')]: '1' });
    const r = run({ ls });
    r.ctx.refreshSetPasswordCard('user-5');
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updateUserCalls.length === 1, '(d) valid submit -> sb.auth.updateUser() called exactly once -- got ' + r.updateUserCalls.length);
    ok(r.updateUserCalls[0] && r.updateUserCalls[0].password === 'a-valid-password1', '(d) valid submit -> the call carries the new password -- got ' + JSON.stringify(r.updateUserCalls[0]));
    ok(r.updateUserCalls[0] && r.updateUserCalls[0].data && r.updateUserCalls[0].data.needs_password === false, '(d) valid submit -> the SAME call clears user_metadata.needs_password -- got ' + JSON.stringify(r.updateUserCalls[0]));
    ok(ls.getItem(needsPwKey('user-5')) === null, '(d) valid submit -> the localStorage cache flag is cleared');
    ok(r.els.setPasswordCard.style.display === 'none', '(d) valid submit -> the card is hidden');
  }

  // (d) updateUser rejects -> flag kept, error shown, card stays visible.
  {
    const ls = makeLocalStorage({ [needsPwKey('user-6')]: '1' });
    const r = run({ ls, updateUserImpl: async () => { throw new Error('network down'); } });
    r.ctx.refreshSetPasswordCard('user-6');
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updateUserCalls.length === 1, '(d) updateUser rejects -> it was still called once');
    ok(ls.getItem(needsPwKey('user-6')) === '1', '(d) updateUser rejects -> the flag is KEPT');
    ok(/could not set your password/i.test(r.els.setPasswordStatus.textContent), '(d) updateUser rejects -> inline error shown');
    ok(r.els.setPasswordCard.style.display !== 'none', '(d) updateUser rejects -> the card stays visible');
  }

  // (e) NEGATIVE CONTROL variant: a reload with the flag STILL set (e.g. a
  // rejected updateUser call from the previous scenario) shows the card
  // again on the next refreshSetPasswordCard() call -- there is no
  // session-only "hidden" state, since there is no skip control to create one.
  {
    const ls = makeLocalStorage({ [needsPwKey('user-7')]: '1' });
    const r = run({ ls, updateUserImpl: async () => { throw new Error('network down'); } });
    r.ctx.refreshSetPasswordCard('user-7');
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(ls.getItem(needsPwKey('user-7')) === '1', '(e) flag still set after a failed submit');

    // Simulate a fresh page load (fresh script run) with the same
    // (still-set) flag -- the card must render again.
    const r2 = run({ ls });
    r2.ctx.refreshSetPasswordCard('user-7');
    ok(r2.els.setPasswordCard.style.display === 'block', '(e) NEGATIVE CONTROL: a reload with the flag still set shows the card again (no skip control persists a hidden state)');
  }

  // (f) gh-2162 REVIEW FAIL 3: the reviewer's actual scenario -- a partner's
  // first dashboard landing in a DIFFERENT browser (or the installed PWA)
  // has NO localStorage flag at all (separate storage), but the
  // server-visible user_metadata.needs_password IS true. The card must
  // still show. Shown FAILING against the pre-fix behavior (localStorage
  // read only) by the fact that this scenario has no flag in `ls`.
  {
    const ls = makeLocalStorage(); // no localStorage flag -- different browser/PWA
    const r = run({ ls, currentUser: { id: 'user-8', user_metadata: { needs_password: true } } });
    r.ctx.refreshSetPasswordCard('user-8');
    ok(r.els.setPasswordCard.style.display === 'block', '(f) metadata true, no localStorage flag (other-browser/PWA landing) -> card is shown');
  }

  // (f) negative control: metadata explicitly false, no localStorage flag -> no card.
  {
    const ls = makeLocalStorage();
    const r = run({ ls, currentUser: { id: 'user-9', user_metadata: { needs_password: false } } });
    r.ctx.refreshSetPasswordCard('user-9');
    ok(r.els.setPasswordCard.style.display === 'none', '(f) NEGATIVE CONTROL: metadata false, no localStorage flag -> card stays hidden');
  }

  // (f) a successful set clears BOTH the localStorage cache and the
  // in-memory currentUser.user_metadata.needs_password (so a second
  // refreshSetPasswordCard() call in the same session, e.g. a subsequent
  // init() run, does not re-show the card from stale in-memory metadata).
  {
    const ls = makeLocalStorage(); // no localStorage flag -- this partner is on the other-browser/PWA path
    const cu = { id: 'user-10', user_metadata: { needs_password: true } };
    const r = run({ ls, currentUser: cu });
    r.ctx.refreshSetPasswordCard('user-10');
    ok(r.els.setPasswordCard.style.display === 'block', '(f) pre-submit: metadata-only true -> card shown');
    await submit(r, { newPassword: 'a-valid-password1', confirmPassword: 'a-valid-password1' });
    ok(r.updateUserCalls.length === 1 && r.updateUserCalls[0].data.needs_password === false, '(f) valid submit clears the server flag via sb.auth.updateUser even when there was no localStorage flag to begin with');
    ok(r.els.setPasswordCard.style.display === 'none', '(f) valid submit hides the card immediately');
    ok(cu.user_metadata.needs_password === false, '(f) valid submit also clears the in-memory currentUser.user_metadata.needs_password (no stale re-show within the same session)');
  }
} catch (e) {
  failWithReason('partner-dashboard.html: setPasswordUserId/refreshSetPasswordCard/initSetPasswordForm dynamic behavior (b)-(e)', e.message);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log('TOTAL: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
