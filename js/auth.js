/**
 * OtterQuote — Auth Helpers
 * Magic link authentication via Supabase Auth
 * Role-based routing: homeowner vs contractor
 */

/** Escape user-supplied strings before interpolating into HTML email templates. */
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Clear the domain-wide auth cookies and canonical localStorage key.
 * Called when Auth.getSession() detects a fast-path / live-session identity
 * mismatch (ADR-012) or during sign-out to prevent identity bleed across accounts.
 */
function _clearStaleAuthCookies() {
  try {
    if (window.OtterQuoteCookieStorage) {
      window.OtterQuoteCookieStorage.removeItem(
        window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth'
      );
    }
  } catch (e) { /* non-fatal */ }
}

/**
 * Persist the live session back through the storage adapter after the
 * mismatch path cleared the shared cookies. The two-cookie set is shared by
 * both identities: clearing the stale identity also deletes the live user's
 * freshly-written tokens, and since #488 made cookies canonical the
 * localStorage copy no longer resurrects them (getItem purges it instead).
 * Without this re-write, the mismatch path silently signs the live user out
 * (E2E AR-5/COI-1 board red, 2026-07-08).
 */
function _writeLiveSessionToStorage(session) {
  try {
    if (!session || !session.access_token || !session.refresh_token) return;
    if (window.OtterQuoteCookieStorage) {
      window.OtterQuoteCookieStorage.setItem(
        window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth',
        JSON.stringify(session)
      );
    }
  } catch (e) { /* non-fatal */ }
}

/**
 * Attach real user identity to Sentry error events (issue #408).
 * Previously every dashboard/contractor page shipped errors as fully
 * anonymous events (Sentry.init() with no setUser call anywhere), so
 * production incidents had no way to tell how many distinct users were
 * affected or reproduce with a specific account. Uses only fields the
 * Supabase auth session already exposes — no new identity data is
 * invented or collected.
 * Safe to call on every page: no-ops if the Sentry loader snippet hasn't
 * attached window.Sentry yet (e.g. ad-blockers) or if user is falsy.
 */
function _identifySentryUser(user) {
  try {
    if (user && window.Sentry && typeof window.Sentry.setUser === 'function') {
      window.Sentry.setUser({ id: user.id, email: user.email });
    }
  } catch (e) { /* non-fatal — never let telemetry wiring break auth */ }
}

/** Clear Sentry identity on sign-out so subsequent anonymous errors (e.g. on the
 * logged-out landing page) aren't misattributed to the just-signed-out user. */
function _clearSentryUser() {
  try {
    if (window.Sentry && typeof window.Sentry.setUser === 'function') {
      window.Sentry.setUser(null);
    }
  } catch (e) { /* non-fatal */ }
}

/**
 * gh-807: single source of truth for "is this a partner surface" page.
 * Before this, requireAuth() tested the four-family regex against the full
 * pathname while redirectToDashboard()'s #783 guard tested only
 * `indexOf('partner-') === 0` against the trailing filename — so `ref-*`,
 * `recruit*`, and `refer-a-friend*` pages were partner surfaces by
 * requireAuth()'s own definition but NOT covered by redirectToDashboard()'s
 * guard. Both now call this one function. It tests the trailing filename
 * (not the full pathname) so a directory segment can never false-positive
 * (e.g. a hypothetical /blog/refer-a-friend-story.html would not match).
 */
var PARTNER_SURFACE_FILE_RE = /^(partner-|ref-|recruit|refer-a-friend)/;
function _isPartnerSurfaceFile(pathname) {
  var file = pathname.substring(pathname.lastIndexOf('/') + 1);
  return PARTNER_SURFACE_FILE_RE.test(file);
}

/**
 * gh-851: single source of truth for the partner agent_type values, mirroring
 * the gh-807 fix for _isPartnerSurfaceFile() above. Previously redeclared
 * identically at three call sites in this file (sendMagicLink, requireAuth,
 * and now redirectToDashboard) plus once more in index.html's standalone
 * bounce script (which cannot reference this file — it runs before any
 * script tag, including this one, loads).
 */
var PARTNER_ROLES = ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'];

