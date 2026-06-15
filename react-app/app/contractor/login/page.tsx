/**
 * Contractor Login — D-211 P4
 *
 * Contractor sign-in entry (port of static contractor-login.html). Byte-for-byte
 * copy lives in ./copy.ts (D-244 verbatim-locked login-path copy) and is asserted
 * by the co-located parity test. Reuses the live React auth scaffolding — does
 * NOT re-implement auth (mirrors the merged P3 /login):
 *   - useAuthReady() gates on `loading` (F-007 race-free) before reading user/role
 *   - direct `supabase` Google OAuth + magic-link calls (no React Query in pages)
 *   - magic link + OAuth land on the React /auth-callback route (app.otterquote.com)
 *
 * Contractor-table-first (the key P4 difference vs P3 /login):
 *   - sets localStorage cs_auth_role='contractor' before BOTH flows; /auth-callback
 *     reads it to route (existing contractor record → contractor-dashboard.html;
 *     intent=contractor + no record yet → contractor-pre-approval.html).
 *   - already-authenticated handling is contractor-scoped: only an authenticated
 *     CONTRACTOR is redirected to the dashboard; homeowners/unknown roles stay on
 *     this page so they can sign in with a contractor account (parity with the
 *     static page). The dashboard ↔ login flip loop is broken via document.referrer.
 *
 * Auth model preserved: D-212 cross-subdomain cookie SSO + contractor-table-first
 * role resolution, both supplied by the shared AuthProvider / cookie-storage.
 */

'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { CONTRACTOR_LOGIN_COPY as C } from './copy';
import {
  AUTH_CALLBACK_URL,
  GOOGLE_OAUTH_REDIRECT,
  CONTRACTOR_DASHBOARD_URL,
  CONTRACTOR_JOIN_URL,
  LOGIN_URL,
  isValidEmail,
  cameFromContractorDashboard,
} from './utils';

// ─── GA4 helper (parity with contractor-login.html gtag) ──────────────
function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as { gtag?: (...a: unknown[]) => void }).gtag) {
    (window as { gtag: (...a: unknown[]) => void }).gtag(...args);
  }
}

function referrer(): string {
  return typeof document !== 'undefined' ? document.referrer : '';
}

