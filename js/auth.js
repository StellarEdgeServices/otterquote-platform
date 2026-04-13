/**
 * OtterQuote — Auth Helpers
 * Magic link authentication via Supabase Auth
 * Role-based routing: homeowner vs contractor
 */

window.Auth = {
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
    const partnerRoles = ['re_agent', 'insurance_agent', 'home_inspector'];
    const defaultRedirectPage = role === 'contractor'
      ? '/contractor-dashboard.html'
      : partnerRoles.includes(role)
        ? '/partner-dashboard.html'
        : '/trade-selector.html';
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
    // Enforce role if specified — prevent homeowners on contractor pages and vice versa
    if (requiredRole) {
      const role = await this.getRole();
      if (role && role !== requiredRole) {
        // Redirect to the correct dashboard for this user's actual role
        if (role === 'contractor') {
          window.location.href = '/contractor-dashboard.html';
        } else {
          window.location.href = '/dashboard.html';
        }
        return null;
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
   * Returns 'contractor' if a contractor record exists for this user,
   * otherwise checks the profile role. Returns null if no profile.
   *
   * SECURITY: If a contractor record exists, that's the source of truth.
   * This prevents homeowners from being misrouted as contractors and vice versa.
   */
  async getRole() {
    const user = await this.getUser();
    if (!user) return null;

    // Check if this user has a contractor record — that's the source of truth
    if (sb) {
      try {
        const { data: contractor, error } = await sb
          .from('contractors')
          .select('id')
          .eq('user_id', user.id)
          .single();

        if (contractor && !error) {
          return 'contractor';
        }
      } catch (e) {
        // No contractor record found — fall through to profile check
      }
    }

    // Fall back to profile role if no contractor record exists
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

    // Handle partner (referral agent) signup data
    // After clicking magic link, link the referral_agents record to this auth user.
    const partnerSignupRaw = localStorage.getItem('cs_partner_signup') || sessionStorage.getItem('cs_partner_signup');
    if (partnerSignupRaw && sb) {
      try {
        const partnerData = JSON.parse(partnerSignupRaw);
        // Update the referral_agents record (user_id IS NULL, email matches) with this user's id
        // The RLS policy "Authenticated can claim unclaimed partner record" allows this.
        const { error: linkError } = await sb
          .from('referral_agents')
          .update({ user_id: user.id })
          .eq('email', partnerData.email)
          .is('user_id', null);
        if (linkError) {
          console.error('Error linking partner user_id:', linkError);
        }
        localStorage.removeItem('cs_partner_signup');
        sessionStorage.removeItem('cs_partner_signup');
      } catch (err) {
        console.error('Error handling partner signup callback:', err);
      }
    }

    // Handle homeowner signup data (check localStorage first, fall back to sessionStorage)
    const signupData = localStorage.getItem('cs_signup') || sessionStorage.getItem('cs_signup');
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
                // New contractors default to pending_approval status
                status: 'pending_approval',
              })
              .select('id')
              .single();

            if (insertError) {
              console.error('Error inserting contractor record:', insertError);
            } else {
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

        localStorage.removeItem('cs_contractor_signup');
        sessionStorage.removeItem('cs_contractor_signup');
      } catch (err) {
        console.error('Error creating contractor profile:', err);
      }
    }

    // Advance referral status to 'registered' if homeowner arrived via referral link
    const referralId = localStorage.getItem('oq_referral_id') || sessionStorage.getItem('oq_referral_id');
    if (referralId && sb) {
      try {
        await sb
          .from('referrals')
          .update({ status: 'registered', homeowner_email: user.email })
          .eq('id', referralId)
          .eq('status', 'clicked');
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
