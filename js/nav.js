/**
 * OtterQuote — Navigation Component
 * Renders consistent header/footer across all pages.
 * Primary detection: URL-based (contractor in pathname).
 * Secondary correction: role-based (Auth.getRole) for pages where URL and role
 * may disagree — most notably contractor-about.html, which is a homeowner page
 * whose URL contains "contractor".
 */

const Nav = {
  /** Detect if current page is a contractor page */
  _isContractorPage() {
    const path = window.location.pathname;
    // contractor-about.html is a homeowner-facing page (viewing a contractor's profile);
    // it must not be treated as a contractor portal page despite its URL.
    if (path.includes('contractor-about')) return false;
    return path.includes('contractor');
  },

  /** Render the site header */
  renderHeader(options = {}) {
    const { active = '', showAuth = true } = options;
    const nav = document.getElementById('site-header');
    if (!nav) return;

    const isContractor = this._isContractorPage();

    const links = isContractor ? [
      { href: '/contractor-dashboard.html',      label: 'Home',          id: 'home' },
      { href: '/contractor-opportunities.html',  label: 'Opportunities', id: 'opportunities' },
      { href: '/contractor-profile.html',        label: 'Profile',       id: 'profile' },
      { href: '/contractor-settings.html',       label: 'Settings',      id: 'settings' },
      { href: '/contractor-how-it-works.html',   label: 'How It Works',  id: 'how-it-works' },
      { href: '/contractor-faq.html',            label: 'FAQ',           id: 'faq' },
    ] : [
      { href: '/index.html',        label: 'Home',         id: 'home' },
      { href: '/how-it-works.html',  label: 'How It Works', id: 'how-it-works' },
      { href: '/faq.html',           label: 'FAQ',          id: 'faq' },
    ];

    nav.innerHTML = `
      <div class="nav-inner container">
        <a href="${isContractor ? '/contractor-dashboard.html' : '/index.html'}" class="nav-logo">
          <img src="/img/otter-logo.svg" alt="OtterQuote" class="nav-logo-icon" style="width:32px;height:32px;">
          <span class="nav-logo-text">${CONFIG.SITE_NAME}</span>
        </a>
        <div class="nav-links" id="nav-links">
          ${links.map(l => `
            <a href="${l.href}" class="nav-link ${active === l.id ? 'active' : ''}">${l.label}</a>
          `).join('')}
          ${showAuth ? '<div class="nav-mobile-auth" id="nav-mobile-auth-slot"></div>' : ''}
          ${isContractor && !showAuth ? `
            <a href="#" class="nav-link nav-mobile-cta-secondary" onclick="Auth.signOut(); return false;">Log Out</a>
          ` : ''}
        </div>
        <div class="nav-actions" id="nav-actions">
          ${showAuth ? '<div id="nav-auth-slot"></div>' : ''}
          ${isContractor && !showAuth ? `
            <button class="btn btn-sm btn-ghost" onclick="Auth.signOut()">Log Out</button>
          ` : ''}
        </div>
        <button class="nav-hamburger" id="nav-hamburger" aria-label="Menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    `;

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
    }
  },

  /**
   * Patch nav links and logo href when the authenticated role does not match
   * the URL-based contractor detection. This handles pages like
   * contractor-about.html (homeowner page whose URL contains "contractor").
   * Only fires when showAuth=true (i.e., pages that render the auth slot).
   */
  _updateNavLinksForRole(role) {
    if (!role) return;
    const isContractorByUrl  = this._isContractorPage();
    const isContractorByRole = (role === 'contractor');
    if (isContractorByUrl === isContractorByRole) return; // nothing to fix

    const links = isContractorByRole ? [
      { href: '/contractor-dashboard.html',     label: 'Home' },
      { href: '/contractor-opportunities.html', label: 'Opportunities' },
      { href: '/contractor-profile.html',       label: 'Profile' },
      { href: '/contractor-settings.html',      label: 'Settings' },
      { href: '/contractor-how-it-works.html',  label: 'How It Works' },
      { href: '/contractor-faq.html',           label: 'FAQ' },
    ] : [
      { href: '/index.html',       label: 'Home' },
      { href: '/how-it-works.html', label: 'How It Works' },
      { href: '/faq.html',          label: 'FAQ' },
    ];

    // Rebuild nav links in-place to handle both role expansions (3→6) and
    // contractions (6→3). Simply patching existing anchors leaves orphaned
    // links when switching from contractor (6 links) to homeowner (3 links).
    const container = document.getElementById('nav-links');
    if (container) {
      const anchors = Array.from(container.querySelectorAll(
        'a.nav-link:not(.nav-mobile-cta):not(.nav-mobile-cta-secondary)'
      ));
      // Update anchors that have a corresponding corrected link; remove the rest
      anchors.forEach((a, i) => {
        if (links[i]) { a.href = links[i].href; a.textContent = links[i].label; }
        else { a.remove(); }
      });
      // If corrected link set is larger than existing anchors, append the extras
      if (links.length > anchors.length) {
        const mobileAuthSlot = container.querySelector('#nav-mobile-auth-slot');
        const extras = links.slice(anchors.length)
          .map(l => `<a href="${l.href}" class="nav-link">${l.label}</a>`)
          .join('');
        if (mobileAuthSlot) {
          mobileAuthSlot.insertAdjacentHTML('beforebegin', extras);
        } else {
          container.insertAdjacentHTML('beforeend', extras);
        }
      }
    }

    // Update logo href
    const logo = document.querySelector('.nav-logo');
    if (logo) {
      logo.href = isContractorByRole ? '/contractor-dashboard.html' : '/index.html';
    }
  },

  async _renderAuthSlot() {
    const slot = document.getElementById('nav-auth-slot');
    const mobileSlot = document.getElementById('nav-mobile-auth-slot');
    if (!slot && !mobileSlot) return;

    const user = await Auth.getUser();
    let desktopHTML, mobileHTML;

    if (user) {
      // Determine which dashboard to link to based on role
      const role = await Auth.getRole();

      // Correct nav links if URL detection disagrees with actual role
      // (e.g. homeowner on contractor-about.html, or contractor on a homeowner page)
      this._updateNavLinksForRole(role);

      const dashboardUrl = role === 'contractor'
        ? '/contractor-dashboard.html'
        : '/dashboard.html';
      const dashboardLabel = role === 'contractor'
        ? 'Contractor Portal'
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
      desktopHTML = `
        <a href="/get-started.html" class="btn btn-sm btn-primary">Get Started</a>
        <a href="/contractor-login.html" class="btn btn-sm btn-ghost">Contractor Login</a>
      `;
      mobileHTML = `
        <a href="/get-started.html" class="nav-link nav-mobile-cta">Get Started</a>
        <a href="/contractor-login.html" class="nav-link nav-mobile-cta-secondary">Contractor Login</a>
      `;
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
        background:#0f2533;border:1px solid rgba(20,184,166,.25);border-radius:12px;
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
                style="width:100%;padding:.5rem .75rem;background:#0a1e2c;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;box-sizing:border-box;"
                placeholder="Mike Reynolds">
            </div>
            <div style="margin-bottom:.75rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-email">Your Email</label>
              <input id="sc-email" type="email" required autocomplete="email"
                style="width:100%;padding:.5rem .75rem;background:#0a1e2c;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;box-sizing:border-box;"
                placeholder="you@company.com">
            </div>
            <div style="margin-bottom:.75rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-subject">Subject (optional)</label>
              <input id="sc-subject" type="text"
                style="width:100%;padding:.5rem .75rem;background:#0a1e2c;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;box-sizing:border-box;"
                placeholder="e.g. Question about my bid">
            </div>
            <div style="margin-bottom:1rem;">
              <label style="display:block;font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;" for="sc-message">Message</label>
              <textarea id="sc-message" required rows="4"
                style="width:100%;padding:.5rem .75rem;background:#0a1e2c;border:1px solid rgba(148,163,184,.25);
                  border-radius:6px;color:#fff;font-size:.9rem;resize:vertical;box-sizing:border-box;"
                placeholder="Describe your question or issue..."></textarea>
            </div>
            <p id="sc-error" style="color:#f87171;font-size:.8rem;margin:0 0 .75rem;display:none;"></p>
            <button type="submit" id="sc-submit"
              style="width:100%;padding:.65rem 1rem;background:#14b8a6;color:#fff;border:none;
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
      background:#14b8a6;color:#fff;border:none;border-radius:50px;
      padding:.65rem 1.1rem;font-size:.85rem;font-weight:600;
      cursor:pointer;box-shadow:0 4px 16px rgba(20,184,166,.4);
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
    };
    fab.addEventListener('click', open);
    document.getElementById('support-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Form submit
    document.getElementById('support-contact-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name    = document.getElementById('sc-name').value.trim();
      const email   = document.getElementById('sc-email').value.trim();
      const subject = document.getElementById('sc-subject').value.trim();
      const message = document.getElementById('sc-message').value.trim();
      const errEl   = document.getElementById('sc-error');
      const btn     = document.getElementById('sc-submit');

      errEl.style.display = 'none';
      if (!name || !email || !message) {
        errEl.textContent = 'Please fill in your name, email, and message.';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Sending…';

      try {
        const SUPABASE_URL  = (typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL)  || '';
        const SUPABASE_ANON = (typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_ANON_KEY) || '';

        const res = await fetch(`${SUPABASE_URL}/functions/v1/send-support-email`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON,
            'Authorization': `Bearer ${SUPABASE_ANON}`,
          },
          body: JSON.stringify({ from_name: name, from_email: email, subject, message }),
        });

        if (!res.ok) throw new Error('Send failed');

        document.getElementById('support-form-wrap').style.display = 'none';
        document.getElementById('support-success').style.display = 'block';
      } catch {
        errEl.textContent = 'Something went wrong. Please email info@otterquote.com or call (844) 875-3412.';
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
              <img src="/img/otter-logo.svg" alt="OtterQuote" class="nav-logo-icon" style="width:32px;height:32px;">
              <span class="nav-logo-text">${CONFIG.SITE_NAME}</span>
            </div>
            <p class="footer-tagline">${isContractor
              ? 'Your sales team — without the truck, the manager, or the advance.'
              : 'Helping homeowners get the best deal on roofing and exterior projects.'
            }</p>
          </div>
          <div class="footer-col">
            <h4 class="footer-heading">${isContractor ? 'Contractor Portal' : 'Platform'}</h4>
            ${isContractor ? `
              <a href="/contractor-how-it-works.html">How It Works</a>
              <a href="/contractor-faq.html">FAQ</a>
              <a href="/contractor-opportunities.html">Browse Opportunities</a>
            ` : `
              <a href="/how-it-works.html">How It Works</a>
              <a href="/faq.html">FAQ</a>
              <a href="/get-started.html">Get Started</a>
            `}
          </div>
          <div class="footer-col">
            <h4 class="footer-heading">${isContractor ? 'Your Account' : 'Contractors'}</h4>
            ${isContractor ? `
              <a href="/contractor-dashboard.html">Dashboard</a>
              <a href="/contractor-profile.html">Company Profile</a>
              <a href="/contractor-agreement.html">Partner Agreement</a>
              <a href="#" id="footer-support-link" style="color:#14b8a6;font-weight:600;">💬 Contact Support</a>
            ` : `
              <a href="/contractor-login.html">Contractor Login</a>
              <a href="/contractor-join.html">Join Our Network</a>
              <a href="/contractor-agreement.html">Partner Agreement</a>
            `}
          </div>
          ${!isContractor ? `
          <div class="footer-col">
            <h4 class="footer-heading">Partners</h4>
            <a href="/partner-re.html">Real Estate Agents</a>
            <a href="/partner-insurance.html">Insurance Agents</a>
            <a href="/partner-dashboard.html">Partner Dashboard</a>
            <a href="/refer-a-friend.html">Refer a Friend</a>
          </div>
          ` : ''}
          <div class="footer-col">
            <h4 class="footer-heading">Legal</h4>
            <a href="/terms.html">Terms of Service</a>
            <a href="/privacy.html">Privacy Policy</a>
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
  }
};

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
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
});