window.Auth = {
  /** Get current session - robust race-free implementation.
   *
   * Prior implementation (F-007c) had a race: when localStorage already
   * contained a valid session but Supabase JS hadn't finished its async
   * init, INITIAL_SESSION fired with null, the fallback called
   * sb.auth.getUser() server-side, which itself needs the session to be
   * loaded - leading to a null result. The page then bounced to a login
   * URL even though the user was actually authenticated. (Symptom: the
   * dashboard -> get-started -> dashboard 3-hop loop.)
   *
   * New approach (May 4, 2026):
   *   (a) Synchronously inspect localStorage for the Supabase auth token.
   *       If absent AND no auth indicator in the URL, the user is not
   *       authenticated - resolve null immediately, no race possible.
   *   (b) Otherwise an auth flow is in progress (token in URL or session
   *       in storage). Subscribe to onAuthStateChange and wait for any
   *       event that surfaces a session.
   *   (c) After 6 s, if no session has surfaced, attempt a one-shot
   *       refreshSession() before giving up at 8 s.
   */
  async getSession() {
    if (!sb) return null;

    var hasStoredSession = false;
    try {
      // D-212 — read via storage adapter so we hit the cross-subdomain cookie path
      // on app.otterquote.com and the localStorage path on otterquote.com.
      // Defensive fallback to legacy key if the adapter isn't loaded yet.
      var raw = null;
      if (window.OtterQuoteCookieStorage) {
        raw = window.OtterQuoteCookieStorage.getItem(window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth');
      } else {
        var refMatch = (CONFIG && CONFIG.SUPABASE_URL ? CONFIG.SUPABASE_URL : '').match(/https:\/\/([^.]+)/);
        var ref = refMatch ? refMatch[1] : null;
        if (ref) raw = localStorage.getItem('sb-' + ref + '-auth-token');
      }
      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (parsed && (parsed.access_token || parsed.refresh_token)) {
            hasStoredSession = true;
            // Fast path: if the local access token is not yet expired, return it
            // immediately without any network call. This prevents valid sessions
            // from bouncing to login during Supabase auth degradation incidents.
            // (Auth resiliency hardening — 2026-05-14 | task 86e1d1agx)
            if (parsed.access_token) {
              try {
                var jwtParts = parsed.access_token.split('.');
                if (jwtParts.length === 3) {
                  var jwtPayload = JSON.parse(atob(jwtParts[1].replace(/-/g, '+').replace(/_/g, '/')));
                  if (jwtPayload.exp && jwtPayload.exp > Math.floor(Date.now() / 1000)) {
                    // Token valid locally — reconcile against live sb client before returning.
                    // Prevents domain-wide cookie identity bleed when a different account
                    // was active in the same browser (ADR-012 / D-212 — task 86e1p4n2k).
                    try {
                      var liveResult = await sb.auth.getSession();
                      var liveSession = liveResult && liveResult.data && liveResult.data.session;
                      if (liveSession && liveSession.user && liveSession.user.id) {
                        if (liveSession.user.id !== jwtPayload.sub) {
                          // Mismatch — live client holds a different user.
                          // Prefer the live session and clear the stale domain cookies.
                          console.warn(
                            '[Auth.getSession] identity mismatch: fast-path uid=' + jwtPayload.sub +
                            ' live uid=' + liveSession.user.id + '. Clearing stale cookies.'
                          );
                          _clearStaleAuthCookies();
                          _writeLiveSessionToStorage(liveSession);
                          return liveSession;
                        }
                        // IDs match — fast-path is consistent with live session
                        return parsed;
                      }
                      // No live session user — fall through to network resolution path
                    } catch (e) { /* sb.auth.getSession() threw — fall through */ }
                  }
                }
              } catch (e) { /* JWT decode failed — fall through to network path */ }
            }
          }
        } catch (e) { /* malformed - ignore */ }
      }
    } catch (e) { /* storage blocked - fall through */ }

    var hasAuthInUrl = (typeof window !== 'undefined') && (
      window.location.hash.includes('access_token') ||
      window.location.search.includes('code=')
    );

    if (!hasStoredSession && !hasAuthInUrl) {
      return null;
    }

    return new Promise(function (resolve) {
      var resolved = false;
      var unsubscribe = null;
      function finish(session) {
        if (resolved) return;
        resolved = true;
        try { if (unsubscribe) unsubscribe(); } catch (e) { /* ignore */ }
        resolve(session || null);
      }

      try {
        var sub = sb.auth.onAuthStateChange(function (event, session) {
          if (session) {
            finish(session);
          } else if (event === 'INITIAL_SESSION' && !hasAuthInUrl && !session) {
            finish(null);
          }
        });
        if (sub && sub.data && sub.data.subscription && sub.data.subscription.unsubscribe) {
          unsubscribe = function () { sub.data.subscription.unsubscribe(); };
        }
      } catch (e) { /* subscription failed */ }

      try {
        sb.auth.getSession()
          .then(function (r) { if (r && r.data && r.data.session) finish(r.data.session); })
          .catch(function () {});
      } catch (e) {}

      setTimeout(function () {
        if (resolved) return;
        sb.auth.refreshSession()
          .then(function (r) {
            if (r && r.data && r.data.session) finish(r.data.session);
          })
          .catch(function () {});
      }, 6000);

      setTimeout(function () { if (!resolved) finish(null); }, 8000);
    });
  },


  /** Get current user */
  async getUser() {
    const session = await this.getSession();
    return session?.user || null;
  },

  /**
   * gh-397/#689 — E2E-test-signal predicate for claim-creation call sites.
   * Mirrors the CEO-approved contractor predicate (#543, see
   * supabase/functions/notify-contractors/test-exclusion.ts): an
   * @otterquote-internal.test address identifies an E2E/test actor. Used to
   * stamp claims.is_test at INSERT time so E2E writes against the live
   * BASE_URL never land as unflagged "real" claims. Case-insensitive,
   * null-safe.
   * @param {string|null|undefined} email
   * @returns {boolean}
   */
  isTestEmail(email) {
    return (email || '').trim().toLowerCase().endsWith('@otterquote-internal.test');
  },

  /**
   * Send magic link email with role-aware redirect.
   * @param {string} email
   * @param {string} role - 'homeowner' (default), 'contractor', 're_agent',
   *                        'insurance_agent', or 'home_inspector'
   * @param {string|null} redirectTo - Optional override for the redirect URL path
   *   (e.g. '/dashboard.html'). When provided, ignores role-based routing.
   *   Use this for returning-user login flows where the user already has a claim.
   */
  async sendMagicLink(email, role = 'homeowner', redirectTo = null) {
    if (!sb) throw new Error('Supabase not initialized');
    // Redirect URL depends on role — auth callback page handles final routing.
    // New users go to trade-selector (intake). Returning users should pass
    // redirectTo='/dashboard.html' to bypass the intake flow.
    // D-225 fix May 13: new contractors must land on /contractor-pre-approval.html,
    // not /contractor-dashboard.html. The pre-approval page reads cs_contractor_signup
    // from localStorage, creates the contractors row, and routes returning/active
    // contractors onward to the dashboard. Sending NEW signups directly to dashboard
    // caused a bounce loop (dashboard requireAuth -> no record -> bounce back).
    const defaultRedirectPage = role === 'contractor'
      ? '/contractor-pre-approval.html'
      : PARTNER_ROLES.includes(role)
        ? '/partner-dashboard.html'
        : '/auth-callback.html';
    const redirectPage = redirectTo || defaultRedirectPage;
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${CONFIG.SITE_URL}${redirectPage}`,
      }
    });
    if (error) throw error;
    return true;
  },

  /**
   * Sign in with Google OAuth.
   * D-207: Google OAuth as primary sign-in method.
   * @param {string} redirectPage - Path to redirect after auth (e.g. '/dashboard.html')
   */
  async signInWithGoogle(redirectPage = '/dashboard.html') {
    if (!sb) throw new Error('Supabase not initialized');
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${CONFIG.SITE_URL}${redirectPage}`,
      }
    });
    if (error) throw error;
  },

  /**
   * Sign in with email + password.
   * gh-880 Half A: primary sign-in method for the Partner App, replacing
   * magic-link as the primary path. Magic link's device-bound linkage was
   * the root cause of #594's cross-device attribution failures — a
   * password typed on the same device the app is open on removes that
   * failure class entirely. Homeowner/contractor surfaces are unaffected;
   * this and the three methods below exist for partner-login.html and the
   * partner signup pages only.
   * @param {string} email
   * @param {string} password
   * @returns {Promise<object|null>} the new session
   */
  async signInWithPassword(email, password) {
    if (!sb) throw new Error('Supabase not initialized');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  },

  /**
   * Sign up a new user with email + password, mirroring sendMagicLink's
   * role-aware redirect signature. gh-880 Half A signup audit: the 6
   * partner entry pages call this instead of sendMagicLink so the
   * referral_agents row register_partner() creates (still unlinked,
   * user_id NULL) is backed by a real credential from the first signup
   * instead of the password-less account magic-link used to create
   * implicitly.
   * NOTE: data.session comes back null when the Supabase project requires
   * email confirmation before first sign-in (or, by GoTrue design, when
   * the email already belongs to an existing account — this is the
   * anti-enumeration "fake success" case, not a coding error). Callers
   * must handle a null session the same way they already handle the
   * magic-link "check your email" state; do not assume signUp() always
   * yields an immediate session.
   * @param {string} email
   * @param {string} password
   * @param {string} role - partner agent_type, e.g. 're_agent'
   * @param {string|null} redirectTo - optional override, same contract as sendMagicLink
   */
  async signUpWithPassword(email, password, role = 'homeowner', redirectTo = null) {
    if (!sb) throw new Error('Supabase not initialized');
    const defaultRedirectPage = PARTNER_ROLES.includes(role)
      ? '/partner-dashboard.html'
      : '/auth-callback.html';
    const redirectPage = redirectTo || defaultRedirectPage;
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${CONFIG.SITE_URL}${redirectPage}` }
    });
    if (error) throw error;
    return data;
  },

  /**
   * Send a password-reset email. Distinct from sendMagicLink: this is the
   * secondary, expected-friction "Forgot password?" path (gh-880 Half A),
   * never the primary sign-in method. Supabase redirects the clicked link
   * back to redirectPage with a temporary recovery session; the page is
   * expected to listen for the PASSWORD_RECOVERY auth event and call
   * updatePassword() below to complete the flow.
   * @param {string} email
   * @param {string} redirectPage
   */
  async sendPasswordReset(email, redirectPage = '/partner-login.html?recovery=1') {
    if (!sb) throw new Error('Supabase not initialized');
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${CONFIG.SITE_URL}${redirectPage}`,
    });
    if (error) throw error;
    return true;
  },

  /**
   * Set a new password on the temporary recovery session Supabase
   * establishes after a password-reset email link redirect. Also used as
   * the completion step for a brand-new account created via
   * signUpWithPassword when email confirmation is required (same
   * updateUser() call — the difference is purely how the temporary
   * session was established, which Supabase handles transparently).
   * @param {string} newPassword
   */
  async updatePassword(newPassword) {
    if (!sb) throw new Error('Supabase not initialized');
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return true;
  },

  /**
   * gh-880 Half A: "already authenticated" check for partner surfaces —
   * true when a valid session exists AND its role is a partner
   * agent_type. Centralizes a check partner-app.html and several of the
   * partner signup pages already perform ad hoc with a locally-declared
   * partnerRoles array (same duplication gh-851 fixed for PARTNER_ROLES
   * itself) — new partner entry points get "skip the login screen when
   * already signed in" for free.
   * This only decides whether an EXISTING session should bypass a login
   * screen; it does not extend how long that session lives. Session
   * lifetime is still capped by the existing cookie infra (WebKit/ITP caps
   * every JS-written cookie at 7 days on iOS/Safari regardless of
   * Max-Age — see #867). True indefinite "stays signed in" trusted-device
   * persistence needs a server-set HttpOnly cookie from a Netlify edge
   * function (#867 Step 2) and is explicitly out of scope here (Half B) —
   * no caller of this method may present its true branch as a promise
   * that the device will never need to sign in again.
   * @returns {Promise<boolean>}
   */
  async hasPartnerSession() {
    const user = await this.getUser();
    if (!user) return false;
    const role = await this.getRole();
    return PARTNER_ROLES.includes(role);
  },

  /** Sign out */
  async signOut() {
    if (!sb) return;
    _clearStaleAuthCookies(); // parent-domain cookies (unchanged)
    _clearSentryUser();
    try {
      // scope:'local' avoids a network revoke that can throw and strand the
      // host-only sb_at cookie + skip the redirect (86e20pdta — mirrors React).
      await sb.auth.signOut({ scope: 'local' });
    } finally {
      try { document.cookie = 'sb_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT'; } catch (e) { /* non-fatal */ }
      window.location.href = '/index.html';
    }
  },

  /**
   * Check if user is authenticated, redirect to appropriate login if not.
   * @param {string} requiredRole - Optional. If set, also checks that the
   *   user's profile role matches. 'homeowner' or 'contractor'.
   */
  async requireAuth(requiredRole) {
    // In demo mode, skip auth redirect so reviewers can see all pages
    if (typeof CONFIG !== 'undefined' && CONFIG.DEMO_MODE) {
      const user = await this.getUser();
      return user || null; // Return null without redirecting
    }
    let user = await this.getUser();

    // Race guard (added May 4, 2026): if localStorage shows a stored session
    // but getUser() returned null, Supabase JS has not yet surfaced the
    // session — most commonly during the brief post-auth-callback window
    // where the session was just written to storage but the new page has
    // not finished initialization. Without this guard the page bounces to
    // login.html, which then bounces back if its own getUser succeeds —
    // producing the dashboard ↔ login flip Dustin reported May 4, 2026.
    // Poll up to 4 times at 500ms intervals (max 2s) before giving up.
    if (!user) {
      try {
        // D-212 — same adapter-aware read pattern as getSession().
        var raw = null;
        if (window.OtterQuoteCookieStorage) {
          raw = window.OtterQuoteCookieStorage.getItem(window.OTTERQUOTE_AUTH_STORAGE_KEY || 'sb-otterquote-auth');
        } else {
          var refMatch = (typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL ? CONFIG.SUPABASE_URL : '').match(/https:\/\/([^.]+)/);
          var ref = refMatch ? refMatch[1] : null;
          if (ref) raw = localStorage.getItem('sb-' + ref + '-auth-token');
        }
        var hasStored = false;
        if (raw) {
          try {
            var parsed = JSON.parse(raw);
            hasStored = !!(parsed && (parsed.access_token || parsed.refresh_token));
          } catch (e) {}
        }
        if (hasStored) {
          for (var i = 0; i < 4 && !user; i++) {
            await new Promise(function (r) { setTimeout(r, 500); });
            user = await this.getUser();
          }
        }
      } catch (e) { /* fall through to bounce */ }
    }

    if (!user) {
      sessionStorage.setItem('cs_redirect', window.location.pathname);
      // Send to the correct login page based on the page they tried to visit.
      // #598: partner pages previously fell through to /get-started.html, which
      // meta-refreshes to the PRODUCTION React homeowner onboarding — so an
      // expired partner session landed in the homeowner signup form, on
      // production, with no way back. Route partners to their own login gate.
      const path = window.location.pathname;
      const isContractorPage = path.includes('contractor');
      const isPartnerPage = _isPartnerSurfaceFile(path); // gh-807: shared with redirectToDashboard()
      window.location.href = isContractorPage
        ? '/contractor-login.html'
        : isPartnerPage
          ? '/partner-login.html'
          : '/get-started.html';
      return null;
    }

    // Successful auth resolution — identify the user in Sentry so error
    // events carry real user context instead of being anonymous (#408).
    _identifySentryUser(user);

    // Enforce role if specified — prevent homeowners on contractor pages and vice versa
    if (requiredRole) {
      const role = await this.getRole();
      if (role && role !== requiredRole) {
        // Redirect to the correct dashboard for this user's actual role.
        // gh-817/#643: getRole() can now return a partnerRoles value (see
        // getRole() above) — route those to partner-dashboard.html instead
        // of falling into the homeowner dashboard, the same structural gap
        // that caused the partner P0. No current caller passes a
        // requiredRole on a partner-*.html page (partner-dashboard.html
        // calls requireAuth() with no argument), so this branch is
        // defense-in-depth for any page that gains a role check later.
        if (role === 'contractor') {
          window.location.href = '/contractor-dashboard.html';
        } else if (PARTNER_ROLES.includes(role)) {
          window.location.href = '/partner-dashboard.html';
        } else {
          window.location.href = '/dashboard.html';
        }
        return null;
      }

      // gh-959 interim guard (pending #909 — profiles.role single-scalar
      // redesign, CEO-board Q4 decision). The mismatch branch above only
      // fires when getRole() resolves a TRUTHY role. When it resolves null —
      // profiles.role is null/unset AND neither the contractors lookup nor
      // the active-referral_agents lookup matched — this used to no-op
      // silently, so a user with an unresolved role who *lands* on a
      // contractor-required page (stale bookmark, shared link, direct URL
      // entry) simply stayed there with no way out. That's the #959
      // "land/stick... dead-end feel" symptom. This is a different gap from
      // the role==='contractor' branch above: that branch only runs once
      // getRole() has ALREADY positively confirmed a contractors row for
      // this user, so a membership check inserted there could never fire —
      // contractor identity is never "confirmed absent" at that point. This
      // block is the actual reachable gap: it only runs when role resolution
      // came back with no signal either way.
      //
      // Fail-open (D-211 precedent, PR #345): only divert when BOTH (a) an
      // active referral_agents membership is POSITIVELY confirmed and (b) a
      // contractors row is POSITIVELY confirmed absent. Any query error,
      // timeout, or ambiguity falls through unchanged — a real contractor
      // must never be stranded by this guard. Works regardless of which
      // #909 option (A-D) is eventually chosen, since it never reads
      // profiles.role. Remove once #909 lands. Refs #959.
      if (!role && requiredRole === 'contractor' && sb) {
        try {
          const { data: agent, error: agentErr } = await sb
            .from('referral_agents')
            .select('id')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .single();
          if (agent && !agentErr) {
            const { data: contractorRow, error: contractorErr } = await sb
              .from('contractors')
              .select('id')
              .eq('user_id', user.id)
              .single();
            const contractorConfirmedAbsent = !contractorRow && contractorErr && contractorErr.code === 'PGRST116';
            if (contractorConfirmedAbsent) {
              window.location.href = '/partner-dashboard.html';
              return null;
            }
          }
        } catch (e) { /* ambiguous — fall through, stay put (fail-open) */ }
      }
    }
    return user;
  },

  /** Listen for auth state changes */
  onAuthChange(callback) {
    if (!sb) return;
    sb.auth.onAuthStateChange((event, session) => {
      callback(event, session);
    });
  },

  /** Get user profile from profiles table */
  async getProfile() {
    const user = await this.getUser();
    if (!user) return null;
    const { data, error } = await sb
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();
    if (error) return null;
    return data;
  },

  /**
   * Get the user's role — database-driven to prevent email confusion.
   *
   * gh-909 (D-182 v113, 2026-08-19): this used to be an inline three-step
   * cascade (contractors -> referral_agents -> profiles.role) built up
   * across #817/#643/#851. That precedence now lives in
   * `public.resolved_user_role`, a read-only SECURITY INVOKER view scoped to
   * auth.uid() (see supabase/migrations/v113_derived_role_view.sql and
   * gh-909). This function's contract is unchanged — it still returns
   * 'contractor', a partner agent_type, 'homeowner', a raw profiles.role
   * value, or null — it just gets the answer from one query instead of
   * three, and profiles.role is no longer read directly here (the view
   * consults it as a fallback internally). Every case this function used to
   * resolve was branch-tested to return the identical value from the view
   * (see the migration's pre-flight doc); the one NEW behavior — a user with
   * no contractor/partner record who owns a claim now resolves 'homeowner'
   * even when profiles.role is unset — was explicitly approved 2026-08-19
   * (gh-909 comment 5346445233). Dual-role precedence (contractor beats an
   * active referral_agents membership) and surface-aware callers
   * (auth-callback.html's intent check, requireAuth()'s partner branch
   * below) are UNCHANGED — this migration relocates the FACT, not the
   * routing logic built on top of it.
   *
   * SECURITY: If a contractor record exists, that's still the source of
   * truth (now encoded in the view's precedence, not here). This prevents
   * homeowners from being misrouted as contractors and vice versa.
   */
  async getRole() {
    const user = await this.getUser();
    if (!user) return null;

    if (sb) {
      try {
        const { data, error } = await sb
          .from('resolved_user_role')
          .select('derived_role')
          .single();

        if (data && !error) {
          return data.derived_role || null;
        }
        // Any error (network, RLS, JWT expiry, unexpected 0 rows) — return
        // null rather than falling through to a possibly-stale value. Same
        // fail-closed handling the old contractor-lookup error branch used
        // (bug fix: May 7, 2026), now applied to the single view read.
        return null;
      } catch (e) {
        // Network/JS exception — return null, not a wrong-role fallthrough
        return null;
      }
    }

    // No Supabase client configured — last-resort fallback, unchanged from
    // pre-#909 (unreachable in practice: getProfile() itself requires `sb`).
    const profile = await this.getProfile();
    return profile?.role || null;
  },

  /**
   * Redirect an authenticated user to their role-appropriate dashboard.
   * Call this on pages like get-started.html when a user is already logged in.
   */
  async redirectToDashboard() {
    const user = await this.getUser();
    if (!user) return;

    const currentFile = window.location.pathname.substring(
      window.location.pathname.lastIndexOf('/') + 1
    );
    // gh-807: was `currentFile.indexOf('partner-') === 0`, narrower than
    // requireAuth()'s partner-surface definition — ref-*/recruit*/
    // refer-a-friend* pages fell through to role-based routing below and
    // could be bounced into the homeowner intake flow. Now shares the same
    // definition as requireAuth() via _isPartnerSurfaceFile().
    const onPartnerPage = _isPartnerSurfaceFile(window.location.pathname);

    // gh-817: cs_redirect is saved by requireAuth() on ANY earlier unauthenticated
    // page hit in this tab's session (e.g. a contractor page Dustin visited before
    // the partner magic-link login) and this shortcut used to run BEFORE the #783
    // partner-stay-put guard below — so a stale value could silently bounce a
    // just-completed partner login to an unrelated page. Reproduces the reported
    // symptom exactly: partner-dashboard.html renders, then a leftover
    // cs_redirect='/contractor-dashboard.html' from an earlier same-session
    // contractor-page visit fires this redirect. Discard the saved value instead
    // of honoring it once we're on a partner surface, unless the saved target
    // is itself a partner surface (legitimate deep-link-while-logged-out case).
    // gh-807: both sides of this check now use the shared partner-surface
    // definition (was `indexOf('partner-') === 0` on the saved target only).
    const savedRedirect = sessionStorage.getItem('cs_redirect');
    if (savedRedirect) {
      sessionStorage.removeItem('cs_redirect');
      const staleCrossSurface = onPartnerPage && !_isPartnerSurfaceFile(savedRedirect);
      if (staleCrossSurface) {
        console.warn('[Auth] redirectToDashboard: discarding stale cs_redirect=' + savedRedirect + ' — already on partner surface (' + currentFile + ')');
      } else {
        window.location.href = savedRedirect;
        return;
      }
    }

    // #643: never override the partner surface with role-based routing.
    // The two destinations below (contractor-dashboard.html, or the
    // homeowner dashboard.html/trade-selector.html pair) are the ONLY
    // targets this function knows — it has no partner branch. sendMagicLink()
    // already sent partner roles to /partner-dashboard.html via
    // emailRedirectTo, which IS the explicit "which app" signal; this
    // function used to discard that signal and re-derive a destination from
    // getRole() alone. getRole() is contractor-table-first, so any dual-role
    // account (contractor record + referral_agents record — e.g.
    // dustinstohler1@gmail.com) was bounced straight to
    // contractor-dashboard.html on first sign-in, and a partner-ONLY account
    // (no contractor record) was bounced to trade-selector.html/dashboard.html
    // instead — both wrong, because partner-dashboard.html was never a
    // candidate. handleAuthCallback() (invoked from the SIGNED_IN listener
    // partner-dashboard.html wires via onAuthStateChangeListener()) called
    // straight into this function, which is what fired the bounce
    // immediately after the magic-link redemption landed on the partner
    // dashboard. Staying put when already on a partner-*.html page fixes
    // both cases without touching contractor/homeowner routing.
    if (onPartnerPage) {
      return;
    }

    // Otherwise route by role
    const role = await this.getRole();
    if (role === 'contractor') {
      window.location.href = '/contractor-dashboard.html';
    } else if (PARTNER_ROLES.includes(role)) {
      // gh-851: this function had no partner branch at all -- every partner
      // agent_type fell into the homeowner-intake else below. Saved today
      // only by the onPartnerPage early-return above; a live gap for any
      // partner who reaches this function off a non-partner page. Not a
      // #842 regression -- pre-#842 a partner resolved to 'homeowner' via
      // getRole() and hit this same branch.
      window.location.href = '/partner-dashboard.html';
    } else {
      // Check if homeowner already has a claim in Supabase — if so, skip trade selector
      try {
        const { data: existingClaim } = await sb
          .from('claims')
          .select('id, status')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        if (existingClaim) {
          window.location.href = '/dashboard.html';
          return;
        }
      } catch (e) {
        // No existing claim — fall through to trade selector
      }
      // No claim yet — route to trade selector for new intake
      const tradeSelections = sessionStorage.getItem('oq_trade_selections');
      if (!tradeSelections) {
        window.location.href = '/trade-selector.html';
      } else {
        window.location.href = '/dashboard.html';
      }
    }
  },

  /** Update user profile */
  async updateProfile(updates) {
    const user = await this.getUser();
    if (!user) throw new Error('Not authenticated');
    const { data, error } = await sb
      .from('profiles')
      .upsert({ id: user.id, ...updates, updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  /**
   * Handle post-auth profile creation and routing.
   * Call this when user logs in via magic link to create their profile from signup data.
   */
  async handleAuthCallback() {
    const user = await this.getUser();
    if (!user) return;

    // Determine role: stored value > contractor record check > default homeowner
    let role = localStorage.getItem('cs_auth_role') || sessionStorage.getItem('cs_auth_role');

    // If no stored role, check if a contractor record exists for this user
    if (!role && sb) {
      try {
        const { data: contractor } = await sb
          .from('contractors')
          .select('id')
          .eq('user_id', user.id)
          .single();
        if (contractor) {
          role = 'contractor';
        }
      } catch (e) {
        // No contractor record — will default to homeowner below
      }
    }

    // Final fallback to homeowner
    if (!role) {
      role = 'homeowner';
    }

    // Handle partner (referral agent) account linkage.
    //
    // #594 / v97: link referral_agents.user_id to this auth user via the
    // claim_partner_account() SECURITY DEFINER RPC.
    //
    // This USED to be a client-side `.update().eq('email').is('user_id', null)`
    // gated on a `cs_partner_signup` localStorage breadcrumb. Both halves were
    // wrong:
    //   1. The update silently matched 0 rows — PostgreSQL applies SELECT
    //      policies to an UPDATE whose WHERE reads columns, and no SELECT
    //      policy on referral_agents exposes a `user_id IS NULL` row to a
    //      non-admin authenticated user. The "Authenticated can claim
    //      unclaimed partner record" policy is unreachable. (Same silent
    //      no-op class as #571.)
    //   2. Gating on localStorage meant a magic link opened on a different
    //      device than signup skipped the attempt entirely.
    //
    // The RPC derives BOTH identity and email from the JWT — no client-supplied
    // parameters — so calling it unconditionally is safe: a caller can only
    // ever claim a row matching their own verified email. Unauthenticated or
    // non-partner callers get {claimed:false} and nothing happens.
    if (sb) {
      try {
        const { data: claim, error: claimError } = await sb.rpc('claim_partner_account');
        if (claimError) {
          console.error('Error claiming partner account:', claimError);
        } else if (claim && claim.claimed) {
          console.log('Partner account linked:', claim.agent_id);
        }
      } catch (err) {
        console.error('Error handling partner account claim:', err);
      }
      // Breadcrumb is no longer load-bearing; clear it so it can't go stale.
      localStorage.removeItem('cs_partner_signup');
      sessionStorage.removeItem('cs_partner_signup');
    }

    // Handle homeowner signup data (check localStorage first, fall back to sessionStorage)
    const signupData = localStorage.getItem('cs_signup') || sessionStorage.getItem('cs_signup');
    // Never overwrite a contractor's profile with homeowner signup data (bug fix May 7, 2026)
    if (signupData && role !== 'contractor') {
      try {
        const data = JSON.parse(signupData);
        const fullName = `${data.first_name} ${data.last_name}`.trim();

        // Create or update profile
        await this.updateProfile({
          full_name: fullName,
          phone: data.phone || null,
          address_line1: data.address || null,
          role: data.role || 'homeowner',
          sms_consent_ts: data.sms_consent_ts || null,
        });

        localStorage.removeItem('cs_signup');
        sessionStorage.removeItem('cs_signup');
      } catch (err) {
        console.error('Error creating profile from signup data:', err);
      }
    }

    // Handle contractor signup data
    const contractorSignupData = localStorage.getItem('cs_contractor_signup') || sessionStorage.getItem('cs_contractor_signup');
    if (contractorSignupData) {
      try {
        const data = JSON.parse(contractorSignupData);

        // Update profile for contractor (non-blocking).
        // Fix #86e1b39u1: two bugs patched here:
        //   1. address_line1 is not a profiles column — correct column is address_street.
        //      The wrong name caused PostgREST to return 400, which previously aborted
        //      this entire try block before the contractors INSERT could run.
        //   2. Profile update now wrapped in its own try-catch so a failure here never
        //      blocks contractor record creation (the critical artifact).
        // Uses UPDATE (not upsert) — handle_new_user() trigger guarantees the profiles
        // row exists on every new signup via ON CONFLICT DO NOTHING insert.
        try {
          if (sb) {
            const { error: profileUpdateErr } = await sb
              .from('profiles')
              .update({
                full_name: data.contact_name || null,
                phone: data.phone || null,
                address_street: data.address_line1 || null,
                role: 'contractor',
                updated_at: new Date().toISOString(),
              })
              .eq('id', user.id);
            if (profileUpdateErr) {
              console.warn('[handleAuthCallback] contractor profile update failed (non-fatal):', profileUpdateErr);
            }
          }
        } catch (profileUpdateEx) {
          console.warn('[handleAuthCallback] contractor profile update threw (non-fatal):', profileUpdateEx);
        }

        // Create contractor record if it doesn't exist
        if (sb) {
          const { data: existing } = await sb
            .from('contractors')
            .select('id')
            .eq('user_id', user.id)
            .single();

          if (!existing) {
            // D-170: build the IC 24-5-11 attestation JSONB + top-level columns.
            // IP is stamped server-side via record_attestation_ip RPC below so
            // the client cannot spoof it.
            const attestation = data.attestation || null;
            const attestationPayload = attestation ? {
              text_version:          attestation.text_version || 'ic-24511-v1-2026-04',
              accepted:              true,
              accepted_client_ts:    attestation.accepted_client_ts || new Date().toISOString(),
              user_agent:            attestation.user_agent || navigator.userAgent,
              signer_name:           data.contact_name,
              signer_title:          data.signer_title || null,
              platform_agreement:    !!attestation.platform_agreement_ack,
              cancellation_policy:   !!attestation.cancellation_policy_ack,
            } : null;

            // Insert contractor record and get the new record's PK (id)
            const { data: newContractor, error: insertError } = await sb
              .from('contractors')
              .insert({
                user_id: user.id,
                company_name: data.company_name,
                contact_name: data.contact_name,
                email: data.email,
                phone: data.phone,
                address_line1: data.address_line1,
                address_city: data.address_city,
                address_state: data.address_state,
                address_zip: data.address_zip,
                website_url: data.website_url,
                years_in_business: data.years_in_business,
                num_employees: data.num_employees,
                no_license_required: data.no_license_required,
                // Signup fields stored in localStorage under different key names
                service_counties: data.service_counties || [],
                trades: data.trade_types || [],
                preferred_brands: data.shingle_brands || [],
                // Insurance flags derived from signup data
                has_workers_comp: !!(data.insurance_wc_carrier),
                has_general_liability: !!(data.insurance_gl_carrier),
                // D-170 attestation (top-level for indexing + hot-path gate)
                ic_24511_attestation:     attestationPayload || {},
                attestation_accepted_at:  attestationPayload ? new Date().toISOString() : null,
                attestation_signer_name:  attestationPayload ? data.contact_name : null,
                attestation_signer_title: data.signer_title || null,
                attestation_text_version: attestationPayload ? (attestationPayload.text_version) : null,
                // TCPA SMS consent
                sms_consent_ts: data.sms_consent_ts || null,
                // New contractors default to pending_approval status
                status: 'pending_approval',
              })
              .select('id')
              .single();

            if (insertError) {
              console.error('Error inserting contractor record:', insertError);
            } else {
              // D-170: stamp server-side IP onto the attestation (x-forwarded-for
              // captured by the RPC — can't be spoofed client-side). Non-fatal.
              if (attestationPayload && newContractor?.id) {
                try {
                  await sb.rpc('record_attestation_ip', { p_contractor_id: newContractor.id });
                } catch (ipErr) {
                  console.warn('record_attestation_ip RPC failed (non-fatal):', ipErr);
                }
              }

              // Send email notification for new contractor signup (pending_approval status)
              try {
                const signupMessage = `New contractor has signed up and is pending approval:

Company Name: ${data.company_name || '(not provided)'}
Contact Name: ${data.contact_name || '(not provided)'}
Email: ${data.email || user.email}
Phone: ${data.phone || '(not provided)'}

Status: pending_approval
Date: ${new Date().toISOString()}

Log in to the admin panel to review and approve this contractor.`;

                await fetch(`${window.location.origin}/functions/v1/send-support-email`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from_name: data.company_name || 'New Contractor',
                    from_email: data.email || user.email,
                    subject: 'New Contractor Signup — Pending Approval',
                    message: signupMessage
                  })
                });
              } catch (emailErr) {
                console.warn('Error sending signup notification email:', emailErr);
                // Don't fail signup if email fails
              }

              // Send welcome email to the contractor
              try {
                // D-220 P16 U1b: welcome email moved server-side to send-welcome-email.
                // The template + recipient now live in the Edge Function; the browser
                // passes only the contractor id and the caller's verified session JWT.
                const { data: { session: welcomeSession } } = await sb.auth.getSession();
                await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/send-welcome-email`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + (welcomeSession?.access_token || ''),
                    'apikey': CONFIG.SUPABASE_ANON,
                  },
                  body: JSON.stringify({ contractor_id: newContractor.id })
                });
              } catch (welcomeErr) {
                console.warn('Error sending contractor welcome email:', welcomeErr);
                // Non-fatal
              }
            }

            // Insert licenses using the contractor record's PK (not user.id)
            const contractorPk = newContractor?.id;
            if (contractorPk && data.licenses && data.licenses.length > 0) {
              const licenseRecords = data.licenses.map(lic => ({
                contractor_id: contractorPk,
                municipality: lic.municipality,
                license_number: lic.number,
                expiration_date: lic.expDate,
              }));
              await sb.from('contractor_licenses').insert(licenseRecords);
            }
          }

          // Upload insurance certificate files to Supabase Storage
          if (data.insurance_certs && data.insurance_certs.length > 0) {
            for (const cert of data.insurance_certs) {
              try {
                // Convert base64 back to binary
                const binaryStr = atob(cert.base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: cert.type });

                // Upload to contractor-documents/{user_id}/insurance/{filename}
                const filePath = `${user.id}/insurance/${cert.name}`;
                const { error: uploadError } = await sb.storage
                  .from('contractor-documents')
                  .upload(filePath, blob, {
                    contentType: cert.type,
                    upsert: true,
                  });

                if (uploadError) {
                  console.error('Failed to upload insurance cert:', cert.name, uploadError);
                } else {
                  console.log('Insurance cert uploaded:', filePath);
                }
              } catch (uploadErr) {
                console.error('Error uploading insurance cert:', cert.name, uploadErr);
              }
            }
          }
        }

      } catch (err) {
        console.error('Error creating contractor profile:', err);
      } finally {
        // Always clear the signup flag — even on failure — to prevent infinite retry on every dashboard load.
        localStorage.removeItem('cs_contractor_signup');
        sessionStorage.removeItem('cs_contractor_signup');
      }
    }

    // Advance referral status to 'registered' if homeowner arrived via referral link
    // #571: v95 SECURITY DEFINER RPC — the direct UPDATE always no-opped
    // against RLS (authenticated has no SELECT policy on referrals). The RPC
    // also stamps homeowner_email server-side from the verified JWT.
    // Bridge 2026-08-26 (P0): read the cross-subdomain cookie first. This code
    // also runs on app.otterquote.com, where the origin-scoped copies written
    // by ref.html on otterquote.com are simply not visible.
    const referralId = (window.OtterQuoteReferral
        ? window.OtterQuoteReferral.read().oq_referral_id
        : null)
      || localStorage.getItem('oq_referral_id')
      || sessionStorage.getItem('oq_referral_id');
    if (referralId && sb) {
      try {
        const { error: advanceError } = await sb
          .rpc('advance_referral_registered', { p_referral_id: referralId });
        if (advanceError) {
          console.error('Error advancing referral status:', advanceError);
        }
        // #567: keep the id under a claim-scoped key so the claim writer
        // (trade-selector) can stamp claims.referral_id, then clear the
        // advance-scoped keys so this block never re-runs.
        localStorage.setItem('oq_referral_id_for_claim', referralId);
        // Keep the cookie alive under the claim-scoped name so the claim
        // writer can still see it after a cross-origin hop.
        if (window.OtterQuoteReferral) {
          const kept = window.OtterQuoteReferral.read();
          window.OtterQuoteReferral.write({
            oq_referral_id: referralId,
            oq_referral_agent_id: kept.oq_referral_agent_id,
            oq_referral_code: kept.oq_referral_code
          });
        }
        localStorage.removeItem('oq_referral_id');
        sessionStorage.removeItem('oq_referral_id');
      } catch (err) {
        console.error('Error advancing referral status:', err);
      }
    }

    // Route to appropriate dashboard
    await this.redirectToDashboard();
  },

  /**
   * Set up listener for auth state changes.
   * Handles post-auth profile creation when user logs in.
   * Also keeps the sq_at cookie in sync for the Netlify edge gate (W4-P1).
   */
  onAuthStateChangeListener() {
    // Idempotent: safe to call from multiple pages or auto-init.
    if (this._listenerWired) return;
    if (!sb) return;
    this._listenerWired = true;
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        // User just signed in, create profile if needed
        await this.handleAuthCallback();
      }
    });
  },

  /**
   * Narrow, side-effect-free listener that ONLY keeps the sq_at cookie in sync
   * with the current Supabase session. Safe to auto-wire on every page that
   * loads auth.js. Distinct from onAuthStateChangeListener(): does NOT call
   * handleAuthCallback, does NOT redirect, does NOT touch profile/signup data.
   * Only writes a cookie. This is the piece the Netlify admin-auth-gate needs
   * to find a fresh access token regardless of which page the user has open.
   */
  async _getIsAdmin(user) {
    if (!user) return false;
    // Hardcode primary admin
    if (user.email === 'dustinstohler1@gmail.com') return true;
    // Check contractors.template_review_role
    try {
      const { data } = await sb
        .from('contractors')
        .select('template_review_role')
        .eq('user_id', user.id)
        .single();
      return data?.template_review_role === 'admin';
    } catch (_) {
      return false;
    }
  },

  /**
   * Set sb_at cookie with current Supabase access token.
   * Used by the Netlify admin-auth-gate edge function to verify admin
   * identity server-side before the HTML page is served.
   * Token is extracted from the access_token JWT; max-age is calculated
   * from the token's exp claim.
   */
  _setSingleAuthCookie(session) {
    if (session?.access_token) {
      try {
        const parts = session.access_token.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const maxAge = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
        document.cookie = `sb_at=${session.access_token}; path=/; SameSite=Lax; max-age=${maxAge}`;
      } catch (e) {
        // Malformed token — clear rather than leave stale
        document.cookie = 'sb_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      }
    } else {
      document.cookie = 'sb_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
  },

  ready() {
    if (this._readyPromise) return this._readyPromise;
    let _readyResolved = false;
    this._readyPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (!_readyResolved) {
          _readyResolved = true;
          reject(new Error('Auth.ready() timeout after 5s'));
        }
      }, 5000);

      const { data: { subscription } } = sb.auth.onAuthStateChange(async (event, session) => {
        if (_readyResolved) return;
        if (event === 'SIGNED_OUT') {
          _readyResolved = true;
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          reject(new Error('Auth.ready(): user signed out before session established'));
          return;
        }
        if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && session?.user) {
          _readyResolved = true;
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          try {
            const user = session.user;
            const role = await Auth.getRole();
            const isAdmin = await Auth._getIsAdmin(user);
            this._setSingleAuthCookie(session);
            // Successful auth resolution — identify the user in Sentry (#408).
            _identifySentryUser(user);
            resolve({ user, role, isAdmin });
          } catch (err) {
            reject(err);
          }
        } else if (event === 'INITIAL_SESSION' && !session?.user) {
          // No session — resolve with null so pages can redirect gracefully
          _readyResolved = true;
          clearTimeout(timeoutId);
          subscription.unsubscribe();
          resolve(null);
        }
      });
    });
    return this._readyPromise;
  },

// Auto-wire ONLY the cookie sync on every page that loads auth.js. Fixes the
// sq_at cookie going stale on every page other than get-started.html and
// partner-dashboard.html. Without this, TOKEN_REFRESHED events on most pages
// never reached _syncAdminCookie and admins were eventually bounced from
// /admin-*.html with reason=admin_required despite holding a valid session.
//
// IMPORTANT: We deliberately do NOT auto-wire onAuthStateChangeListener here.
// That listener also fires handleAuthCallback() on SIGNED_IN, which redirects
// the user — racing with the per-page post-auth routing in auth-callback.html
// and producing the contractor-dashboard / sign-in bounce loop. Pages that
// need full post-auth handling (get-started.html, partner-dashboard.html)
// continue to call onAuthStateChangeListener() explicitly.
}

// D-211: Auto-wire sb_at cookie refresh on TOKEN_REFRESHED.
// Auth.ready() sets it on initial session. This keeps it fresh across token rotations.
// Replaces the _initCookieSync listener removed in D-211 Phase 0.
if (typeof window !== 'undefined' && window.Auth && typeof sb !== 'undefined') {
  try {
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session?.access_token) {
        window.Auth._setSingleAuthCookie(session);
      } else if (event === 'SIGNED_OUT') {
        document.cookie = 'sb_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      }
    });
  } catch (e) { /* non-fatal */ }
}
