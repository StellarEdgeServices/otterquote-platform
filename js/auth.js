/**
 * OtterQuote — Auth Helpers
 * Magic link authentication via Supabase Auth
 * Role-based routing: homeowner vs contractor
 */

/** Escape user-supplied strings before interpolating into HTML email templates. */
function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
      var refMatch = (CONFIG && CONFIG.SUPABASE_URL ? CONFIG.SUPABASE_URL : '').match(/https:\/\/([^.]+)/);
      var ref = refMatch ? refMatch[1] : null;
      if (ref) {
        var raw = localStorage.getItem('sb-' + ref + '-auth-token');
        if (raw) {
          try {
            var parsed = JSON.parse(raw);
            if (parsed && (parsed.access_token || parsed.refresh_token)) {
              hasStoredSession = true;
            }
          } catch (e) { /* malformed - ignore */ }
        }
      }
    } catch (e) { /* localStorage blocked - fall through */ }

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
          } else if (event === 'INITIAL_SESSION' && !hasAuthInUrl && !hasStoredSession) {
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
        var refMatch = (typeof CONFIG !== 'undefined' && CONFIG.SUPABASE_URL ? CONFIG.SUPABASE_URL : '').match(/https:\/\/([^.]+)/);
        var ref = refMatch ? refMatch[1] : null;
        var raw = ref ? localStorage.getItem('sb-' + ref + '-auth-token') : null;
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
                const greeting = data.company_name || 'there';
                const settingsUrl = 'https://otterquote.com/contractor-settings.html';

                const welcomeMessage = `Hi ${greeting},

Welcome to Otter Quotes — your application is now in review.

Our team typically completes reviews within 2–5 business days. Here's what we check during that time:
- Contractor license verification
- Certificate of Insurance (COI) requirements
- Overall profile completeness

While you wait, use the time to get everything ready so you can hit the ground running the moment you're approved.

What to prepare:
1. Valid CGL Certificate of Insurance — $1M per occurrence / $2M aggregate, with Stellar Edge Services LLC listed as additional insured
2. Contractor license information for each trade and municipality you work in
3. Contract template (PDF) for each trade you offer
4. Stripe payment method — required before you can receive projects

Complete your profile now:
${settingsUrl}

Questions? support@otterquote.com | (844) 875-3412

The Otter Quotes Team
https://otterquote.com`;

                const welcomeHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td align="left" style="background:#0B1929;padding:24px 32px;">
            <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
            <p style="margin:0 0 6px;color:#14B8A6;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Application In Review</p>
            <h2 style="margin:0 0 20px;color:#0F172A;font-size:22px;font-weight:700;line-height:1.3;">Welcome to Otter Quotes, ${escapeHtml(greeting)}!</h2>
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Your application is in review. Our team typically completes the process within <strong>2&ndash;5 business days</strong>. Here&rsquo;s what we check:</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F8FAFC;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:16px 20px;border-bottom:1px solid #E2E8F0;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">1</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">License Verification</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We verify your contractor license(s) for each trade and municipality.</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:16px 20px;border-bottom:1px solid #E2E8F0;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">2</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">COI Requirements</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We confirm your Certificate of Insurance meets our coverage minimums ($1M/$2M CGL, Stellar Edge Services LLC as additional insured).</p>
                  </td>
                </tr></table>
              </td></tr>
              <tr><td style="padding:16px 20px;">
                <table cellpadding="0" cellspacing="0" border="0"><tr>
                  <td style="width:28px;vertical-align:top;padding-top:2px;">
                    <div style="width:22px;height:22px;background:#14B8A6;border-radius:50%;text-align:center;line-height:22px;font-size:12px;font-weight:700;color:#ffffff;">3</div>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;color:#0F172A;font-size:14px;font-weight:600;">Profile Check</p>
                    <p style="margin:4px 0 0;color:#64748B;font-size:13px;">We review your profile for completeness before activating your account.</p>
                  </td>
                </tr></table>
              </td></tr>
            </table>
            <p style="margin:0 0 12px;color:#0F172A;font-size:15px;font-weight:700;">What to prepare while you wait:</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F0FDFA;border:1px solid #99F6E4;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:16px 20px;">
                <table cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Valid CGL Certificate of Insurance</strong> &mdash; $1M per occurrence / $2M aggregate, with <em>Stellar Edge Services LLC</em> listed as additional insured
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Contractor license information</strong> for each trade and municipality you serve
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Contract template (PDF)</strong> for each trade you offer
                  </td></tr>
                  <tr><td style="padding:4px 0;color:#0F172A;font-size:14px;vertical-align:top;">
                    <span style="color:#14B8A6;font-weight:700;margin-right:8px;">&#10003;</span><strong>Stripe payment method</strong> &mdash; required before you can receive projects
                  </td></tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0 0 16px;color:#374151;font-size:15px;line-height:1.6;">Head to your profile settings to upload documents and connect your payment method before your review completes &mdash; it speeds things up.</p>
            <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:8px;">
              <tr>
                <td align="center" bgcolor="#14B8A6" style="border-radius:8px;">
                  <a href="${settingsUrl}" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Complete Your Profile &rarr;</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            &nbsp;&nbsp;|&nbsp;&nbsp;
            <a href="tel:+18448753412" style="color:#0EA5E9;text-decoration:none;">(844) 875-3412</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

                await fetch(`${window.location.origin}/functions/v1/send-support-email`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from_name: 'Otter Quotes',
                    from_email: 'notifications@otterquote.com',
                    subject: 'Welcome to Otter Quotes \u2014 Your Application Is In Review',
                    message: welcomeMessage,
                    html: welcomeHtml,
                    to_email: data.email || user.email
                  })
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
   * Sync the sq_at cookie with the current Supabase session.
   * Used by the Netlify admin-auth-gate edge function (W4-P1) to verify
   * admin identity server-side before the HTML page is served.
   * Cookie is non-HttpOnly so the token-refresh listener can update it;
   * it carries no extra privilege — Supabase RLS remains the data gate.
   */
  _syncAdminCookie(session) {
    if (session?.access_token) {
      try {
        const parts = session.access_token.split('.');
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        const maxAge = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
        document.cookie = `sq_at=${session.access_token}; path=/; SameSite=Lax; max-age=${maxAge}`;
      } catch (e) {
        // Malformed token — clear rather than leave stale
        document.cookie = 'sq_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      }
    } else {
      document.cookie = 'sq_at=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
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
      // Keep sq_at cookie in sync across all auth lifecycle events
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        this._syncAdminCookie(session);
      } else if (event === 'SIGNED_OUT') {
        this._syncAdminCookie(null);
      }

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
  _initCookieSync() {
    if (this._cookieSyncWired) return;
    if (!sb) return;
    this._cookieSyncWired = true;
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        this._syncAdminCookie(session);
      } else if (event === 'SIGNED_OUT') {
        this._syncAdminCookie(null);
      }
    });
  }
};

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
if (typeof window !== 'undefined' && window.Auth && typeof window.Auth._initCookieSync === 'function') {
  try { window.Auth._initCookieSync(); } catch (e) { /* non-fatal */ }
}