export default function ContractorLoginPage() {
  const { user, role, loading } = useAuthReady();

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState('');

  // ── Already-authenticated redirect — CONTRACTOR-ONLY ──
  // Only an authenticated contractor is sent to the dashboard. Homeowners and
  // unknown roles intentionally stay here so they can sign in as a contractor
  // (parity with contractor-login.html). The referrer check breaks the
  // documented dashboard ↔ login flip loop (May 4 2026).
  useEffect(() => {
    if (loading || !user) return;
    if (role !== 'contractor') return;
    if (cameFromContractorDashboard(referrer())) {
      console.warn('[contractor-login] return-bounce from contractor-dashboard; staying to break the loop.');
      return;
    }
    window.location.href = CONTRACTOR_DASHBOARD_URL;
  }, [loading, user, role]);

  // ── Magic-link submit (mirrors Auth.sendMagicLink(email,'contractor','/auth-callback.html')) ──
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = email.trim();
    if (!trimmed || !isValidEmail(trimmed)) {
      setError(C.errorInvalidEmail);
      return;
    }

    setSubmitting(true);
    try {
      // cs_auth_role drives /auth-callback's contractor-table-first routing.
      localStorage.setItem('cs_auth_role', 'contractor');
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: AUTH_CALLBACK_URL },
      });
      if (otpError) throw otpError;

      setSentToEmail(trimmed);
      setMagicLinkSent(true);
      gtag('event', 'login', { method: 'magic_link', role: 'contractor' });
    } catch (err) {
      console.error('Login error:', err);
      setError(C.errorGenericPrefix + C.supportEmail);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Resend (D-244 locked alert copy) ──
  const handleResend = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!sentToEmail) return;
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: sentToEmail,
        options: { emailRedirectTo: AUTH_CALLBACK_URL },
      });
      if (otpError) throw otpError;
      alert(C.resendAlert);
    } catch {
      alert(C.resendErrorAlert);
    }
  };

  // ── Google OAuth (D-207 primary sign-in) ──
  const handleGoogle = async () => {
    setError('');
    setGoogleLoading(true);
    try {
      localStorage.setItem('cs_auth_role', 'contractor');
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: GOOGLE_OAUTH_REDIRECT },
      });
      if (oauthError) throw oauthError;
      // On success the browser navigates to Google; nothing else to do.
    } catch (err) {
      console.error('Google sign-in error:', err);
      setGoogleLoading(false);
      setError(C.errorGoogle);
    }
  };

  // ── Loading / redirect-in-flight ──
  // Spinner while auth resolves, or while an authenticated contractor (not a
  // dashboard return-bounce) is being redirected away.
  const redirectingContractor =
    !!user && role === 'contractor' && !cameFromContractorDashboard(referrer());
  if (loading || redirectingContractor) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="oq-cl-spin" style={{ width: 28, height: 28, border: '3px solid rgba(224,123,0,0.2)', borderTopColor: 'var(--amber, #E07B00)', borderRadius: '50%' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } } .oq-cl-spin { animation: spin 0.8s linear infinite; }`}</style>
      </div>
    );
  }

  return (
    <>
      <style>{STYLES}</style>

      <div className="cl-layout">
        {/* ── Left: form ── */}
        <div className="cl-left">
          <div className="cl-form-wrap">
            <h1>{C.title}</h1>
            <p className="cl-subtitle">{C.subtitle}</p>

            {magicLinkSent ? (
              /* ── D-244 verbatim-locked magic-link-sent state ── */
              <div className="magic-link-sent active">
                <div className="magic-link-icon">✉️</div>
                <h2>{C.sentHeading}</h2>
                <p>{C.sentBody}</p>
                <div className="magic-link-email">{sentToEmail}</div>
                <p style={{ marginTop: '1rem' }}>{C.sentExpiry}</p>
                <p style={{ marginTop: '1.5rem' }}>
                  <button type="button" className="resend-link" onClick={handleResend}>
                    {C.sentResend}
                  </button>
                </p>
              </div>
            ) : (
              <>
                {/* Google OAuth — D-207 primary sign-in */}
                <button
                  type="button"
                  className="btn-google"
                  onClick={handleGoogle}
                  disabled={googleLoading}
                >
                  {googleLoading ? (
                    C.googleRedirecting
                  ) : (
                    <>
                      <GoogleIcon />
                      {C.googleButton}
                    </>
                  )}
                </button>
                <div className="oauth-divider"><span>{C.oauthDivider}</span></div>

                <form className="cl-form" onSubmit={handleSubmit} noValidate>
                  <div className="form-group">
                    <label className="form-label" htmlFor="email">{C.emailLabel}</label>
                    <input
                      type="email"
                      id="email"
                      className="form-input"
                      required
                      autoComplete="email"
                      placeholder={C.emailPlaceholder}
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                    />
                    <span className="form-hint">{C.emailHint}</span>
                  </div>

                  {error && <div className="form-error" role="alert">{error}</div>}

                  <button type="submit" className="btn-primary-full" disabled={submitting}>
                    {submitting ? <><span className="btn-loading-spinner" />{C.submitButton}</> : C.submitButton}
                  </button>
                </form>

                {/* D-242 cross-role sibling link */}
                <p className="cross-role-link">
                  {C.homeownerPrefix}{' '}
                  <a href={LOGIN_URL}>{C.homeownerLink}</a>
                </p>

                {/* Join CTA */}
                <div className="cl-divider">{C.joinDivider}</div>
                <div className="cl-join-cta">
                  <p>{C.joinPrompt}</p>
                  <a href={CONTRACTOR_JOIN_URL} className="btn-secondary-full">{C.joinButton}</a>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Right: benefits ── */}
        <div className="cl-right">
          <div className="cl-benefits">
            <h2>{C.benefitsHeading}</h2>
            {C.benefits.map(item => (
              <div className="benefit-item" key={item.h}>
                <div className="benefit-icon">{item.icon}</div>
                <div className="benefit-text">
                  <h4>{item.h}</h4>
                  <p>{item.p}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ─── Google "G" mark (matches contractor-login.html 18×18 SVG) ───────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
      <path d="M3.964 10.706A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05" />
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
    </svg>
  );
}

// ─── Styles (self-contained; mirrors contractor-login.html + dark theme) ────
const STYLES = `
  .cl-layout { display: grid; grid-template-columns: 1fr 1fr; min-height: calc(100vh - 64px); }
  .cl-left { display: flex; align-items: center; justify-content: center; padding: var(--sp-12, 3rem) var(--sp-8, 2rem); }
  .cl-form-wrap { width: 100%; max-width: 440px; }
  .cl-form-wrap h1 { font-size: 2rem; margin-bottom: var(--sp-2, 0.5rem); color: var(--white, #fff); }
  .cl-subtitle { color: var(--slate, #94a3b8); font-size: 1rem; margin-bottom: var(--sp-8, 2rem); line-height: 1.6; }
  .btn-google { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 12px 20px; border-radius: 8px; border: 2px solid #dadce0; background: #fff; cursor: pointer; font-size: 1rem; font-weight: 500; color: #3c4043; transition: box-shadow 0.15s, background 0.15s; font-family: inherit; }
  .btn-google:hover:not(:disabled) { background: #f8f9fa; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  .btn-google:disabled { opacity: 0.6; cursor: not-allowed; }
  .oauth-divider { display: flex; align-items: center; gap: 12px; margin: 18px 0; color: var(--gray, #64748b); font-size: 0.875rem; }
  .oauth-divider::before, .oauth-divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.12); }
  .cl-form { display: flex; flex-direction: column; gap: var(--sp-5, 1.25rem); }
  .form-group { display: flex; flex-direction: column; gap: var(--sp-1, 0.25rem); }
  .form-label { font-size: 0.875rem; font-weight: 600; color: var(--white, #fff); }
  .form-input { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 10px 14px; color: var(--white, #fff); font-size: 1rem; width: 100%; box-sizing: border-box; font-family: inherit; transition: border-color 0.15s; }
  .form-input:focus { outline: none; border-color: var(--amber, #E07B00); }
  .form-hint { font-size: 0.8rem; color: var(--slate, #94a3b8); }
  .form-error { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); border-left: 4px solid #EF4444; color: #FECACA; padding: 12px 16px; border-radius: 8px; font-size: 0.9rem; }
  .btn-primary-full { background: var(--amber, #E07B00); color: var(--navy, #0B1929); border: none; border-radius: 8px; padding: 14px 24px; font-size: 1rem; font-weight: 700; cursor: pointer; width: 100%; font-family: inherit; transition: all 0.15s; position: relative; }
  .btn-primary-full:hover:not(:disabled) { background: #f08c10; transform: translateY(-1px); }
  .btn-primary-full:disabled { opacity: 0.6; cursor: not-allowed; }
  .btn-loading-spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(11,25,41,0.3); border-top-color: var(--navy, #0B1929); border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 8px; }
  .cross-role-link { font-size: 0.85rem; text-align: center; color: var(--gray, #64748b); margin: 1rem 0 0; }
  .cross-role-link a { color: var(--amber, #E07B00); font-weight: 600; text-decoration: none; }
  .cl-divider { display: flex; align-items: center; gap: var(--sp-4, 1rem); margin: var(--sp-6, 1.5rem) 0; color: var(--gray, #64748b); font-size: 0.85rem; }
  .cl-divider::before, .cl-divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.1); }
  .cl-join-cta { text-align: center; padding: var(--sp-6, 1.5rem); background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; }
  .cl-join-cta p { color: var(--slate, #94a3b8); font-size: 0.95rem; margin: 0 0 var(--sp-4, 1rem); }
  .btn-secondary-full { display: inline-block; width: 100%; box-sizing: border-box; background: transparent; color: var(--white, #fff); border: 1.5px solid rgba(255,255,255,0.25); border-radius: 8px; padding: 12px 24px; font-size: 1rem; font-weight: 700; cursor: pointer; font-family: inherit; text-decoration: none; transition: border-color 0.15s, background 0.15s; }
  .btn-secondary-full:hover { border-color: var(--amber, #E07B00); background: rgba(224,123,0,0.08); }
  .magic-link-sent { text-align: center; padding: var(--sp-8, 2rem) 0; }
  .magic-link-icon { font-size: 3rem; margin-bottom: 1rem; }
  .magic-link-sent h2 { font-size: 1.5rem; color: var(--white, #fff); margin-bottom: 0.75rem; }
  .magic-link-sent p { color: var(--slate, #94a3b8); max-width: 340px; margin: 0 auto; }
  .magic-link-email { display: inline-block; background: rgba(224,123,0,0.12); color: var(--amber, #E07B00); font-weight: 700; padding: 6px 14px; border-radius: 4px; margin: 12px 0; font-family: monospace; font-size: 0.9rem; }
  .resend-link { color: var(--amber, #E07B00); text-decoration: underline; cursor: pointer; background: none; border: none; font-family: inherit; font-size: inherit; }
  .cl-right { background: var(--navy-2, #0f2036); display: flex; align-items: center; justify-content: center; padding: var(--sp-12, 3rem) var(--sp-8, 2rem); border-left: 1px solid rgba(255,255,255,0.06); }
  .cl-benefits { max-width: 380px; }
  .cl-benefits h2 { font-size: 1.5rem; color: var(--white, #fff); margin-bottom: var(--sp-8, 2rem); line-height: 1.4; }
  .benefit-item { display: flex; gap: var(--sp-4, 1rem); margin-bottom: var(--sp-6, 1.5rem); }
  .benefit-icon { width: 40px; height: 40px; border-radius: 8px; background: rgba(224,123,0,0.12); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; }
  .benefit-text h4 { font-size: 0.95rem; font-weight: 700; color: var(--white, #fff); margin: 0 0 4px; }
  .benefit-text p { font-size: 0.85rem; color: var(--slate, #94a3b8); margin: 0; line-height: 1.5; }
  @media (max-width: 768px) {
    .cl-layout { grid-template-columns: 1fr; }
    .cl-right { display: none; }
    .cl-left { padding: 2rem 1.5rem; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
