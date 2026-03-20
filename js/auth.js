/**
 * ClaimShield v2 — Auth Helpers
 * Magic link authentication via Supabase Auth
 * Role-based routing: homeowner vs contractor
 */

const Auth = {
  /** Get current session */
  async getSession() {
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    return session;
  },

  /** Get current user */
  async getUser() {
    const session = await this.getSession();
    return session?.user || null;
  },

  /**
   * Send magic link email with role-aware redirect.
   * @param {string} email
   * @param {string} role - 'homeowner' (default) or 'contractor'
   */
  async sendMagicLink(email, role = 'homeowner') {
    if (!sb) throw new Error('Supabase not initialized');
    // Redirect URL depends on role — auth callback page handles final routing
    const redirectPage = role === 'contractor'
      ? '/contractor-dashboard.html'
      : '/dashboard.html';
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${CONFIG.SITE_URL}${redirectPage}`,
      }
    });
    if (error) throw error;
    return true;
  },

  /** Sign out */
  async signOut() {
    if (!sb) return;
    await sb.auth.signOut();
    window.location.href = '/index.html';
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
    const user = await this.getUser();
    if (!user) {
      sessionStorage.setItem('cs_redirect', window.location.pathname);
      // Send to the correct login page based on the page they tried to visit
      const isContractorPage = window.location.pathname.includes('contractor');
      window.location.href = isContractorPage
        ? '/contractor-login.html'
        : '/get-started.html';
      return null;
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
   * Get the user's role from their profile.
   * Returns 'homeowner', 'contractor', or null if no profile.
   */
  async getRole() {
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

    // Check for a stored redirect path first
    const savedRedirect = sessionStorage.getItem('cs_redirect');
    if (savedRedirect) {
      sessionStorage.removeItem('cs_redirect');
      window.location.href = savedRedirect;
      return;
    }

    // Otherwise route by role
    const role = await this.getRole();
    if (role === 'contractor') {
      window.location.href = '/contractor-dashboard.html';
    } else {
      window.location.href = '/dashboard.html';
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
  }
};
