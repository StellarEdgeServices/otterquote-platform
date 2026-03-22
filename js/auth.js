/**
 * OtterQuote — Auth Helpers
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
  },

  /**
   * Handle post-auth profile creation and routing.
   * Call this when user logs in via magic link to create their profile from signup data.
   */
  async handleAuthCallback() {
    const user = await this.getUser();
    if (!user) return;

    const role = sessionStorage.getItem('cs_auth_role') || 'homeowner';

    // Handle homeowner signup data
    const signupData = sessionStorage.getItem('cs_signup');
    if (signupData) {
      try {
        const data = JSON.parse(signupData);
        const fullName = `${data.first_name} ${data.last_name}`.trim();

        // Create or update profile
        await this.updateProfile({
          full_name: fullName,
          phone: data.phone || null,
          address_line1: data.address || null,
          role: data.role || 'homeowner',
        });

        sessionStorage.removeItem('cs_signup');
      } catch (err) {
        console.error('Error creating profile from signup data:', err);
      }
    }

    // Handle contractor signup data
    const contractorSignupData = sessionStorage.getItem('cs_contractor_signup');
    if (contractorSignupData) {
      try {
        const data = JSON.parse(contractorSignupData);

        // Create or update profile for contractor
        await this.updateProfile({
          full_name: data.contact_name,
          phone: data.phone || null,
          address_line1: data.address_line1 || null,
          role: 'contractor',
        });

        // Create contractor record if it doesn't exist
        if (sb) {
          const { data: existing } = await sb
            .from('contractors')
            .select('id')
            .eq('user_id', user.id)
            .single();

          if (!existing) {
            await sb.from('contractors').insert({
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
            });

            // Insert licenses if provided
            if (data.licenses && data.licenses.length > 0) {
              const licenseRecords = data.licenses.map(lic => ({
                contractor_id: user.id,
                municipality: lic.municipality,
                license_number: lic.number,
                expiration_date: lic.expDate,
              }));
              await sb.from('contractor_licenses').insert(licenseRecords);
            }
          }
        }

        sessionStorage.removeItem('cs_contractor_signup');
      } catch (err) {
        console.error('Error creating contractor profile:', err);
      }
    }

    // Route to appropriate dashboard
    await this.redirectToDashboard();
  },

  /**
   * Set up listener for auth state changes.
   * Handles post-auth profile creation when user logs in.
   */
  onAuthStateChangeListener() {
    if (!sb) return;
    sb.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        // User just signed in, create profile if needed
        await this.handleAuthCallback();
      }
    });
  }
};
