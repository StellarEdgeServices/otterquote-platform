/**
 * OtterQuote — Navigation Component
 * Renders consistent header/footer across all pages.
 * Primary detection: URL-based (contractor in pathname).
 * Secondary correction: role-based (Auth.getRole) for pages where URL and role
 * may disagree — most notably contractor-about.html, which is a homeowner page
 * whose URL contains "contractor".
 */

/**
 * NAP (Name / Address / Phone) — single source of truth.
 * Locked values: D-237 (address, 2026-05-23), D-240 (phone, 2026-05-25).
 * Both the footer NAP block (renderFooter, below) and the RoofingContractor
 * JSON-LD (renderLocalBusinessSchema, below) render from this object —
 * do not hand-type these values anywhere else. (#757)
 */
const NAP = Object.freeze({
  name: CONFIG.SITE_NAME,                 // 'Otter Quotes' — canonical form used sitewide (footer, JSON-LD, legal copy)
  streetAddress: '3410 N High School Rd Ste G #102',
  addressLocality: 'Indianapolis',
  addressRegion: 'IN',
  postalCode: '46224',
  addressCountry: 'US',
  // Phone changed 2026-08-25, Dustin-directed ("Change the 844 number to
  // (317) 501-9215 for now"). Supersedes D-240's locked 844-875-3412 for
  // every VISIBLE surface — footer NAP, JSON-LD, and every tel: href that
  // renders from this object. The Twilio 844 line (CONFIG.TWILIO_PHONE)
  // stays configured and in service; it simply stops being advertised.
  phoneDisplay: '(317) 501-9215',
  phoneTelHref: 'tel:+13175019215',
  phoneE164: '+1-317-501-9215',           // machine-readable schema.org telephone field (E.164-normalized)
  email: 'info@otterquote.com',
  url: 'https://otterquote.com'
});

