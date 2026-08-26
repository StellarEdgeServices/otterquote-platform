/**
 * Get Started — D-211 Phase 2
 *
 * Homeowner sign-up page (Google OAuth + email/password).
 * Feature-parity with static get-started.html.
 *
 * Auth flow:
 *   - If user is already logged in, redirect to appropriate dashboard.
 *   - New users choose one of two paths, both of which collect the same profile
 *     data first: Google OAuth (primary, button at the top of the card) or
 *     email + password. Either way we do leads insert (non-fatal) → write
 *     localStorage (cs_signup) → hand off to Supabase auth.
 *   - HubSpot contact creation (D-189) no longer fires from this page —
 *     the user has no session/JWT yet at this point, and create-hubspot-contact's
 *     homeowner mode requires one (D-211 CODE-3 hardening, 86e1xdaxe #1), so the
 *     pre-auth call always 401'd (#405). The cs_signup payload written below is
 *     read post-auth by the auth-callback page, which fires the HubSpot call
 *     once a valid session JWT exists.
 *
 * References: D-189 (HubSpot), D-211 (React surface), #405 (post-auth HubSpot move)
 *
 *   [D-207 Google OAuth removed pre-launch] — REVERSED for this page on
 *   2026-08-26 by Dustin. His direction, verbatim: "The login for customers
 *   still has a magic link. I'd like to remove that as an option for homeowners
 *   if possible. I want it to be Oauth or set a password. I don't want to force
 *   homeowners to leave the site as the first step." D-207's pre-launch removal
 *   therefore no longer governs the homeowner sign-up surface: the Google button
 *   is back above the form as the primary path, email + password is the
 *   alternative, and magic link is gone from this page entirely (both the
 *   signInWithOtp call and the "check your email" panel that only it could
 *   reach). The reversal is recorded rather than deleted so nobody re-applies
 *   D-207 here without a newer decision from Dustin. /login and /contractor/login
 *   are untouched — this reversal is scoped to homeowner sign-up.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { readReferralIds, writeReferralIds } from '@/lib/cookie-storage';
import { formatPhoneValue, isValidEmail } from './utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const AUTH_CALLBACK_URL = 'https://app.otterquote.com/auth-callback';
// Same target the magic link used, plus the homeowner intent marker the static
// stack and /login already carry (see app/login/utils.ts GOOGLE_OAUTH_REDIRECT).
// Declared locally rather than imported from the login page so /get-started
// keeps owning its own redirect targets, as it always has.
const GOOGLE_OAUTH_REDIRECT = `${AUTH_CALLBACK_URL}?intent=homeowner`;
const DASHBOARD_URL = 'https://otterquote.com/dashboard.html';
const CONTRACTOR_DASHBOARD_URL = 'https://otterquote.com/contractor-dashboard.html';
const LOGIN_URL = 'https://otterquote.com/login.html';
const SUPPORT_EMAIL = 'info@otterquote.com';

const MIN_PASSWORD_LENGTH = 8;

/**
 * Shown when Supabase tells us the email already has an account. Dustin's
 * 2026-08-26 direction makes password the fallback path, and a generic
 * "something went wrong" on a duplicate email is the single most common way a
 * returning homeowner gets stuck on a sign-up form — so this points at sign-in
 * explicitly instead.
 */
const ALREADY_REGISTERED_MESSAGE =
  'An account with that email already exists. Sign in instead — use the "Sign in here" link below, or reset your password from that page if you have forgotten it.';

type ReferralSource = 'insurance_agent' | 'realtor' | 'friend' | 'web' | '';

// ─── GA4 helper ──────────────────────────────────────────────────────────────

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag(...args);
  }
}

/**
 * True when Supabase is telling us this email already has an account.
 * GoTrue reports this two different ways depending on project settings, and
 * both have to land on the same user-facing message (requirement from Dustin
 * 2026-08-26): an outright "User already registered" error when email
 * confirmation is off, or a 422 with code user_already_exists.
 */
function isAlreadyRegisteredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const code = (err as { code?: string } | null)?.code ?? '';
  return (
    /already\s+(registered|exists|been registered)/i.test(message) ||
    code === 'user_already_exists'
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GetStartedPage() {
  const { user, role, loading } = useAuthReady();

  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [referralSource, setReferralSource] = useState<ReferralSource>('');
  const [refName, setRefName] = useState('');
  const [refEmail, setRefEmail] = useState('');

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmEmailSent, setConfirmEmailSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState('');

  /**
   * Set the instant we begin our own post-sign-up navigation. When the Supabase
   * project auto-confirms emails, signUp() hands back a live session right away,
   * which would otherwise trip the "already logged in" redirect below and drop a
   * brand-new homeowner on the dashboard before /auth-callback has run the
   * post-auth HubSpot sync (#405) and the referral advance (#571). A ref, not
   * state, because this must take effect without waiting for a re-render.
   */
  const signupNavigation = useRef(false);

  // ── Redirect if already logged in ──
  useEffect(() => {
    if (loading) return;
    if (!user) return;
    if (signupNavigation.current) return;
    if (role === 'contractor') {
      window.location.href = CONTRACTOR_DASHBOARD_URL;
    } else {
      window.location.href = DASHBOARD_URL;
    }
  }, [loading, user, role]);

  // ── Phone formatting on autofill ──
  const handlePhoneChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPhone(formatPhoneValue(e.target.value));
  }, []);

  // ── Referral chip click ──
  const handleReferralChip = useCallback((val: ReferralSource) => {
    setReferralSource(prev => (prev === val ? '' : val));
  }, []);

  // ── Validation ──

  /**
   * Profile fields both paths need. Google hands us the email only after the
   * round-trip, so email/password are validated separately by the form path —
   * but everything else has to be on the clipboard before we leave the site,
   * because register-time data cannot be recovered from an OAuth callback.
   */
  const validateProfile = (): string | null => {
    if (!firstName.trim() || !lastName.trim() || !phone.trim() || !address.trim()) {
      return 'Please fill in your name, phone, and property address before continuing.';
    }
    return null;
  };

  const validateEmailAndPassword = (): string | null => {
    if (!email.trim()) return 'Please fill in all required fields.';
    if (!isValidEmail(email.trim())) return 'Please enter a valid email address.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

  // ── Shared pre-auth persistence ──

  /**
   * Everything that has to be on disk BEFORE we hand control to Supabase, used
   * identically by the password path and the Google path.
   *
   * For Google this is the "stash the pending signup payload before navigating"
   * step (same shape as the static partner-insurance.html cs_pending_partner_signup
   * pattern), except there is no need for a second pending-payload key here:
   * /auth-callback already reads cs_signup out of localStorage post-auth to fire
   * the HubSpot contact (#405), and /trade-selector already reads it to upsert
   * profiles. /get-started and /auth-callback are both on app.otterquote.com, so
   * localStorage — which is origin-scoped — survives the Google round-trip intact.
   * Reusing cs_signup keeps one mechanism instead of inventing a parallel one.
   */
  const persistSignupContext = (emailForLead: string | null) => {
    // 1. Insert into leads table (non-fatal, fire-and-forget — no await).
    //    Skipped when we have no email to attach: on the Google path the visitor
    //    may leave the email field blank, and the real address only arrives with
    //    the OAuth session.
    if (emailForLead) {
      supabase.from('leads').insert({
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: emailForLead,
        source: referralSource || 'web',
        created_at: new Date().toISOString(),
      }).then(({ error: leadErr }) => {
        if (leadErr) console.warn('[get-started] leads insert failed (non-fatal):', leadErr);
      });
    }

    // 2. Persist referral attribution.
    // Bridge 2026-08-26 (P0): cookie FIRST. ref.html writes these on
    // otterquote.com; this page is on app.otterquote.com and localStorage is
    // ORIGIN-scoped, so both reads below were always null here. Also note the
    // agent-id read had no localStorage fallback at all (unlike the id above),
    // so it lost the value on a new tab even same-origin.
    const refCookie = readReferralIds();
    const storedReferralId =
      refCookie.oq_referral_id ||
      (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('oq_referral_id')) ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('oq_referral_id')) ||
      null;
    const storedReferralAgentId =
      refCookie.oq_referral_agent_id ||
      (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('oq_referral_agent_id')) ||
      (typeof localStorage !== 'undefined' && localStorage.getItem('oq_referral_agent_id')) ||
      null;

    // 3. Write cs_signup to localStorage
    localStorage.setItem(
      'cs_signup',
      JSON.stringify({
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        phone: phone.trim(),
        address: address.trim(),
        referral_source:
          referralSource || (storedReferralAgentId ? 'partner_link' : 'web'),
        referring_agent_name: refName.trim() || null,
        referring_agent_email: refEmail.trim() || null,
        role: 'homeowner',
        sms_consent_ts: smsConsent ? new Date().toISOString() : null,
      }),
    );

    // 4. Persist referral_id so auth-callback can advance referral status.
    // Written through the cookie bridge so it survives the app<->www hop —
    // and, since 2026-08-26, the Google round-trip through accounts.google.com.
    if (storedReferralId) {
      writeReferralIds({
        oq_referral_id: storedReferralId,
        oq_referral_agent_id: storedReferralAgentId || undefined,
        oq_referral_code: refCookie.oq_referral_code,
      });
    }

    // 5. Store intended role for post-auth routing
    localStorage.setItem('cs_auth_role', 'homeowner');
  };

  /** GA4 sign-up events — `method` distinguishes the two paths Dustin asked for. */
  const fireSignupAnalytics = (method: 'google' | 'password') => {
    const params = new URLSearchParams(
      typeof window !== 'undefined' ? window.location.search : '',
    );
    gtag('event', 'sign_up', {
      method,
      referral_source: referralSource || 'web',
    });
    gtag('event', 'homeowner_signup', {
      job_type: params.get('job_type') || null,
      source: params.get('utm_source') || referralSource || 'direct',
    });
  };

  // ── Google OAuth sign-up (primary path, Dustin 2026-08-26) ──
  const handleGoogle = async () => {
    setError('');

    const problem = validateProfile();
    if (problem) {
      setError(problem);
      return;
    }

    setGoogleLoading(true);
    try {
      const typedEmail = email.trim();
      // Stash the profile payload BEFORE the browser leaves for Google —
      // nothing in the OAuth callback can reconstruct it otherwise.
      persistSignupContext(typedEmail && isValidEmail(typedEmail) ? typedEmail : null);
      // Fired here rather than after the call because a successful
      // signInWithOAuth unloads this page immediately.
      fireSignupAnalytics('google');
      signupNavigation.current = true;

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: GOOGLE_OAUTH_REDIRECT },
      });
      if (oauthError) throw oauthError;
      // On success the browser navigates to Google; nothing else to do.
    } catch (err: unknown) {
      console.error('[get-started] Google sign-up error:', err);
      signupNavigation.current = false;
      setGoogleLoading(false);
      setError('Google sign-up failed. Please try again, or create your account with an email and password below.');
    }
  };

  // ── Email + password sign-up (alternative path) ──
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    const profileProblem = validateProfile();
    if (profileProblem) {
      setError(profileProblem);
      return;
    }
    const credentialProblem = validateEmailAndPassword();
    if (credentialProblem) {
      setError(credentialProblem);
      return;
    }
    // SMS consent optional per TCR/CTIA rules — do not block on unchecked

    setSubmitting(true);

    try {
      const emailTrimmed = email.trim();

      // D-189/#405: HubSpot contact creation still runs post-auth in
      // auth-callback, unchanged by the 2026-08-26 auth rework — the JWT that
      // create-hubspot-contact's homeowner mode requires does not exist until
      // Supabase establishes a session, which is true of the password path for
      // exactly the same reason it was true of the magic link. cs_signup,
      // written by persistSignupContext below, is what carries the fields over.
      persistSignupContext(emailTrimmed);

      // Password sign-up. Mirrors js/auth.js signUpWithPassword (the helper the
      // static partner signup pages call) — same supabase.auth.signUp call with
      // an emailRedirectTo pointed at our own callback. Not routed through that
      // helper because it lives in the static stack's global Auth object, which
      // the React app deliberately does not load; the React surfaces call
      // `supabase.auth.*` directly (same convention as /login).
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: emailTrimmed,
        password,
        options: {
          emailRedirectTo: AUTH_CALLBACK_URL,
          data: { role: 'homeowner' },
        },
      });
      if (signUpError) throw signUpError;

      // GoTrue's anti-enumeration behaviour: when email confirmation is ON, an
      // email that already has an account comes back as a SUCCESS with an empty
      // identities array rather than an error. Without this branch that user
      // would sit on a "check your email" panel waiting for a mail that never
      // arrives, which is precisely the dead end Dustin wanted removed.
      const identities = data.user?.identities;
      if (Array.isArray(identities) && identities.length === 0) {
        setError(ALREADY_REGISTERED_MESSAGE);
        return;
      }

      fireSignupAnalytics('password');

      if (data.session) {
        // Project auto-confirms email — session is live, so hand off to
        // /auth-callback for the normal post-auth routing (HubSpot sync,
        // referral advance, trade-selector vs dashboard).
        signupNavigation.current = true;
        window.location.href = AUTH_CALLBACK_URL;
        return;
      }

      // No session means the project requires email confirmation first. This is
      // a one-time account-confirmation mail, not a magic-link sign-in loop:
      // the password they just set is what they use from here on.
      setSentToEmail(emailTrimmed);
      setConfirmEmailSent(true);
    } catch (err: unknown) {
      console.error('[get-started] signup error:', err);
      if (isAlreadyRegisteredError(err)) {
        setError(ALREADY_REGISTERED_MESSAGE);
        return;
      }
      const msg =
        err instanceof Error ? err.message : 'An unexpected error occurred.';
      setError(`Something went wrong. Please try again or email us at ${SUPPORT_EMAIL}. (${msg})`);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Loading / redirect in-flight ──
  if (loading || (user && !loading)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ width: 24, height: 24, border: '3px solid rgba(224,123,0,0.2)', borderTopColor: 'var(--amber, #E07B00)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const showReferralAgentFields = referralSource === 'insurance_agent' || referralSource === 'realtor';

  return (
    <>
      <style>{`
        .gs-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          min-height: calc(100vh - 64px);
        }
        .gs-left {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--sp-12, 3rem) var(--sp-8, 2rem);
        }
        .gs-form-wrap {
          width: 100%;
          max-width: 440px;
        }
        .gs-form-wrap h1 {
          font-size: 2rem;
          margin-bottom: var(--sp-2, 0.5rem);
          color: var(--white, #fff);
        }
        .gs-subtitle {
          color: var(--slate, #94a3b8);
          font-size: 1rem;
          margin-bottom: var(--sp-8, 2rem);
          line-height: 1.6;
        }
        .gs-form {
          display: flex;
          flex-direction: column;
          gap: var(--sp-5, 1.25rem);
        }
        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--sp-4, 1rem);
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: var(--sp-1, 0.25rem);
        }
        .form-label {
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--white, #fff);
        }
        .form-input {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 8px;
          padding: 10px 14px;
          color: var(--white, #fff);
          font-size: 1rem;
          width: 100%;
          box-sizing: border-box;
          font-family: inherit;
          transition: border-color 0.15s;
        }
        .form-input:focus {
          outline: none;
          border-color: var(--amber, #E07B00);
        }
        .form-hint {
          font-size: 0.8rem;
          color: var(--slate, #94a3b8);
        }
        /* Google button + divider — same rules as /login's .btn-google so both
           auth surfaces stay visually identical (Dustin 2026-08-26). */
        .btn-google {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          width: 100%;
          padding: 12px 20px;
          border-radius: 8px;
          border: 1.5px solid #dadce0;
          background: #fff;
          cursor: pointer;
          font-size: 15px;
          font-weight: 500;
          color: #3c4043;
          transition: box-shadow 0.15s, border-color 0.15s;
          font-family: inherit;
        }
        .btn-google:hover:not(:disabled) {
          box-shadow: 0 1px 4px rgba(0,0,0,.16);
          border-color: #c6c9cd;
        }
        .btn-google:disabled { opacity: 0.7; cursor: not-allowed; }
        .gs-oauth-hint {
          font-size: 0.8rem;
          color: var(--slate, #94a3b8);
          text-align: center;
          margin: 8px 0 0;
        }
        .oauth-divider {
          display: flex;
          align-items: center;
          gap: 12px;
          margin: 20px 0;
          color: var(--gray, #64748b);
          font-size: 13px;
        }
        .oauth-divider::before, .oauth-divider::after {
          content: '';
          flex: 1;
          height: 1px;
          background: rgba(255,255,255,0.12);
        }
        .referral-section {
          padding: var(--sp-4, 1rem);
          background: rgba(255,255,255,0.03);
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.06);
        }
        .referral-legend {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--slate, #94a3b8);
          margin-bottom: var(--sp-3, 0.75rem);
          display: block;
        }
        .referral-options {
          display: flex;
          gap: var(--sp-3, 0.75rem);
          flex-wrap: wrap;
          margin-bottom: var(--sp-3, 0.75rem);
        }
        .referral-chip {
          padding: 6px 16px;
          border-radius: 9999px;
          border: 1px solid rgba(255,255,255,0.15);
          background: transparent;
          color: var(--slate, #94a3b8);
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s;
          font-family: inherit;
        }
        .referral-chip:hover { border-color: var(--amber, #E07B00); color: var(--amber, #E07B00); }
        .referral-chip.active {
          background: var(--amber, #E07B00);
          color: var(--navy, #0B1929);
          border-color: var(--amber, #E07B00);
          font-weight: 700;
        }
        .referral-name-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--sp-3, 0.75rem);
          margin-top: var(--sp-3, 0.75rem);
        }
        .form-checkbox-wrapper {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          cursor: pointer;
        }
        .form-checkbox {
          appearance: none;
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          border: 2px solid var(--slate, #94a3b8);
          border-radius: 4px;
          background: transparent;
          cursor: pointer;
          transition: all 0.15s;
          flex-shrink: 0;
          margin-top: 2px;
          position: relative;
        }
        .form-checkbox:hover { border-color: var(--amber, #E07B00); }
        .form-checkbox:checked {
          background: var(--amber, #E07B00);
          border-color: var(--amber, #E07B00);
        }
        .form-checkbox:checked::after {
          content: '✓';
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--navy, #0B1929);
          font-size: 0.75rem;
          font-weight: 700;
        }
        .form-error {
          background: rgba(239,68,68,0.1);
          border: 1px solid rgba(239,68,68,0.3);
          border-left: 4px solid #EF4444;
          color: #FECACA;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 0.9rem;
        }
        .btn-primary-full {
          background: var(--amber, #E07B00);
          color: var(--navy, #0B1929);
          border: none;
          border-radius: 8px;
          padding: 14px 24px;
          font-size: 1rem;
          font-weight: 700;
          cursor: pointer;
          width: 100%;
          font-family: inherit;
          transition: all 0.15s;
          position: relative;
        }
        .btn-primary-full:hover:not(:disabled) {
          background: #f08c10;
          transform: translateY(-1px);
        }
        .btn-primary-full:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn-loading-spinner {
          display: inline-block;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(11,25,41,0.3);
          border-top-color: var(--navy, #0B1929);
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
          vertical-align: middle;
          margin-right: 8px;
        }        .text-sm-center {
          font-size: 0.85rem;
          text-align: center;
          color: var(--gray, #64748b);
          margin-top: var(--sp-4, 1rem);
        }
        .text-sm-center a { color: var(--amber, #E07B00); font-weight: 600; text-decoration: none; }
        /* Account-confirmation panel. Same visual treatment the magic-link
           "check your email" panel used before 2026-08-26 — the panel survives
           because Supabase can still require a one-time confirmation click on a
           brand-new password account; only the magic-link sign-in loop is gone. */
        .gs-confirm-sent {
          text-align: center;
          padding: var(--sp-8, 2rem) 0;
        }
        .gs-confirm-icon { font-size: 3rem; margin-bottom: 1rem; }
        .gs-confirm-sent h2 {
          font-size: 1.5rem;
          color: var(--white, #fff);
          margin-bottom: 0.75rem;
        }
        .gs-confirm-sent p {
          color: var(--slate, #94a3b8);
          max-width: 340px;
          margin: 0 auto;
        }
        .gs-confirm-email {
          display: inline-block;
          background: rgba(224,123,0,0.12);
          color: var(--amber, #E07B00);
          font-weight: 700;
          padding: 6px 14px;
          border-radius: 4px;
          margin: 12px 0;
          font-family: monospace;
          font-size: 0.9rem;
        }
        .gs-right {
          background: var(--navy-2, #0f2036);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: var(--sp-12, 3rem) var(--sp-8, 2rem);
          border-left: 1px solid rgba(255,255,255,0.06);
        }
        .gs-benefits { max-width: 380px; }
        .gs-benefits h2 {
          font-size: 1.5rem;
          color: var(--white, #fff);
          margin-bottom: 2rem;
        }
        .benefit-item {
          display: flex;
          gap: 1rem;
          margin-bottom: 1.5rem;
        }
        .benefit-icon {
          width: 40px;
          height: 40px;
          border-radius: 8px;
          background: rgba(224,123,0,0.12);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.2rem;
          flex-shrink: 0;
        }
        .benefit-text h4 {
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--white, #fff);
          margin: 0 0 4px;
        }
        .benefit-text p {
          font-size: 0.85rem;
          color: var(--slate, #94a3b8);
          margin: 0;
          line-height: 1.5;
        }
        @media (max-width: 768px) {
          .gs-layout { grid-template-columns: 1fr; }
          .gs-right {
            border-left: none;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            padding: 1.5rem;
            order: -1;
          }
          .gs-left { padding: 2rem 1.5rem; }
          .form-row { grid-template-columns: 1fr; }
          .referral-name-row { grid-template-columns: 1fr; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div className="gs-layout">
        {/* ── Left: Form ── */}
        <div className="gs-left">
          <div className="gs-form-wrap">
            <h1>Get Started</h1>
            <p className="gs-subtitle">
              Create your free account and start getting competitive quotes from qualified contractors.
            </p>

            {/* ── Account-Confirmation State ── */}
            {confirmEmailSent ? (
              <div className="gs-confirm-sent">
                <div className="gs-confirm-icon">✉️</div>
                <h2>Confirm Your Email</h2>
                <p>Your account is created. We sent a one-time confirmation link to:</p>
                <div className="gs-confirm-email">{sentToEmail}</div>
                <p style={{ marginTop: '1rem' }}>
                  Click the link to activate your account. After that, sign in any time with
                  the password you just set.
                </p>
                <p className="text-sm-center">
                  <a href={LOGIN_URL}>Go to sign in</a>
                </p>
              </div>
            ) : (
              <>
                {/*
                  Google OAuth — primary path, restored 2026-08-26 on Dustin's
                  direction (see the file header for the D-207 reversal). It sits
                  above the form deliberately: he does not want the first step of
                  a homeowner sign-up to be leaving the site for an inbox, and
                  one Google click beats seven fields for most visitors. The
                  profile fields below are still collected first — validateProfile()
                  runs on click and persistSignupContext() stashes the payload
                  before the browser leaves for Google.
                */}
                <button
                  type="button"
                  className="btn-google"
                  onClick={handleGoogle}
                  disabled={googleLoading || submitting}
                >
                  {googleLoading ? (
                    'Redirecting to Google…'
                  ) : (
                    <>
                      <GoogleIcon />
                      Sign up with Google
                    </>
                  )}
                </button>
                <p className="gs-oauth-hint">
                  Fill in your details below first — we carry them over to your new account.
                </p>

                <div className="oauth-divider"><span>or sign up with email</span></div>

                {/* ── Email + Password Sign-Up Form ── */}
                <form className="gs-form" onSubmit={handleSubmit} noValidate>
                {/* Name row */}
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="first-name">First Name</label>
                    <input
                      type="text"
                      id="first-name"
                      className="form-input"
                      required
                      autoComplete="given-name"
                      placeholder="Jane"
                      value={firstName}
                      onChange={e => setFirstName(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="last-name">Last Name</label>
                    <input
                      type="text"
                      id="last-name"
                      className="form-input"
                      required
                      autoComplete="family-name"
                      placeholder="Smith"
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                    />
                  </div>
                </div>

                {/* Email */}
                <div className="form-group">
                  <label className="form-label" htmlFor="email">Email</label>
                  <input
                    type="email"
                    id="email"
                    className="form-input"
                    required
                    autoComplete="email"
                    placeholder="jane@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                  <span className="form-hint">This is how you&apos;ll sign in, and where bid alerts go.</span>
                </div>

                {/* Password + confirm — the alternative to Google, per Dustin 2026-08-26 */}
                <div className="form-group">
                  <label className="form-label" htmlFor="password">Password</label>
                  <input
                    type="password"
                    id="password"
                    className="form-input"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                  <span className="form-hint">Minimum {MIN_PASSWORD_LENGTH} characters.</span>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="confirm-password">Confirm Password</label>
                  <input
                    type="password"
                    id="confirm-password"
                    className="form-input"
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                  />
                </div>

                {/* Phone */}
                <div className="form-group">
                  <label className="form-label" htmlFor="phone">Phone</label>
                  <input
                    type="tel"
                    id="phone"
                    className="form-input"
                    required
                    autoComplete="tel"
                    placeholder="(317) 555-1234"
                    value={phone}
                    onChange={handlePhoneChange}
                    onBlur={handlePhoneChange}
                  />
                  <span className="form-hint">For bid notifications and updates via text.</span>
                </div>

                {/* SMS Consent — TWILIO MESSAGE_FLOW / TCPA */}
                {/* Text source: legal.ts SMS_CONSENT_LABEL + inline privacy/terms links */}
                <div className="form-group">
                  <label className="form-checkbox-wrapper">
                    <input
                      type="checkbox"
                      id="sms-consent"
                      className="form-checkbox"
                      checked={smsConsent}
                      onChange={e => setSmsConsent(e.target.checked)}
                    />
                    <span style={{ fontSize: '0.9rem', lineHeight: 1.5, color: 'var(--slate, #94a3b8)' }}>
                      {/* TWILIO MESSAGE_FLOW required language */}
                      I agree to receive transactional SMS from Otter Quotes. Message frequency varies.
                      Message and data rates may apply. Reply STOP to unsubscribe. See our{' '}
                      <a href="https://otterquote.com/privacy.html" style={{ color: 'var(--amber, #E07B00)', textDecoration: 'underline' }}>
                        Privacy Policy
                      </a>{' '}
                      and{' '}
                      <a href="https://otterquote.com/terms.html" style={{ color: 'var(--amber, #E07B00)', textDecoration: 'underline' }}>
                        Terms of Service
                      </a>
                      .
                    </span>
                  </label>
                </div>

                {/* Property Address */}
                <div className="form-group">
                  <label className="form-label" htmlFor="address">Property Address</label>
                  <input
                    type="text"
                    id="address"
                    className="form-input"
                    required
                    autoComplete="street-address"
                    placeholder="123 Main St, Anytown, ST 12345"
                    value={address}
                    onChange={e => setAddress(e.target.value)}
                  />
                  <span className="form-hint">The address for your project.</span>
                </div>

                {/* Referral Source */}
                <fieldset className="referral-section" style={{ padding: '1rem', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <legend className="referral-legend">How did you hear about us?</legend>
                  <div className="referral-options">
                    {(
                      [
                        { value: 'insurance_agent', label: 'Insurance Agent' },
                        { value: 'realtor', label: 'Realtor' },
                        { value: 'friend', label: 'Friend/Family' },
                        { value: 'web', label: 'Found Online' },
                      ] as { value: ReferralSource; label: string }[]
                    ).map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        className={`referral-chip${referralSource === value ? ' active' : ''}`}
                        onClick={() => handleReferralChip(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {showReferralAgentFields && (
                    <div className="referral-name-row">
                      <div className="form-group">
                        <label className="form-label" htmlFor="ref-name">Their Name</label>
                        <input
                          type="text"
                          id="ref-name"
                          className="form-input"
                          placeholder="Agent / Realtor name"
                          value={refName}
                          onChange={e => setRefName(e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="ref-email">Their Email (optional)</label>
                        <input
                          type="email"
                          id="ref-email"
                          className="form-input"
                          placeholder="agent@company.com"
                          value={refEmail}
                          onChange={e => setRefEmail(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </fieldset>

                {/* Error */}
                {error && <div className="form-error" role="alert">{error}</div>}

                {/* Submit */}
                <button
                  type="submit"
                  className="btn-primary-full"
                  disabled={submitting || googleLoading}
                >
                  {submitting ? (
                    <><span className="btn-loading-spinner" />Creating account…</>
                  ) : (
                    'Create My Free Account'
                  )}
                </button>

                <p className="text-sm-center">
                  By creating an account, you agree to our{' '}
                  <a href="https://otterquote.com/terms.html">Terms of Service</a> and{' '}
                  <a href="https://otterquote.com/privacy.html">Privacy Policy</a>.
                </p>

                <p className="text-sm-center">
                  Already have an account?{' '}
                  <a href={LOGIN_URL}>Sign in here</a>
                </p>

                <p className="text-sm-center">
                  Are you a contractor?{' '}
                  <a href="https://otterquote.com/contractor-join.html">Apply to join here</a>
                </p>
                </form>
              </>
            )}
          </div>
        </div>

        {/* ── Right: Benefits ── */}
        <div className="gs-right">
          <div className="gs-benefits">
            <h2>What Happens Next</h2>

            {/* Copy updated 2026-08-26 with the auth rework — the old first step
                described the magic-link inbox round-trip, which no longer exists
                on this page. */}
            <div className="benefit-item">
              <div className="benefit-icon">🔐</div>
              <div className="benefit-text">
                <h4>Create your account</h4>
                <p>Sign up with Google or set a password. You stay on the site — no waiting on an email to get started.</p>
              </div>
            </div>

            <div className="benefit-item">
              <div className="benefit-icon">📄</div>
              <div className="benefit-text">
                <h4>Build your project details</h4>
                <p>Upload your documents or use our &ldquo;Help Me&rdquo; tools. We&apos;ll guide you through everything.</p>
              </div>
            </div>

            <div className="benefit-item">
              <div className="benefit-icon">🎯</div>
              <div className="benefit-text">
                <h4>Contractors compete</h4>
                <p>Licensed contractors in your area submit quotes for your job. You compare and choose the best deal.</p>
              </div>
            </div>

            <div className="benefit-item">
              <div className="benefit-icon">💰</div>
              <div className="benefit-text">
                <h4>Always free for you</h4>
                <p>Otter Quotes is 100% free for homeowners. Contractors pay to earn your business, not you.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Google "G" mark (same SVG as /login and the static login.html) ──────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
