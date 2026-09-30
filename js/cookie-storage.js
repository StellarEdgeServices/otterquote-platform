/**
 * OtterQuote Cookie Storage Adapter v2 — D-212 cross-subdomain SSO fix
 * ClickUp 86e1bpk7b — Bug fix May 12, 2026
 *
 * Token-only cookie pattern. Extracts access_token + refresh_token from the
 * Supabase session JSON and writes them to two small cookies scoped to
 * .otterquote.com. The full session is reconstructed on read.
 *
 * Why this exists:
 *   v1 wrote the full session JSON (3796 raw / 4676 URL-encoded bytes) via
 *   document.cookie. That exceeds Chrome's per-cookie 4096-byte limit and
 *   the browser silently dropped the write. Only localStorage held the
 *   session, and localStorage is origin-scoped — so cross-subdomain SSO
 *   between otterquote.com and app.otterquote.com was broken for any user
 *   who logged in on one and traversed to the other.
 *
 * Architecture:
 *   - sb-otterquote-at  : access token (~900 URL-encoded bytes)
 *   - sb-otterquote-rt  : refresh token (~900 URL-encoded bytes)
 *   - Both at Domain=.otterquote.com; cross all *.otterquote.com hosts
 *   - localStorage dual-write under canonical key (sb-otterquote-auth) for
 *     same-origin fast-path reads and as a safety net if cookies are blocked
 *   - Transparent migration: getItem falls back to legacy keys so existing
 *     contractor sessions and pre-fix React app sessions are preserved
 *   - Write verification guard: after writing each cookie, reads it back
 *     and logs a warning if the browser silently dropped it. This catches
 *     the entire class of silent-drop failures that hid the v1 bug for months
 *
 * Used by:
 *   - Static stack (js/config.js) — wired via createClient { auth: { storage } }
 *   - React stack (react-app/app/lib/cookie-storage.ts) — TypeScript port
 *
 * Load order: BEFORE config.js in every HTML file that loads the Supabase client.
 */