const Nav = {
  /**
   * Detect if current page is a contractor page (URL heuristic).
   * Retained for renderFooter(), which chooses its column set by URL.
   */
  _isContractorPage() {
    const path = window.location.pathname;
    // contractor-about.html is a homeowner-facing page (viewing a contractor's profile);
    // it must not be treated as a contractor portal page despite its URL.
    if (path.includes('contractor-about')) return false;
    return path.includes('contractor');
  },

  /**
   * Detect if current page is a partner entry/portal page. Matches
   * "partner-*" filenames plus partners.html (the profession gate, which is
   * the referral-partner path's front door). ref-*.html, recruit.html,
   * refer-a-friend.html serve homeowner/mixed audiences and are NOT partner
   * pages for nav purposes.
   */
  _isPartnerPage() {
    const file = this._currentFile();
    return file === 'partners.html' || file.startsWith('partner-');
  },

  /* ═══════════════════════════════════════════════════════════════════════
     TWO-TIER NAVIGATION
     Row 1 — role switcher: Homeowner · Contractor · Referral Partner.
             Always visible, always clickable, on every page.
     Row 2 — the nav for whichever role is active. Nothing from another
             role's world appears here.
     Role resolution order (first hit wins):
       1. <header id="site-header" data-role="..."> — a page declaring itself
       2. the URL (a contractor page is a contractor page)
       3. ?role= on the query string (role-switcher deep links)
       4. the visitor's last explicit choice (localStorage)
       5. homeowner
     An AUTHENTICATED role always overrides all of the above once auth
     resolves — see _updateNavLinksForRole(), called from _renderAuthSlot().
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * The referral_agents.agent_type values that mean "this account is a
   * referral partner." Declared ONCE here (the #851 defect class was this
   * exact array hardcoded in three places); _renderAuthSlot() and
   * _navRoleForAuthRole() both read it. 'customer' is deliberately absent —
   * a homeowner who refers a friend is still a homeowner in the nav.
   */
  PARTNER_AUTH_ROLES: ['re_agent', 'insurance_agent', 'home_inspector', 'adjuster', 'other'],

  _ROLE_TABS: [
    { role: 'homeowner',  label: 'Homeowner',        href: '/index.html' },
    { role: 'contractor', label: 'Contractor',       href: '/contractor-join.html' },
    { role: 'partner',    label: 'Referral Partner', href: '/partners.html' },
  ],

  /**
   * Row-2 link sets, per role, split guest/authed. `id` values match the
   * existing `data-active` attributes already written into every page's
   * <header> — do not rename one without the other.
   */
  _ROLE_NAV: {
    homeowner: {
      logoHref: '/index.html',
      guest: [
        { href: '/index.html',            label: 'Home',            id: 'home' },
        { href: '/how-it-works.html',     label: 'How It Works',    id: 'how-it-works' },
        { href: '/help-measurements.html',label: 'Measurements',    id: 'measurements' },
        { href: '/refer-a-friend.html',   label: 'Refer a Friend',  id: 'refer-a-friend' },
        { href: '/faq.html',              label: 'FAQ',             id: 'faq' },
      ],
      authed: [
        { href: '/dashboard.html',        label: 'My Project',      id: 'dashboard' },
        { href: '/how-it-works.html',     label: 'How It Works',    id: 'how-it-works' },
        { href: '/help-measurements.html',label: 'Measurements',    id: 'measurements' },
        { href: '/refer-a-friend.html',   label: 'Refer a Friend',  id: 'refer-a-friend' },
        { href: '/faq.html',              label: 'FAQ',             id: 'faq' },
      ],
    },
    contractor: {
      logoHref: '/contractor-join.html',
      logoHrefAuthed: '/contractor-dashboard.html',
      guest: [
        { href: '/contractor-join.html',          label: 'Join',          id: 'contractor-join' },
        { href: '/contractor-how-it-works.html',  label: 'How It Works',  id: 'how-it-works' },
        { href: '/tools.html',                    label: 'Tools',         id: 'tools' },
        { href: '/contractor-faq.html',           label: 'FAQ',           id: 'faq' },
      ],
      authed: [
        { href: '/contractor-dashboard.html',     label: 'Home',          id: 'home' },
        { href: '/contractor-opportunities.html', label: 'Opportunities', id: 'opportunities' },
        { href: '/contractor-profile.html',       label: 'Profile',       id: 'profile' },
        { href: '/contractor-settings.html',      label: 'Settings',      id: 'settings' },
        { href: '/contractor-auto-bids.html',     label: 'Auto Bids',     id: 'auto-bids' },
        { href: '/tools.html',                    label: 'Tools',         id: 'tools' },
        { href: '/contractor-how-it-works.html',  label: 'How It Works',  id: 'how-it-works' },
        { href: '/contractor-faq.html',           label: 'FAQ',           id: 'faq' },
      ],
    },
    partner: {
      logoHref: '/partners.html',
      logoHrefAuthed: '/partner-dashboard.html',
      guest: [
        { href: '/partners.html',          label: 'Partner Programs', id: 'partners' },
        { href: '/partner-app.html',       label: 'Partner App',      id: 'partner-app' },
        { href: '/faq.html',               label: 'FAQ',              id: 'faq' },
      ],
      authed: [
        { href: '/partner-dashboard.html', label: 'Dashboard',        id: 'partner-dashboard' },
        { href: '/partner-profile.html',   label: 'My Profile',       id: 'partner-profile' },
        { href: '/partners.html',          label: 'Programs',         id: 'partners' },
        { href: '/partner-app.html',       label: 'Get the App',      id: 'partner-app' },
        { href: '/faq.html',               label: 'FAQ',              id: 'faq' },
      ],
    },
  },

  _ROLE_STORAGE_KEY: 'oq_nav_role',

  /**
   * When the visitor last clicked a role tab, as epoch ms. An EXPLICIT
   * choice outranks the account role for a while — see _explicitRoleChoice().
   */
  _ROLE_EXPLICIT_KEY: 'oq_nav_role_at',

  /** How long an explicit role-tab click outranks the account role. */
  _ROLE_EXPLICIT_TTL_MS: 30 * 60 * 1000,

  _currentFile() {
    const path = window.location.pathname;
    const file = path.substring(path.lastIndexOf('/') + 1);
    // "/" and "/contractors/" style directory URLs resolve to their index
    return file || 'index.html';
  },

  _readStoredRole() {
    try {
      const v = window.localStorage.getItem(this._ROLE_STORAGE_KEY);
      return (v && this._ROLE_NAV[v]) ? v : null;
    } catch (_) { return null; }   // private mode / blocked storage
  },

  _storeRole(role) {
    if (!this._ROLE_NAV[role]) return;
    try {
      window.localStorage.setItem(this._ROLE_STORAGE_KEY, role);
      window.localStorage.setItem(this._ROLE_EXPLICIT_KEY, String(Date.now()));
    } catch (_) { /* non-fatal */ }
  },

  /**
   * The role the visitor DELIBERATELY chose, if that choice is still fresh.
   *
   * Why this exists (Dustin, 2026-08-25): signed in as a contractor, he
   * clicked "Homeowner" in row 1. The browser navigated to index.html — and
   * then the orange highlight snapped back to Contractor and row 2 stayed on
   * the contractor links, because _updateNavLinksForRole() treats the
   * account role as absolute. Correct for a contractor who wandered onto a
   * homeowner URL by accident; wrong for one who just asked to go there.
   * Signing out "fixed" it only because there was no account role left to win.
   *
   * A click is a statement of intent and beats inference for 30 minutes.
   * It never beats the URL: on contractor-profile.html you get the
   * contractor nav no matter what you last clicked.
   */
  _explicitRoleChoice() {
    try {
      const role = window.localStorage.getItem(this._ROLE_STORAGE_KEY);
      if (!role || !this._ROLE_NAV[role]) return null;
      const at = parseInt(window.localStorage.getItem(this._ROLE_EXPLICIT_KEY) || '0', 10);
      if (!at || (Date.now() - at) > this._ROLE_EXPLICIT_TTL_MS) return null;
      return role;
    } catch (_) { return null; }
  },

  /** Which role does the CURRENT page belong to, by URL? null = role-neutral. */
  _roleFromUrl() {
    const file = this._currentFile();
    if (this._isPartnerPage()) return 'partner';
    if (this._isContractorPage()) return 'contractor';
    // Explicitly homeowner-owned surfaces (everything a referred or
    // self-serve homeowner touches).
    // `login` added 2026-08-25. login.html is the HOMEOWNER sign-in page, but
    // it was missing from this list, so _roleFromUrl() returned null and the
    // nav fell through to the visitor's last stored role. A visitor who had
    // been on partner pages then arrived at the homeowner sign-in page and was
    // shown the partner nav — "Referral Partner" highlighted in row 1, and a
    // "Partner Login" button offered to a homeowner who was already on the
    // right login page. Confirmed live in Dustin's browser 2026-08-25.
    // partner-login.html and contractor-login.html are unaffected: the partner
    // and contractor URL checks above run first and claim them.
    if (/^(index|login|how-it-works|faq|dashboard|landing|help-|ref\.|ref-|refer-a-friend|repair-intake|color-selection|project-confirmation|contract-signing|bids|trade-selector|onboarding-demo)/.test(file)) {
      return 'homeowner';
    }
    // The tools-* family and the standalone product pages sell software TO
    // contractors ("Contractor Tools", CRM, Voice AI, Online Management).
    // They are reached from the contractor nav and belong to that role even
    // though their filenames carry no "contractor" prefix.
    if (/^(tools|oq-voice-ai|oqom-)/.test(file)) return 'contractor';
    return null;   // admin-*, legal, stellar-edge, recruit — role-neutral
  },

  /** Map an authenticated account role onto a nav role. */
  _navRoleForAuthRole(role) {
    if (role === 'contractor') return 'contractor';
    if (this.PARTNER_AUTH_ROLES.includes(role)) return 'partner';
    return 'homeowner';
  },

  _resolveRole() {
    const header = document.getElementById('site-header');
    const declared = header && header.dataset.role;
    if (declared && this._ROLE_NAV[declared]) return declared;

    const fromUrl = this._roleFromUrl();
    if (fromUrl) return fromUrl;

    try {
      const q = new URLSearchParams(window.location.search).get('role');
      if (q && this._ROLE_NAV[q]) return q;
    } catch (_) { /* ignore malformed query strings */ }

    return this._readStoredRole() || 'homeowner';
  },

  /** Row 1 — the role switcher. Present on every page, for every visitor. */
  _roleBarHTML(activeRole) {
    return `
      <div class="nav-roles">
        <div class="container nav-roles-inner">
          <span class="nav-roles-label">I'm a</span>
          <nav class="nav-roles-tabs" aria-label="Choose your role">
            ${this._ROLE_TABS.map(t => `
              <a href="${t.href}" class="nav-role-tab ${t.role === activeRole ? 'active' : ''}"
                 data-role="${t.role}"${t.role === activeRole ? ' aria-current="true"' : ''}>${t.label}</a>
            `).join('')}
          </nav>
        </div>
      </div>
    `;
  },

  /**
   * Remember an explicitly-clicked role BEFORE the browser navigates, so a
   * role-neutral destination (tools.html, terms.html) still shows the nav
   * the visitor just asked for.
   */
  _wireRoleBar() {
    document.querySelectorAll('.nav-role-tab').forEach(tab => {
      if (tab.dataset.wired === 'true') return;
      tab.dataset.wired = 'true';
      tab.addEventListener('click', () => this._storeRole(tab.dataset.role));
    });
  },

  /** Row 2 — the inner links for one role. */
  _roleLinks(role, isAuthed) {
    const cfg = this._ROLE_NAV[role] || this._ROLE_NAV.homeowner;
    return isAuthed ? cfg.authed : cfg.guest;
  },

  _roleLogoHref(role, isAuthed) {
    const cfg = this._ROLE_NAV[role] || this._ROLE_NAV.homeowner;
    return (isAuthed && cfg.logoHrefAuthed) ? cfg.logoHrefAuthed : cfg.logoHref;
  },

  /** Render the site header (role bar + role-scoped nav) */
  renderHeader(options = {}) {
    const { active = '', showAuth = true } = options;
    const nav = document.getElementById('site-header');
    if (!nav) return;

    const role = this._resolveRole();
    this._activeRole = role;
    const isContractor = (role === 'contractor');
    // Pre-auth render uses the guest link set; _updateNavLinksForRole()
    // re-renders row 2 the moment a real session resolves.
    const links = this._roleLinks(role, false);

    nav.innerHTML = `
      ${this._roleBarHTML(role)}
      <div class="nav-inner container">
        <a href="${this._roleLogoHref(role, false)}" class="nav-logo">
          <img src="/img/brand-assets/otter-icon.png" alt="Otter Quotes" class="nav-logo-icon" style="height:36px;width:auto;object-fit:contain;">
          <span class="nav-logo-text">${CONFIG.SITE_NAME}</span>
        </a>
        <div class="nav-links" id="nav-links">
          ${links.map(l => `
            <a href="${l.href}" class="nav-link ${active === l.id ? 'active' : ''}">${l.label}</a>
          `).join('')}
          ${showAuth ? '<div class="nav-mobile-auth" id="nav-mobile-auth-slot"></div>' : ''}
          ${!showAuth ? '<span id="nav-mobile-signout-slot"></span>' : ''}
        </div>
        <div class="nav-actions" id="nav-actions">
          ${showAuth ? '<div id="nav-auth-slot"></div>' : ''}
          ${!showAuth ? '<span id="nav-signout-slot"></span>' : ''}
        </div>
        <button class="nav-hamburger" id="nav-hamburger" aria-label="Menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    `;

    this._wireRoleBar();

    // Mobile hamburger toggle
    const hamburger = document.getElementById('nav-hamburger');
    const navLinks = document.getElementById('nav-links');
    if (hamburger && navLinks) {
      hamburger.addEventListener('click', () => {
        hamburger.classList.toggle('open');
        navLinks.classList.toggle('open');
      });
    }

    // Auth state
    if (showAuth) {
      this._renderAuthSlot();
    } else {
      // ── gh-2026-08-25 ─────────────────────────────────
      // data-auth="false" pages were stuck on the GUEST link set forever.
      // _renderAuthSlot() was the ONLY caller of _updateNavLinksForRole(),
      // and it bails at `if (!slot && !mobileSlot) return;` — which is
      // always true when showAuth is false, because the slot markup above
      // is never emitted. Net effect: a signed-in contractor on
      // contractor-profile.html saw "Join · How It Works · Tools · FAQ",
      // i.e. the recruitment nav, with no route to the rest of his own
      // account. Same defect on partner-dashboard.html. Reported by
      // Dustin 2026-08-25. The role correction is now independent of
      // whether the page renders auth buttons.
      this._applyAuthRole();
      // data-auth="false" pages (contractor-faq, contractor-how-it-works) are
      // public marketing pages inside the contractor path. They used to render
      // an unconditional "Log Out" control, so a signed-OUT visitor arriving
      // from the contractor nav was offered the one action they could not take.
      // Now the control appears only when there is a session to end.
      // (Widened 2026-08-25 from contractor-only to every role: partner
      // pages carry data-auth="false" too and had no sign-out at all.)
      this._renderSignOutSlotIfSignedIn();
    }
  },

  /**
   * Resolve the signed-in account's role and correct row 2 to match, with
   * no dependency on the auth-button slots existing. Safe to call on any
   * page; a no-op for signed-out visitors and for pages without auth.js.
   */
  async _applyAuthRole() {
    if (typeof Auth === 'undefined') return;
    try {
      const user = await Auth.getUser();
      if (!user) return;
      const role = await Auth.getRole();
      this._updateNavLinksForRole(role);
    } catch (_) { /* auth unavailable — the guest render already on screen is correct */ }
  },

  /** Fill the sign-out slots on data-auth="false" pages, but only for a real session. */
  async _renderSignOutSlotIfSignedIn() {
    const slot = document.getElementById('nav-signout-slot');
    const mobileSlot = document.getElementById('nav-mobile-signout-slot');
    if (!slot && !mobileSlot) return;
    if (typeof Auth === 'undefined') return;   // auth.js absent — guest is the safe assumption
    let user = null;
    try { user = await Auth.getUser(); } catch (_) { return; }
    if (!user) return;
    if (slot) {
      slot.innerHTML = '<button class="btn btn-sm btn-ghost" onclick="Auth.signOut()">Log Out</button>';
    }
    if (mobileSlot) {
      mobileSlot.innerHTML = '<a href="#" class="nav-link nav-mobile-cta-secondary" onclick="Auth.signOut(); return false;">Log Out</a>';
    }
  },

  /**
   * Called once auth resolves. An authenticated account's real role beats
   * every heuristic, so this re-renders row 2 and re-marks the role tab
   * wholesale rather than patching individual anchors — the previous
   * anchor-by-anchor patch left orphaned links whenever the corrected set
   * was shorter than the rendered one.
   */
  _updateNavLinksForRole(authRole) {
    if (!authRole) return;
    const authNavRole = this._navRoleForAuthRole(authRole);

    // A fresh, deliberate role-tab click outranks the account role — but only
    // on a page that does not already belong to a role. See
    // _explicitRoleChoice() for the reported symptom this fixes.
    const chosen = this._explicitRoleChoice();
    const urlRole = this._roleFromUrl();
    if (chosen && chosen !== authNavRole && (!urlRole || urlRole === chosen)) {
      // They are BROWSING another role's world, not managing an account in
      // it, so render that role's guest links. The auth slot still shows
      // their real dashboard button, which is their way back.
      this._applyRoleLinks(chosen, false);
      return;
    }

    this._applyRoleLinks(authNavRole, true);
  },

  /** Re-render row 2 (and the role tab + logo) for one role. */
  _applyRoleLinks(role, isAuthed) {
    const container = document.getElementById('nav-links');
    if (container) {
      const active = (document.getElementById('site-header') || {}).dataset?.active || '';
      const mobileAuthSlot = container.querySelector('#nav-mobile-auth-slot');
      const linksHTML = this._roleLinks(role, isAuthed).map(l => `
        <a href="${l.href}" class="nav-link ${active === l.id ? 'active' : ''}">${l.label}</a>
      `).join('');
      // Keep the mobile auth slot (it already holds rendered markup) and
      // replace only the link anchors around it.
      container.querySelectorAll('a.nav-link:not(.nav-mobile-cta):not(.nav-mobile-cta-secondary)')
               .forEach(a => a.remove());
      if (mobileAuthSlot) mobileAuthSlot.insertAdjacentHTML('beforebegin', linksHTML);
      else container.insertAdjacentHTML('afterbegin', linksHTML);
    }

    // Re-mark the active role tab.
    if (role !== this._activeRole) {
      this._activeRole = role;
      document.querySelectorAll('.nav-role-tab').forEach(tab => {
        const on = tab.dataset.role === role;
        tab.classList.toggle('active', on);
        if (on) tab.setAttribute('aria-current', 'true');
        else tab.removeAttribute('aria-current');
      });
      const logo = document.querySelector('.nav-logo');
      if (logo) logo.href = this._roleLogoHref(role, isAuthed);
    } else {
      const logo = document.querySelector('.nav-logo');
      if (logo) logo.href = this._roleLogoHref(role, isAuthed);
    }
  },

  /**
   * Guest (signed-out) call-to-action pair, scoped to the active role.
   * Before the two-tier nav this was hardcoded to "Get Started /
   * Contractor Login" on every page, which meant a real-estate agent on a
   * partner page was offered a contractor login. Declared once and used by
   * BOTH guest branches of _renderAuthSlot (the Auth-undefined defensive
   * path and the no-session path) so the two cannot drift.
   */
  _GUEST_CTA: {
    homeowner: {
      primary:   { href: 'https://app.otterquote.com/get-started', label: 'Get Started' },
      secondary: { href: '/login.html',                            label: 'Log In' },
    },
    contractor: {
      primary:   { href: '/contractor-join.html',  label: 'Join as a Contractor' },
      secondary: { href: '/contractor-login.html', label: 'Contractor Login' },
    },
    partner: {
      primary:   { href: '/partners.html',      label: 'Become a Partner' },
      secondary: { href: '/partner-login.html', label: 'Partner Login' },
    },
  },

  _guestAuthHTML(role) {
    const cta = this._GUEST_CTA[role] || this._GUEST_CTA.homeowner;
    return {
      desktop: `
        <a href="${cta.primary.href}" class="btn btn-sm btn-primary">${cta.primary.label}</a>
        <a href="${cta.secondary.href}" class="btn btn-sm btn-ghost">${cta.secondary.label}</a>
      `,
      mobile: `
        <a href="${cta.primary.href}" class="nav-link nav-mobile-cta">${cta.primary.label}</a>
        <a href="${cta.secondary.href}" class="nav-link nav-mobile-cta-secondary">${cta.secondary.label}</a>
      `,
    };
  },

  async _renderAuthSlot() {
    const slot = document.getElementById('nav-auth-slot');
    const mobileSlot = document.getElementById('nav-mobile-auth-slot');
    if (!slot && !mobileSlot) return;

    // Defensive guard: if auth.js hasn't loaded, render guest state and bail.
    // This prevents ReferenceError crashes on pages that include nav.js but
    // not auth.js (e.g. pure redirect pages). Guest state is correct fallback.
    if (typeof Auth === 'undefined') {
      const guest = this._guestAuthHTML(this._activeRole || this._resolveRole());
      if (slot) slot.innerHTML = guest.desktop;
      if (mobileSlot) mobileSlot.innerHTML = guest.mobile;
      return;
    }

    const user = await Auth.getUser();
    let desktopHTML, mobileHTML;

    if (user) {
      // Determine which dashboard to link to based on role
      const role = await Auth.getRole();

      // Correct nav links if URL detection disagrees with actual role
      // (e.g. homeowner on contractor-about.html, or contractor on a homeowner page)
      this._updateNavLinksForRole(role);

      // Single source: Nav.PARTNER_AUTH_ROLES (see its declaration — the #851
      // defect class was this array hardcoded in three places).
      const partnerRoles = this.PARTNER_AUTH_ROLES;
      const dashboardUrl = role === 'contractor'
        ? '/contractor-dashboard.html'
        : partnerRoles.includes(role)
          ? '/partner-dashboard.html'
          : '/dashboard.html';
      const dashboardLabel = role === 'contractor'
        ? 'Contractor Portal'
        : partnerRoles.includes(role)
          ? 'Partner Dashboard'
          : 'My Dashboard';
      desktopHTML = `
        <a href="${dashboardUrl}" class="btn btn-sm btn-primary">${dashboardLabel}</a>
        <button class="btn btn-sm btn-ghost" onclick="Auth.signOut()">Sign Out</button>
      `;
      mobileHTML = `
        <a href="${dashboardUrl}" class="nav-link nav-mobile-cta">${dashboardLabel}</a>
        <a href="#" class="nav-link nav-mobile-cta-secondary" onclick="Auth.signOut(); return false;">Sign Out</a>
      `;
    } else {
      const guest = this._guestAuthHTML(this._activeRole || this._resolveRole());
      desktopHTML = guest.desktop;
      mobileHTML = guest.mobile;
    }

    if (slot) slot.innerHTML = desktopHTML;
    if (mobileSlot) mobileSlot.innerHTML = mobileHTML;
  },

  /** Inject support modal + floating button for contractor pages */
  _renderSupportModal() {
    if (document.getElementById('support-modal-overlay')) return; // already rendered

    const overlay = document.createElement('div');
    overlay.id = 'support-modal-overlay';
    overlay.style.cssText = `
      display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;
      align-items:center;justify-content:center;padding:1rem;
    `;

    overlay.innerHTML = `
      <div id="support-modal" style="
        background:#0f2533;border:1px solid rgba(224,123,0,.25);border-radius:12px;
        padding:2rem;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,.5);
        position:relative;
      ">
        <button id="support-modal-close" aria-label="Close" style="
          position:absolute;top:.75rem;right:.75rem;background:none;border:none;
          color:#94a3b8;font-size:1.25rem;cursor:pointer;line-height:1;padding:.25rem .5rem;
        ">&times;</button>
        <h3 style="color:#fff;margin:0 0 .25rem;font-size:1.1rem;">Contact Support</h3>
        <p style="color:#94a3b8;font-size:.85rem;margin:0 0 1.25rem;">
          Questions, concerns, or feedback? We respond within 24 hours.
        </p>
        <div id="support-form-wrap">
          <form id="support-contact-form" novalidate>
            <div style="margin-bottom:.75rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-name">Your Name</label>
              <input id="sc-name" type="text" required autocomplete="name"
                style="width:100%;padding:.5rem .75rem;background:#0D1B2E;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;box-sizing:border-box;"
                placeholder="Mike Reynolds">
            </div>
            <div style="margin-bottom:.75rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-email">Your Email</label>
              <input id="sc-email" type="email" required autocomplete="email"
                style="width:100%;padding:.5rem .75rem;background:#0D1B2E;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;box-sizing:border-box;"
                placeholder="you@company.com">
            </div>
            <div style="margin-bottom:.75rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-subject">Subject (optional)</label>
              <input id="sc-subject" type="text"
                style="width:100%;padding:.5rem .75rem;background:#0D1B2E;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;box-sizing:border-box;"
                placeholder="e.g. Question about my bid">
            </div>
            <div style="margin-bottom:.75rem;">
              <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.85rem;color:#94a3b8;user-select:none;">
                <input type="checkbox" id="sc-bug-report"
                  style="width:1rem;height:1rem;accent-color:#E07B00;cursor:pointer;flex-shrink:0;">
                I'm reporting a bug on this page
              </label>
            </div>
            <div style="margin-bottom:1rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-message">Message</label>
              <textarea id="sc-message" required rows="4"
                style="width:100%;padding:.5rem .75rem;background:#0D1B2E;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;resize:vertical;box-sizing:border-box;"
                placeholder="Describe your question or issue..."></textarea>
            </div>
            <p id="sc-error" style="color:#f87171;font-size:.8rem;margin:0 0 .75rem;display:none;"></p>
            <button type="submit" id="sc-submit"
              style="width:100%;padding:.65rem 1rem;background:#E07B00;color:#fff;border:none;
                border-radius:6px;font-size:.9rem;font-weight:600;cursor:pointer;">
              Send Message
            </button>
          </form>
        </div>
        <div id="support-success" style="display:none;text-align:center;padding:1rem 0;">
          <div style="font-size:2rem;margin-bottom:.5rem;">✅</div>
          <p style="color:#fff;font-weight:600;margin:0 0 .25rem;">Message sent!</p>
          <p style="color:#94a3b8;font-size:.85rem;margin:0;">We'll get back to you within 24 hours.</p>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Floating help button
    const fab = document.createElement('button');
    fab.id = 'support-fab';
    fab.setAttribute('aria-label', 'Contact Support');
    fab.style.cssText = `
      position:fixed;bottom:1.5rem;right:1.5rem;z-index:9998;
      background:#E07B00;color:#fff;border:none;border-radius:50px;
      padding:.65rem 1.1rem;font-size:.85rem;font-weight:600;
      cursor:pointer;box-shadow:0 4px 16px rgba(224,123,0,.4);
      display:flex;align-items:center;gap:.4rem;
    `;
    fab.innerHTML = `<span style="font-size:1rem;">💬</span> Contact Support`;
    document.body.appendChild(fab);

    // Wire up open/close
    const open  = () => { overlay.style.display = 'flex'; };
    const close = () => {
      overlay.style.display = 'none';
      document.getElementById('support-success').style.display = 'none';
      document.getElementById('support-form-wrap').style.display = '';
      document.getElementById('support-contact-form').reset();
      document.getElementById('sc-error').style.display = 'none';
      // Reset bug-report checkbox (form.reset() handles it, but be explicit)
      document.getElementById('sc-bug-report').checked = false;
    };
    fab.addEventListener('click', open);
    document.getElementById('support-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Bug-report checkbox: auto-fill subject + message with page context
    const bugCheckbox  = document.getElementById('sc-bug-report');
    const subjectInput = document.getElementById('sc-subject');
    const msgInput     = document.getElementById('sc-message');
    bugCheckbox.addEventListener('change', () => {
      if (bugCheckbox.checked) {
        const pageName = window.location.pathname.split('/').pop() || window.location.pathname;
        const pageUrl  = window.location.href;
        if (!subjectInput.value.trim()) {
          subjectInput.value = `Bug Report — ${pageName}`;
        }
        if (!msgInput.value.trim()) {
          msgInput.value = `I found a bug on this page: ${pageUrl}\n\nDescription:\n`;
          msgInput.focus();
          msgInput.setSelectionRange(msgInput.value.length, msgInput.value.length);
        }
      }
    });

    // Form submit
    document.getElementById('support-contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name      = document.getElementById('sc-name').value.trim();
      const email     = document.getElementById('sc-email').value.trim();
      const subject   = document.getElementById('sc-subject').value.trim();
      const message   = document.getElementById('sc-message').value.trim();
      const isBugRpt  = document.getElementById('sc-bug-report').checked;
      const errEl     = document.getElementById('sc-error');
      const btn       = document.getElementById('sc-submit');

      errEl.style.display = 'none';
      if (!name || !email || !message) {
        errEl.textContent = 'Please fill in your name, email, and message.';
        errEl.style.display = 'block';
        return;
      }

      // If it's a bug report, ensure the page URL is always in the email body
      // (in case the user edited it out) and prefix the subject clearly.
      const pageUrl      = window.location.href;
      const pageName     = window.location.pathname.split('/').pop() || window.location.pathname;
      const finalSubject = isBugRpt
        ? (subject || `Bug Report — ${pageName}`)
        : subject;
      const urlLine      = `\n\n---\nPage: ${pageUrl}`;
      const finalMessage = isBugRpt
        ? (message.includes(pageUrl) ? message : message + urlLine)
        : message;

      btn.disabled = true;
      btn.textContent = 'Sending…';

      try {
        const SUPABASE_URL  = (typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL)  || '';
        const SUPABASE_ANON = (typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_ANON) || '';

        const res = await fetch(`${SUPABASE_URL}/functions/v1/send-support-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization': `Bearer ${SUPABASE_ANON}`,
          },
          body: JSON.stringify({ from_name: name, from_email: email, subject: finalSubject, message: finalMessage }),
        });

        if (!res.ok) throw new Error('Send failed');

        document.getElementById('support-form-wrap').style.display = 'none';
        document.getElementById('support-success').style.display = 'block';
      } catch {
        errEl.textContent = 'Something went wrong. Please email info@otterquote.com or call (317) 501-9215.';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Send Message';
      }
    });
  },

  /** Render the site footer */
  renderFooter() {
    const footer = document.getElementById('site-footer');
    if (!footer) return;

    const isContractor = this._isContractorPage();

    footer.innerHTML = `
      <div class="footer-inner container">
        <div class="footer-grid">
          <div class="footer-col">
            <div class="footer-logo">
              <img src="/img/brand-assets/otter-icon.png" alt="Otter Quotes" class="nav-logo-icon" style="height:36px;width:auto;object-fit:contain;">
              <span class="nav-logo-text">${CONFIG.SITE_NAME}</span>
            </div>
            <p class="footer-tagline">${isContractor
              ? 'Your sales team — without the truck, the manager, or the advance.'
              : 'Helping homeowners get the best deal on roofing and exterior projects.'
            }</p>
            <address class="footer-nap" style="font-style:normal;margin-top:0.75rem;font-size:0.8rem;color:#94a3b8;line-height:1.6;">
              ${NAP.streetAddress},<br>${NAP.addressLocality} ${NAP.addressRegion} ${NAP.postalCode}<br>
              <a href="${NAP.phoneTelHref}" style="color:#E07B00;">${NAP.phoneDisplay}</a><br>
              <a href="mailto:${NAP.email}" style="color:#E07B00;">${NAP.email}</a>
            </address>
          </div>
          <div class="footer-col">
            <h4 class="footer-heading">${isContractor ? 'Contractor Portal' : 'Platform'}</h4>
            ${isContractor ? `
              <a href="/contractor-how-it-works.html">How It Works</a>
              <a href="/contractor-faq.html">FAQ</a>
              <a href="/contractor-opportunities.html">Browse Opportunities</a>
              <a href="/tools.html">Contractor Tools</a>
              <a href="/blog/index.html">Blog</a>
              <a href="/guides/">Guides</a>
            ` : `
              <a href="/how-it-works.html">How It Works</a>
              <a href="/faq.html">FAQ</a>
              <a href="https://app.otterquote.com/get-started">Get Started</a>
              <a href="/blog/index.html">Blog</a>
              <a href="/guides/">Guides</a>
            `}
          </div>
          <div class="footer-col">
            <h4 class="footer-heading">${isContractor ? 'Your Account' : 'Contractors'}</h4>
            ${isContractor ? `
              <a href="/contractor-dashboard.html">Dashboard</a>
              <a href="/contractor-profile.html">Company Profile</a>
              <a href="/contractor-agreement.html">Partner Agreement</a>
              <a href="#" id="footer-support-link" style="color:#E07B00;font-weight:600;">💬 Contact Support</a>
            ` : `
              <a href="/contractor-join.html">Join Our Network</a>
              <a href="/contractor-login.html">Contractor Login</a>
              <a href="/tools.html">Contractor Tools</a>
              <a href="/contractor-agreement.html">Partner Agreement</a>
            `}
          </div>
          ${!isContractor ? `
          <div class="footer-col">
            <h4 class="footer-heading">Partners</h4>
            <a href="/partner-re.html">Real Estate Agents</a>
            <a href="/partner-insurance.html">Insurance Agents</a>
            <a href="/partner-inspectors.html">Home Inspectors</a>
            <a href="/partner-adjusters.html">Adjusters</a>
            <a href="/partner-other.html">Other Industries</a>
            <a href="/partner-dashboard.html">Partner Dashboard</a>
            <a href="/refer-a-friend.html">Refer a Friend</a>
          </div>
          ` : ''}
          <div class="footer-col">
            <h4 class="footer-heading">Legal</h4>
            <a href="/terms.html">Terms of Service</a>
            <a href="/privacy.html">Privacy Policy</a>
            <!-- Moved out of the partner header nav 2026-08-25 (Dustin: "Does the
                 agreement need its own button on our header or can it be in the
                 disclaimers at the bottom?"). It is a reference document, not a
                 destination — it was spending a header slot that the partner's
                 actual account surfaces needed. Reachable from every page here,
                 and linked again inline at the point of acceptance on the
                 partner signup form, which is where it legally matters. -->
            <a href="/partner-agreement.html">Partner Agreement</a>
          </div>
        </div>
        <div class="footer-bottom">
          <p>&copy; ${new Date().getFullYear()} ${CONFIG.SITE_NAME}. All rights reserved.</p>
        </div>
      </div>
    `;

    // Contractor pages: inject support modal + FAB, wire footer link
    if (isContractor) {
      this._renderSupportModal();
      // Wire footer "Contact Support" link after DOM settles
      requestAnimationFrame(() => {
        const footerLink = document.getElementById('footer-support-link');
        if (footerLink) {
          footerLink.addEventListener('click', (e) => {
            e.preventDefault();
            const overlay = document.getElementById('support-modal-overlay');
            if (overlay) overlay.style.display = 'flex';
          });
        }
      });
    }
  },

  /**
   * Inject RoofingContractor JSON-LD (D-237/D-240 NAP) into an opt-in mount
   * point. Pages opt in with <script type="application/ld+json"
   * id="nap-schema-mount"></script> — absent on most pages by design, so this
   * only renders on pages that deliberately host the business entity schema
   * (index.html for now). Rendered from the single NAP source above, so the
   * machine copy can never drift from the visible footer NAP. (#757)
   */
  renderLocalBusinessSchema() {
    const mount = document.getElementById('nap-schema-mount');
    if (!mount) return;
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'RoofingContractor',
      name: NAP.name,
      url: NAP.url,
      telephone: NAP.phoneE164,
      address: {
        '@type': 'PostalAddress',
        streetAddress: NAP.streetAddress,
        addressLocality: NAP.addressLocality,
        addressRegion: NAP.addressRegion,
        postalCode: NAP.postalCode,
        addressCountry: NAP.addressCountry
      }
    };
    mount.textContent = JSON.stringify(schema, null, 2);
  }
};

// #562: staging banner — this environment shares the production database
// (see #696 for the unresolved separation decision), and app-subdomain /
// OAuth handoffs still land on production, so anyone testing here needs a
// standing visual reminder rather than discovering it mid-flow.
function _renderStagingBanner() {
  if (typeof CONFIG === 'undefined' || !CONFIG.IS_STAGING) return;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#B45309;color:#fff;' +
    'font:600 0.8rem/1.4 var(--font-body, sans-serif);text-align:center;padding:6px 12px;';
  bar.textContent = 'STAGING — shares the production database. App-subdomain and OAuth sign-in redirects still land on production.';
  document.body.insertBefore(bar, document.body.firstChild);
}

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  _renderStagingBanner();

  // Look for data attributes on header/footer elements
  const header = document.getElementById('site-header');
  if (header) {
    Nav.renderHeader({
      active: header.dataset.active || '',
      showAuth: header.dataset.auth !== 'false'
    });
  }

  const footer = document.getElementById('site-footer');
  if (footer) {
    Nav.renderFooter();
  }

  Nav.renderLocalBusinessSchema();
});
