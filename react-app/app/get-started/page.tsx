/**
 * Get Started — D-211 Phase 2
 *
 * Homeowner sign-up page (magic link email/password).
 * Feature-parity with static get-started.html.
 *
 * Auth flow:
 *   - If user is already logged in, redirect to appropriate dashboard.
 *   - New users: collect profile data → fire HubSpot (non-blocking) →
 *     leads insert (non-fatal) → write localStorage → signInWithOtp.
 *
 * References: D-189 (HubSpot), D-211 (React surface) [D-207 Google OAuth removed pre-launch]
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { formatPhoneValue, isValidEmail } from './utils';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const AUTH_CALLBACK_URL = 'https://app.otterquote.com/auth-callback';
const DASHBOARD_URL = 'https://otterquote.com/dashboard.html';
const CONTRACTOR_DASHBOARD_URL = 'https://otterquote.com/contractor-dashboard.html';
const SUPPORT_EMAIL = 'info@otterquote.com';

type ReferralSource = 'insurance_agent' | 'realtor' | 'friend' | 'web' | '';

// ─── GA4 helper ──────────────────────────────────────────────────────────────

function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag(...args);
  }
}

// ─── HubSpot — D-189 non-blocking fire ───────────────────────────────────────

function fireHubSpotContact(data: {
  email: string;
  firstname: string;
  lastname: string;
  phone: string;
  address: string;
}) {
  fetch(`${SUPABASE_URL}/functions/v1/create-hubspot-contact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(data),
  }).catch(() => {
    // Intentionally fire-and-forget — D-189
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function GetStartedPage() {
  const { user, role, loading } = useAuthReady();

  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [referralSource, setReferralSource] = useState<ReferralSource>('');
  const [refName, setRefName] = useState('');
  const [refEmail, setRefEmail] = useState('');

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState('');

  // ── Redirect if already logged in ──
  useEffect(() => {
    if (loading) return;
    if (!user) return;
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

  // ── Form submission ──
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !phone.trim() || !address.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    if (!isValidEmail(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    // SMS consent optional per TCR/CTIA rules — do not block on unchecked

    setSubmitting(true);

    try {
      const emailTrimmed = email.trim();

      // D-189: Fire HubSpot contact — non-blocking, best-effort
      fireHubSpotContact({
        email: emailTrimmed,
        firstname: firstName.trim(),
        lastname: lastName.trim(),
        phone: phone.trim(),
        address: address.trim(),
      });

      // 1. Insert into leads table (non-fatal, fire-and-forget — no await)
      supabase.from('leads').insert({
        name: `${firstName.trim()} ${lastName.trim()}`,
        email: emailTrimmed,
        source: referralSource || 'web',
        created_at: new Date().toISOString(),
      }).then(({ error: leadErr }) => {
        if (leadErr) console.warn('[get-started] leads insert failed (non-fatal):', leadErr);
      });

      // 2. Persist referral attribution from storage
      const storedReferralId =
        (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('oq_referral_id')) ||
        (typeof localStorage !== 'undefined' && localStorage.getItem('oq_referral_id')) ||
        null;
      const storedReferralAgentId =
        typeof sessionStorage !== 'undefined'
          ? sessionStorage.getItem('oq_referral_agent_id')
          : null;

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

      // 4. Persist referral_id so auth-callback can advance referral status
      if (storedReferralId) {
        localStorage.setItem('oq_referral_id', storedReferralId);
      }

      // 5. Store intended role for post-auth routing
      localStorage.setItem('cs_auth_role', 'homeowner');

      // 6. Send magic link
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: emailTrimmed,
        options: {
          emailRedirectTo: AUTH_CALLBACK_URL,
          data: { role: 'homeowner' },
        },
      });
      if (otpError) throw otpError;

      // 7. Show success state
      setSentToEmail(emailTrimmed);
      setMagicLinkSent(true);

      // 8. GA4 events
      const params = new URLSearchParams(
        typeof window !== 'undefined' ? window.location.search : '',
      );
      gtag('event', 'sign_up', {
        method: 'magic_link',
        referral_source: referralSource || 'web',
      });
      gtag('event', 'homeowner_signup', {
        job_type: params.get('job_type') || null,
        source: params.get('utm_source') || referralSource || 'direct',
      });
    } catch (err: unknown) {
      console.error('[get-started] signup error:', err);
      const msg =
        err instanceof Error ? err.message : 'An unexpected error occurred.';
      setError(`Something went wrong. Please try again or email us at ${SUPPORT_EMAIL}. (${msg})`);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Resend magic link ──
  const handleResend = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!sentToEmail) return;
    try {
      await supabase.auth.signInWithOtp({
        email: sentToEmail,
        options: {
          emailRedirectTo: AUTH_CALLBACK_URL,
          data: { role: 'homeowner' },
        },
      });
      alert('Magic link resent! Check your email.');
    } catch {
      alert('Could not resend. Please try again in a moment.');
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
        .magic-link-sent {
          text-align: center;
          padding: var(--sp-8, 2rem) 0;
        }
        .magic-link-icon { font-size: 3rem; margin-bottom: 1rem; }
        .magic-link-sent h2 {
          font-size: 1.5rem;
          color: var(--white, #fff);
          margin-bottom: 0.75rem;
        }
        .magic-link-sent p {
          color: var(--slate, #94a3b8);
          max-width: 340px;
          margin: 0 auto;
        }
        .magic-link-email {
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
        .resend-link {
          color: var(--amber, #E07B00);
          text-decoration: underline;
          cursor: pointer;
          background: none;
          border: none;
          font-family: inherit;
          font-size: inherit;
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

            {/* ── Magic Link Sent State ── */}
            {magicLinkSent ? (
              <div className="magic-link-sent">
                <div className="magic-link-icon">✉️</div>
                <h2>Check Your Email</h2>
                <p>We sent a secure login link to:</p>
                <div className="magic-link-email">{sentToEmail}</div>
                <p style={{ marginTop: '1rem' }}>
                  Click the link in your email to access your dashboard. The link expires in 1 hour.
                </p>
                <p style={{ marginTop: '1.5rem' }}>
                  <button className="resend-link" onClick={handleResend}>
                    Didn&apos;t get it? Send again
                  </button>
                </p>
              </div>
            ) : (
              /* ── Email Sign-Up Form ── */
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
                  <span className="form-hint">We&apos;ll send you a secure login link — no password needed.</span>
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
                  disabled={submitting}
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
                  <a href="https://otterquote.com/login.html">Sign in here</a>
                </p>

                <p className="text-sm-center">
                  Are you a contractor?{' '}
                  <a href="https://otterquote.com/contractor-login.html">Sign in to your contractor account</a>
                </p>
              </form>
            )}
          </div>
        </div>

        {/* ── Right: Benefits ── */}
        <div className="gs-right">
          <div className="gs-benefits">
            <h2>What Happens Next</h2>

            <div className="benefit-item">
              <div className="benefit-icon">✉️</div>
              <div className="benefit-text">
                <h4>Check your email</h4>
                <p>We&apos;ll send a secure magic link. Click it to log in — no password to remember.</p>
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