(function () {
  'use strict';

  // Canonical storage key — both stacks agree on this name so SSO works.
  // Exposed for use by auth.js fast-path existence checks.
  var STORAGE_KEY = 'sb-otterquote-auth';
  window.OTTERQUOTE_AUTH_STORAGE_KEY = STORAGE_KEY;

  // Cookie names for the token-only cross-subdomain pattern.
  var COOKIE_ACCESS  = 'sb-otterquote-at';
  var COOKIE_REFRESH = 'sb-otterquote-rt';

  // Legacy storage keys consulted for purge + cookie-less fallback.
  // #488 follow-up: this file loads BEFORE config.js, so the project-ref key
  // MUST be computed lazily (at call time) — the old load-time IIFE never saw
  // CONFIG, the project-ref key never joined the list, and sign-out left a
  // resurrection seed in localStorage.
  function legacyKeys() {
    var keys = ['sb_at'];
    try {
      // Pattern scan instead of CONFIG-derivation: catches every Supabase
      // default-storage key regardless of script load order or environment.
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && /^sb-[a-z0-9]+-auth-token$/.test(k)) keys.push(k);
      }
    } catch (e) { /* localStorage blocked */ }
    return keys;
  }

  /** Parse a Supabase session JSON. Returns null if not a valid session. */
  function parseSession(jsonStr) {
    if (typeof jsonStr !== 'string' || !jsonStr) return null;
    try {
      var parsed = JSON.parse(jsonStr);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.access_token || !parsed.refresh_token) return null;
      var expSec = parsed.expires_at || null;
      if (!expSec) {
        var parts = parsed.access_token.split('.');
        if (parts.length === 3) {
          try {
            var payload = JSON.parse(atob(parts[1]));
            if (payload && payload.exp) expSec = payload.exp;
          } catch (e) { /* invalid JWT */ }
        }
      }
      return { access: parsed.access_token, refresh: parsed.refresh_token, expSec: expSec };
    } catch (e) {
      return null;
    }
  }

  /**
   * Reconstruct a Supabase session JSON string from access + refresh tokens.
   *
   * D-212 fix May 13, 2026 — populate the user object from JWT claims at
   * reconstruction time. Previous version set user:null on the assumption
   * Supabase would auto-fetch via getUser(); in practice, pages reading
   * session.user.id directly on init (e.g. contractor-bid-form.html) got
   * null and redirected to login. Decoding the JWT payload locally fills
   * the same fields Supabase would have written.
   */
  function reconstructSession(accessToken, refreshToken) {
    var expSec = null;
    var expiresIn = null;
    var user = null;
    try {
      var parts = accessToken.split('.');
      if (parts.length === 3) {
        var payload = JSON.parse(atob(parts[1]));
        if (payload) {
          if (payload.exp) {
            expSec = payload.exp;
            expiresIn = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
          }
          if (payload.sub) {
            var iatIso = payload.iat ? new Date(payload.iat * 1000).toISOString() : null;
            user = {
              id: payload.sub,
              email: payload.email || null,
              aud: payload.aud || 'authenticated',
              role: payload.role || 'authenticated',
              app_metadata: payload.app_metadata || {},
              user_metadata: payload.user_metadata || {},
              email_confirmed_at: payload.email_verified ? iatIso : null,
              phone: payload.phone || '',
              confirmed_at: payload.email_verified ? iatIso : null,
              last_sign_in_at: iatIso,
              created_at: iatIso,
              updated_at: iatIso,
              identities: payload.user_metadata && payload.user_metadata.identities ? payload.user_metadata.identities : []
            };
          }
        }
      }
    } catch (e) { /* invalid JWT — leave nulls */ }

    return JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expSec,
      expires_in: expiresIn,
      token_type: 'bearer',
      user: user
    });
  }

  /** Cookie Max-Age — outlive the access token so refresh can rotate it. */
  function getCookieMaxAge(expSec) {
    // gh-867: Supabase imposes no session time-box on this project (0 of
    // 26,396 session rows carry a not_after value) and refresh-token
    // rotation is healthy well past a week — the prior 7-day default was a
    // self-imposed cap with no backend requirement behind it, forcing weekly
    // magic-link re-auth. 400 days is Chrome's Max-Age ceiling (anything
    // larger is silently clamped); this does not invalidate existing
    // sessions — they pick up the longer window on their next token refresh.
    var defaultSec = 400 * 24 * 3600; // 400 days — Chrome's Max-Age ceiling
    if (!expSec) return defaultSec;
    var remaining = expSec - Math.floor(Date.now() / 1000);
    return Math.max(3600, Math.max(remaining, defaultSec));
  }

  /** Domain attribute — leading dot for cross-subdomain sharing. */
  function getCookieDomain() {
    if (typeof window === 'undefined') return '';
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '';
    if (host.endsWith('.otterquote.com') || host === 'otterquote.com') {
      return '; Domain=.otterquote.com';
    }
    return ''; // Netlify preview URLs — no cross-domain
  }

  function getSecureFlag() {
    if (typeof window === 'undefined') return '';
    return window.location.protocol === 'https:' ? '; Secure' : '';
  }

  function readCookie(key) {
    if (typeof document === 'undefined' || !document.cookie) return null;
    var pairs = document.cookie.split('; ');
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i];
      var eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      if (pair.substring(0, eqIdx) === key) {
        try { return decodeURIComponent(pair.substring(eqIdx + 1)); }
        catch (e) { return null; }
      }
    }
    return null;
  }

  function writeCookie(key, value, maxAge) {
    if (typeof document === 'undefined') return;
    var domain = getCookieDomain();
    var secure = getSecureFlag();
    document.cookie = key + '=' + encodeURIComponent(value) +
      '; Path=/' + domain +
      '; Max-Age=' + maxAge +
      '; SameSite=Lax' + secure;
  }

  function deleteCookie(key) {
    if (typeof document === 'undefined') return;
    var domain = getCookieDomain();
    document.cookie = key + '=; Path=/' + domain + '; Max-Age=0; SameSite=Lax';
    // Also clear any host-only same-named cookie from a prior version.
    document.cookie = key + '=; Path=/; Max-Age=0; SameSite=Lax';
  }

  /**
   * Write-verification guard: after writing a cookie, read it back and log
   * loudly if the browser dropped it silently. Stage 5 prevention for the
   * silent-drop class of bug. Does not throw — Supabase doesn't expect
   * setItem to throw — but surfaces the failure to console + monitoring.
   */
  function verifyWrite(key, expected, label) {
    var actual = readCookie(key);
    if (actual === null) {
      try {
        console.warn('[OtterQuoteCookieStorage] write verification FAILED for ' + key +
          ' (' + label + '). Cookie was silently dropped by the browser. ' +
          'Likely cause: size > 4096 bytes, blocked cookie, or browser policy. ' +
          'Token length: ' + (expected ? expected.length : 0) + ' chars. ' +
          'Falling back to localStorage; cross-subdomain SSO will fail.');
      } catch (e) { /* console may be unavailable */ }
      return false;
    }
    return true;
  }

  function readLegacy(callerKey) {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
      var direct = window.localStorage.getItem(callerKey);
      if (direct) return direct;
      var lk = legacyKeys();
      for (var i = 0; i < lk.length; i++) {
        var v = window.localStorage.getItem(lk[i]);
        if (v) return v;
      }
    } catch (e) { /* localStorage blocked */ }
    return null;
  }

  // #488 — cookie-usability probe (memoized per page load). When cookies are
  // blocked entirely the cookie cannot be canonical and localStorage remains
  // the only viable store; everywhere else, absent cookies mean signed out.
  var _cookiesUsable = null;
  function cookiesUsable() {
    if (_cookiesUsable !== null) return _cookiesUsable;
    try {
      document.cookie = 'oq-cookie-probe=1; Path=/; Max-Age=60; SameSite=Lax';
      _cookiesUsable = document.cookie.indexOf('oq-cookie-probe=') !== -1;
      document.cookie = 'oq-cookie-probe=; Path=/; Max-Age=0; SameSite=Lax';
    } catch (e) { _cookiesUsable = false; }
    return _cookiesUsable;
  }

  /**
   * gh-2162 review round 5: the round-4 fix guarded getItem/setItem/
   * removeItem with `key !== STORAGE_KEY` ('sb-otterquote-auth'), an
   * ALLOWLIST of exactly one key. That broke every page whose Supabase
   * client is js/config.js's own `_oqCreateSupabaseClient()`
   * (partner-login.html, the signup pages, and any page that doesn't also
   * load js/supabase-client.js) -- that call passes NO `storageKey`, so
   * supabase-js falls back to ITS OWN default, `sb-<project-ref>-auth-token`,
   * not the canonical key. Under the round-4 guard every session
   * getItem/setItem/removeItem from that client silently became
   * localStorage-only: no cross-subdomain cookies, and signOut no longer
   * cleared them either.
   *
   * Fixed as a DENYLIST instead: only the small, known set of AUXILIARY
   * keys supabase-js 2.112.4 derives from whatever storageKey a client
   * actually uses -- `${storageKey}-code-verifier`,
   * `${storageKey}-flow-<id>-code-verifier`, `${storageKey}-flows-code-verifier`
   * (all end in `-code-verifier`), and `${storageKey}-user` -- are ever
   * diverted to plain localStorage. Every other key, whether it's the
   * canonical `sb-otterquote-auth`, supabase-js's own default
   * `sb-<ref>-auth-token`, or anything else, keeps the exact pre-round-4
   * cookie-touching behavior. This does not require knowing what
   * storageKey a given client actually used.
   */
  function isAuxiliaryStorageKey(key) {
    return typeof key === 'string' &&
      (key.endsWith('-code-verifier') || key.endsWith('-user'));
  }

  /**
   * gh-1980 PR 1/3 ("[SECURITY, PKCE] Move Supabase auth to PKCE", #1931
   * artifact 3 / Marty's ruling on #1980) — preparatory factory refactor
   * ahead of PR 2 (storageKey convergence) and PR 3 (flowType: 'pkce' flip).
   *
   * REVIEW: FAIL (comment 5850347173, CTO RUN 42) on the first version of
   * this PR corrected the framing here: the key-awareness Marty's #1931
   * ruling actually required for PR 1 -- an auxiliary PKCE `-code-verifier`
   * (or `-user`) key must never read/write/clear the shared session
   * cookies, so a rejected updateUser()'s PKCE cleanup can't silently sign
   * a user out -- already shipped on `main` at commit
   * 3ced057 ("gh-2154 P-1: review round 5
   * — invert cookie-storage guard to a denylist of auxiliary keys"), via
   * isAuxiliaryStorageKey() above. This PR does NOT add that; it is a pure
   * structural refactor.
   *
   * createOtterQuoteCookieStorage(storageKey) builds a storage-adapter
   * instance. `storageKey` is accepted and validated but is NOT YET
   * consulted by any decision this instance makes -- isAuxiliaryStorageKey()
   * stays the generic suffix match (see its own docstring for why an
   * exact-key allowlist regresses the config.js-style clients that pass no
   * storageKey at all and fall back to supabase-js's own default
   * `sb-<ref>-auth-token`). `storageKey` is reserved for PR 2, which will
   * make it load-bearing once every construction site converges on one
   * key. `window.OtterQuoteCookieStorage` below is this factory called
   * once, for the canonical STORAGE_KEY -- so today's behavior is
   * unchanged byte-for-byte; the parameterization is purely additive.
   */
  function createOtterQuoteCookieStorage(storageKey) {
    // Reserved for PR 2 (storageKey convergence): validated eagerly so a
    // misconfigured call site fails at construction time, not on first use.
    // Not yet read by any getItem/setItem/removeItem decision below -- see
    // this function's docstring.
    if (typeof storageKey !== 'string' || !storageKey) {
      throw new Error('createOtterQuoteCookieStorage: storageKey must be a non-empty string');
    }
    return {
    getItem: function (key) {
      // gh-2162 review round 5: an auxiliary key (PKCE code-verifier, or the
      // separate `-user` cache key) is plain localStorage, never cookies --
      // see isAuxiliaryStorageKey() above for why this is a denylist, not an
      // allowlist keyed to one canonical STORAGE_KEY value.
      if (isAuxiliaryStorageKey(key)) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
      }

      // 1. Try canonical two-cookie format — cross-subdomain mechanism
      var at = readCookie(COOKIE_ACCESS);
      var rt = readCookie(COOKIE_REFRESH);
      if (at && rt) return reconstructSession(at, rt);

      // 2. Cookies are canonical (#488). If BOTH cookies are absent the user
      // is signed out — the per-origin localStorage copy must never resurrect
      // the session (or rewrite the domain-wide cookies): that silently signed
      // users back in as the previous account after a sign-out on the other
      // subdomain. Purge local copies so sign-out sticks everywhere. Only a
      // browser that cannot hold cookies at all falls back to localStorage.
      if (cookiesUsable()) {
        try { window.localStorage.removeItem(key); } catch (e) {}
        try {
          var purge = legacyKeys();
          for (var i = 0; i < purge.length; i++) {
            window.localStorage.removeItem(purge[i]);
          }
        } catch (e) {}
        return null;
      }

      // 3. Cookie-less browser fallback — localStorage is the only store left.
      try {
        var stored = window.localStorage.getItem(key);
        if (stored) return stored;
      } catch (e) { /* localStorage blocked */ }
      return readLegacy(key);
    },

    setItem: function (key, value) {
      // gh-2162 review round 5: auxiliary keys are plain localStorage, never
      // cookies -- see isAuxiliaryStorageKey() above.
      if (isAuxiliaryStorageKey(key)) {
        try { window.localStorage.setItem(key, value); } catch (e) {}
        return;
      }
      // Treat empty/null as a clear (Supabase normally uses removeItem,
      // but defensive against future SDK shifts).
      if (value === null || value === undefined || value === '') {
        this.removeItem(key);
        return;
      }
      var session = parseSession(value);
      if (!session) {
        // Unparseable payload — preserve in localStorage; do not write cookies.
        try { window.localStorage.setItem(key, value); } catch (e) {}
        return;
      }
      var maxAge = getCookieMaxAge(session.expSec);

      // Cookies (cross-subdomain mechanism)
      writeCookie(COOKIE_ACCESS,  session.access,  maxAge);
      writeCookie(COOKIE_REFRESH, session.refresh, maxAge);
      verifyWrite(COOKIE_ACCESS,  session.access,  'access_token');
      verifyWrite(COOKIE_REFRESH, session.refresh, 'refresh_token');

      // localStorage (same-origin fast-path + contractor backward-compat)
      try { window.localStorage.setItem(key, value); } catch (e) {}
    },

    removeItem: function (key) {
      // gh-2162 review round 4 (comment 5825170286): this used to delete the
      // session cookies + legacy keys for ANY key, canonical or not. Supabase
      // JS 2.112.4's `_updateUser` calls removeItem('<key>-code-verifier') on
      // an update-user error (e.g. a HIBP-rejected weak password) as part of
      // its PKCE cleanup — that is not a sign-out, but it wiped the whole
      // session anyway, leaving a P-1 partner (who has no known password)
      // permanently locked out of the only screen that lets them set one.
      // gh-2162 review round 5: only an AUXILIARY key (see
      // isAuxiliaryStorageKey() above) is a plain localStorage removeItem;
      // every other key -- the canonical session key OR whatever storageKey
      // a given client actually resolved to (e.g. supabase-js's own default
      // `sb-<ref>-auth-token` on js/config.js's client, which passes no
      // storageKey at all) -- keeps the pre-round-4 cookie-clearing behavior.
      if (isAuxiliaryStorageKey(key)) {
        try { window.localStorage.removeItem(key); } catch (e) {}
        return;
      }
      deleteCookie(COOKIE_ACCESS);
      deleteCookie(COOKIE_REFRESH);
      try { window.localStorage.removeItem(key); } catch (e) {}
      // Also clear legacy keys so signOut on either subdomain truly logs out.
      try {
        var lk2 = legacyKeys();
        for (var i = 0; i < lk2.length; i++) {
          window.localStorage.removeItem(lk2[i]);
        }
      } catch (e) {}
    }
    };
  }

  // Exposed so future call sites (PR 2's storageKey convergence) and tests
  // can build additional, independently-keyed instances without reaching
  // into this file's private helpers.
  window.createOtterQuoteCookieStorage = createOtterQuoteCookieStorage;

  // The canonical, page-global instance every existing <script> load order
  // still reads as window.OtterQuoteCookieStorage. Built from the factory
  // above for STORAGE_KEY -- identical object shape and behavior to the
  // pre-PR-1 hand-written singleton.
  window.OtterQuoteCookieStorage = createOtterQuoteCookieStorage(STORAGE_KEY);

  /* ─────────────────────────────────────────────────────────────────────
   * Referral attribution bridge — Bridge 2026-08-26 (P0)
   *
   * The referral chain was broken end-to-end and nothing surfaced it:
   *   ref.html (otterquote.com)  writes oq_referral_id / _agent_id / _code
   *                              to localStorage + sessionStorage
   *   trade-selector.html        meta-refreshes to app.otterquote.com
   *   react-app trade-selector   reads those keys from app-origin storage
   *
   * localStorage is ORIGIN-scoped, not domain-scoped, so the app origin read
   * empty every time. `claims.referral_id` was therefore never written, and
   * apply_referral_commission() walks exactly that column — meaning no partner
   * could ever be paid for a referral that converted. The auth tokens already
   * solved this same problem with .otterquote.com cookies (D-212); referral
   * attribution just never got the same treatment.
   *
   * gh-2062 (CEO ruling, issue comment 5874597169): the attribution window
   * is 30 days FROM THE PARTNER-LINK CLICK. The cookie carries the click time
   * (oq_referral_ts); write() only starts that clock when called with
   * { click: true } (ref*.html, on a fresh ?ref= visit, last click wins). Any
   * other write - the auth advance block, get-started - keeps the original
   * click time and sets Max-Age to the time REMAINING, so it can never re-arm
   * the window.
   *
   * UNDATED IDS (REVIEW: FAIL on PR #2321; CEO ruling, issue comment
   * 5880667348 - undated ids expire): an id with no click time on record anywhere (a pre-gh-2062 legacy
   * cookie, or a copy left by an undated write) has no click, so it has no
   * window - it is treated as EXPIRED. read() purges it and returns nothing;
   * a non-click write with no click on record writes NOTHING (no cookie, no
   * storage mirror). A click time is only ever stamped by a fresh click; it
   * is never backfilled.
   * ───────────────────────────────────────────────────────────────────── */
  var REFERRAL_KEYS      = ['oq_referral_id', 'oq_referral_agent_id', 'oq_referral_code'];
  var REFERRAL_COOKIE    = 'oq-ref';           // one cookie, JSON payload — all three ids are short
  var REFERRAL_TS_KEY    = 'oq_referral_ts';   // epoch-ms of the partner-link click
  var REFERRAL_MAX_AGE   = 60 * 60 * 24 * 30;  // 30 days, from the click
  // gh-2062 (REVIEW: FAIL 5881363760): the claim-scoped copy the auth advance
  // re-keys the id into. It has no clock of its own - it lives under the SAME
  // click clock: written only with a click on record, returned by read() only
  // inside the window, purged by clear() and by the expired/undated purge.
  var REFERRAL_CLAIM_KEY = 'oq_referral_id_for_claim';

  /** gh-2346: sessionStorage is PER TAB but the click clock (cookie +
   *  localStorage) is ONE per browser, so a newer click in another tab made
   *  this tab's older ids look in-window. Every mirror write therefore stamps
   *  the click time NEXT TO the ids in this tab's sessionStorage (same key
   *  name, different store); the ids are only trusted while that stamp is
   *  present, inside the 30 days, and equal to the click time now on record. */
  function sessionIdsTrusted(clickTs) {
    if (clickTs === null) return false;
    var stamp = null;
    try { stamp = Number(window.sessionStorage.getItem(REFERRAL_TS_KEY)); } catch (e) { return false; }
    if (!stamp || !isFinite(stamp)) return false;
    if ((Date.now() - stamp) > REFERRAL_MAX_AGE * 1000) return false;
    return stamp === clickTs;
  }

  /** Drop this tab's sessionStorage ids and their stamp. */
  function purgeSessionIds() {
    for (var i = 0; i < REFERRAL_KEYS.length; i++) {
      try { window.sessionStorage.removeItem(REFERRAL_KEYS[i]); } catch (e) {}
    }
    try { window.sessionStorage.removeItem(REFERRAL_TS_KEY); } catch (e) {}
  }

  /** Click time (epoch-ms) on record: cookie first, else the localStorage
   *  mirror. null when none (nothing armed, or a pre-gh-2062 legacy cookie). */
  function readReferralTs() {
    var ts = null;
    try {
      var raw = readCookie(REFERRAL_COOKIE);
      if (raw) ts = Number(JSON.parse(raw)[REFERRAL_TS_KEY]);
    } catch (e) {}
    if (!ts || !isFinite(ts)) {
      try { ts = Number(window.localStorage.getItem(REFERRAL_TS_KEY)); } catch (e) { ts = null; }
    }
    return ts && isFinite(ts) ? ts : null;
  }

  window.OtterQuoteReferral = {
    /** Persist referral ids to localStorage, sessionStorage AND a
     *  .otterquote.com cookie so app.otterquote.com can read them. */
    write: function (ids, opts) {
      if (!ids) return;
      var click = !!(opts && opts.click);
      var payload = {};
      for (var i = 0; i < REFERRAL_KEYS.length; i++) {
        var k = REFERRAL_KEYS[i];
        var v = ids[k];
        if (v === undefined || v === null || v === '') continue;
        payload[k] = String(v);
      }
      if (!Object.keys(payload).length) return;
      // Only a fresh partner-link click starts the clock; every other write
      // inherits the click time already on record. No click on record (or the
      // window already spent) => write NOTHING, so no undated mirror can exist.
      var ts = click ? Date.now() : readReferralTs();
      if (ts === null) return;
      var remaining = REFERRAL_MAX_AGE - Math.floor((Date.now() - ts) / 1000);
      if (remaining <= 0) return;
      for (var j = 0; j < REFERRAL_KEYS.length; j++) {
        var kk = REFERRAL_KEYS[j];
        // gh-2346: a key ABSENT from this write must not keep a PRIOR write's
        // value (partner A's agent/code beside partner B's id). Post-write
        // storage matches `ids` exactly, like the cookie and the React writer.
        if (payload[kk] === undefined) {
          try { window.localStorage.removeItem(kk); } catch (e) {}
          try { window.sessionStorage.removeItem(kk); } catch (e) {}
          continue;
        }
        try { window.localStorage.setItem(kk, payload[kk]); } catch (e) {}
        try { window.sessionStorage.setItem(kk, payload[kk]); } catch (e) {}
      }
      payload[REFERRAL_TS_KEY] = String(ts);
      try { window.localStorage.setItem(REFERRAL_TS_KEY, String(ts)); } catch (e) {}
      // gh-2346: this tab's own stamp, next to its ids.
      try { window.sessionStorage.setItem(REFERRAL_TS_KEY, String(ts)); } catch (e) {}
      try {
        writeCookie(REFERRAL_COOKIE, JSON.stringify(payload), remaining);
      } catch (e) {}
    },

    /** Persist the claim-scoped id (oq_referral_id_for_claim). No click time
     *  on record, or window spent => writes NOTHING (undated = expired). */
    writeClaimId: function (id) {
      if (!id) return;
      var ts = readReferralTs();
      if (ts === null || (Date.now() - ts) > REFERRAL_MAX_AGE * 1000) return;
      try { window.localStorage.setItem(REFERRAL_CLAIM_KEY, String(id)); } catch (e) {}
    },

    /** Read referral ids, cookie FIRST so a cross-origin hop still resolves.
     *  Returns an object with whichever of the three keys are available. */
    read: function () {
      var out = {};
      // Past the 30-day window (belt and braces over the cookie Max-Age, and
      // the only bound on the same-origin storage mirrors): nothing to return.
      var clickTs = readReferralTs();
      if (clickTs !== null && (Date.now() - clickTs) > REFERRAL_MAX_AGE * 1000) {
        this.clear();
        return out;
      }
      // A claim-scoped id with no click time on record is undated => expired.
      if (clickTs === null) {
        try { window.localStorage.removeItem(REFERRAL_CLAIM_KEY); } catch (e) {}
      }
      try {
        var raw = readCookie(REFERRAL_COOKIE);
        if (raw) {
          var parsed = JSON.parse(raw);
          for (var k in parsed) {
            if (k !== REFERRAL_TS_KEY && Object.prototype.hasOwnProperty.call(parsed, k)) out[k] = parsed[k];
          }
        }
      } catch (e) {}
      // gh-2346: this tab's sessionStorage ids are only trusted with their own
      // stamp, in the window, equal to the click time on record; otherwise a
      // newer click in another tab has superseded them - purge BEFORE the
      // gap-fill (and before any caller's raw sessionStorage fallback).
      if (!sessionIdsTrusted(clickTs)) purgeSessionIds();
      // Same-origin storage fills any gap and wins only where the cookie is silent.
      for (var i = 0; i < REFERRAL_KEYS.length; i++) {
        var key = REFERRAL_KEYS[i];
        if (out[key]) continue;
        try { out[key] = window.sessionStorage.getItem(key) || window.localStorage.getItem(key) || undefined; } catch (e) {}
        if (!out[key]) delete out[key];
      }
      // Undated id (no click time anywhere): no click, no window => expired.
      if (clickTs === null && Object.keys(out).length) {
        this.clear();
        return {};
      }
      // In-window claim-scoped id (the windowed fallback for the claim writers).
      if (clickTs !== null) {
        try {
          var claimId = window.localStorage.getItem(REFERRAL_CLAIM_KEY);
          if (claimId) out[REFERRAL_CLAIM_KEY] = claimId;
        } catch (e) {}
      }
      return out;
    },

    /** Clear attribution once it has been stamped onto a claim. */
    clear: function () {
      for (var i = 0; i < REFERRAL_KEYS.length; i++) {
        try { window.localStorage.removeItem(REFERRAL_KEYS[i]); } catch (e) {}
        try { window.sessionStorage.removeItem(REFERRAL_KEYS[i]); } catch (e) {}
      }
      try { window.sessionStorage.removeItem(REFERRAL_TS_KEY); } catch (e) {}
      try { window.localStorage.removeItem(REFERRAL_CLAIM_KEY); } catch (e) {}
      try { window.localStorage.removeItem(REFERRAL_TS_KEY); } catch (e) {}
      try { deleteCookie(REFERRAL_COOKIE); } catch (e) {}
    },

    _COOKIE: REFERRAL_COOKIE,
    _KEYS:   REFERRAL_KEYS,
    _MAX_AGE: REFERRAL_MAX_AGE
  };

  // ── gh-1980 PR 3/3 (re-scoped): PKCE for Google OAuth ONLY ──────────────────
  // Dustin, verbatim (#1980 comment 5889011351): "PKCE for Google only
  // (Recommended)". Emailed magic / recovery / confirmation links stay IMPLICIT
  // (#access_token fragments) so they keep working on any device.
  //
  // supabase-js 2.116.0 (auth-js GoTrueClient) selects the flow CLIENT-WIDE:
  //   * _getSessionFromURL throws "Not a valid implicit grant flow url." when a
  //     ?code= return reaches an implicit client, and "Not a valid PKCE flow
  //     url." when a #access_token fragment reaches a pkce client;
  //   * _isPKCECallback counts ?code= as a callback only if a code-verifier is in
  //     storage (<storageKey>-code-verifier, or <storageKey>-flow-<id>-code-verifier
  //     when an sb_flow_id param is present).
  // So (1) the shared client is built per page load: 'pkce' ONLY when this very URL
  // is a verifier-backed ?code= return (our own Google sign-in coming home; supabase-js
  // then exchanges the code natively and scrubs the URL), 'implicit' for everything
  // else; and (2) Google INITIATION uses a dedicated pkce client on a verifier-only
  // storage adapter (never the shared session), which writes the verifier under the
  // canonical storageKey where (1) reads it.
  function isCodeVerifierKey(key) {
    return typeof key === 'string' && /-code-verifier$/.test(key);
  }

  function flowTypeForPageLoad() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (!params.get('code')) return 'implicit';
      var flowId = params.get('sb_flow_id');
      if (flowId && window.localStorage.getItem(STORAGE_KEY + '-flow-' + flowId + '-code-verifier')) return 'pkce';
      return window.localStorage.getItem(STORAGE_KEY + '-code-verifier') ? 'pkce' : 'implicit';
    } catch (e) {
      return 'implicit';
    }
  }

  // Persists *-code-verifier keys (origin localStorage, via the shared adapter's
  // auxiliary-key routing); inert for everything else, so the OAuth-initiation
  // client can never read, write or clear the shared session cookies.
  function createVerifierOnlyStorage() {
    var real = window.OtterQuoteCookieStorage;
    return {
      getItem: function (key) { return isCodeVerifierKey(key) ? real.getItem(key) : null; },
      setItem: function (key, value) { if (isCodeVerifierKey(key)) real.setItem(key, value); },
      removeItem: function (key) { if (isCodeVerifierKey(key)) real.removeItem(key); }
    };
  }

  function createOAuthClient(url, anon) {
    return window.supabase.createClient(url, anon, {
      auth: {
        flowType: 'pkce',
        storageKey: window.OTTERQUOTE_AUTH_STORAGE_KEY || STORAGE_KEY,
        storage: createVerifierOnlyStorage(),
        detectSessionInUrl: false,
        autoRefreshToken: false
      }
    });
  }

  // Email-initiated calls (signUp confirmation, OTP, recovery) must never be PKCE-bound
  // (Ben, #1980 5889011351). On the one page load where the shared client is pkce (a
  // Google ?code= return, e.g. partner-insurance.html?g=1) they go through this explicitly
  // implicit client instead: same canonical storageKey + adapter, but it only initiates
  // (no URL detection, no token refresh).
  function createEmailClient(url, anon) {
    return window.supabase.createClient(url, anon, {
      auth: {
        flowType: 'implicit',
        storageKey: window.OTTERQUOTE_AUTH_STORAGE_KEY || STORAGE_KEY,
        storage: window.OtterQuoteCookieStorage,
        detectSessionInUrl: false,
        autoRefreshToken: false
      }
    });
  }

  window.OtterQuoteOAuthPkce = {
    createEmailClient: createEmailClient,
    flowTypeForPageLoad: flowTypeForPageLoad,
    createVerifierOnlyStorage: createVerifierOnlyStorage,
    createOAuthClient: createOAuthClient
  };

  // Constants exposed for diagnostics + contract tests.
  window.OtterQuoteCookieStorage._COOKIE_ACCESS   = COOKIE_ACCESS;
  window.OtterQuoteCookieStorage._COOKIE_REFRESH  = COOKIE_REFRESH;
  window.OtterQuoteCookieStorage._STORAGE_KEY     = STORAGE_KEY;
  window.OtterQuoteCookieStorage._getCookieMaxAge = getCookieMaxAge; // gh-867 test hook

})();
