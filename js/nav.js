/**
 * ClaimShield v2 — Navigation Component
 * Renders consistent header/footer across all pages.
 */

const Nav = {
  /** Render the site header */
  renderHeader(options = {}) {
    const { active = '', showAuth = true } = options;
    const nav = document.getElementById('site-header');
    if (!nav) return;

    const links = [
      { href: '/index.html',        label: 'Home',         id: 'home' },
      { href: '/how-it-works.html',  label: 'How It Works', id: 'how-it-works' },
      { href: '/faq.html',           label: 'FAQ',          id: 'faq' },
    ];

    nav.innerHTML = `
      <div class="nav-inner container">
        <a href="/index.html" class="nav-logo">
          <span class="nav-logo-icon">&#x1F6E1;</span>
          <span class="nav-logo-text">${CONFIG.SITE_NAME}</span>
        </a>
        <div class="nav-links" id="nav-links">
          ${links.map(l => `
            <a href="${l.href}" class="nav-link ${active === l.id ? 'active' : ''}">${l.label}</a>
          `).join('')}
        </div>
        <div class="nav-actions" id="nav-actions">
          ${showAuth ? '<div id="nav-auth-slot"></div>' : ''}
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

  async _renderAuthSlot() {
    const slot = document.getElementById('nav-auth-slot');
    if (!slot) return;

    const user = await Auth.getUser();
    if (user) {
      slot.innerHTML = `
        <a href="/dashboard.html" class="btn btn-sm btn-primary">My Dashboard</a>
        <button class="btn btn-sm btn-ghost" onclick="Auth.signOut()">Sign Out</button>
      `;
    } else {
      slot.innerHTML = `
        <a href="/get-started.html" class="btn btn-sm btn-primary">Get Started</a>
      `;
    }
  },

  /** Render the site footer */
  renderFooter() {
    const footer = document.getElementById('site-footer');
    if (!footer) return;

    footer.innerHTML = `
      <div class="footer-inner container">
        <div class="footer-grid">
          <div class="footer-col">
            <div class="footer-logo">
              <span class="nav-logo-icon">&#x1F6E1;</span>
              <span class="nav-logo-text">${CONFIG.SITE_NAME}</span>
            </div>
            <p class="footer-tagline">Helping Indiana homeowners get the best deal on storm damage repairs.</p>
          </div>
          <div class="footer-col">
            <h4 class="footer-heading">Platform</h4>
            <a href="/how-it-works.html">How It Works</a>
            <a href="/faq.html">FAQ</a>
            <a href="/get-started.html">Get Started</a>
          </div>
          <div class="footer-col">
            <h4 class="footer-heading">Contractors</h4>
            <a href="/contractor-join.html">Join Our Network</a>
            <a href="/contractor-login.html">Contractor Login</a>
          </div>
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
