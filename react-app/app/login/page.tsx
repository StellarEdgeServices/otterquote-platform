/**
 * Login — D-211 P3
 *
 * Homeowner sign-in entry. Byte-for-byte copy port of the static login.html
 * (D-244 verbatim-locked login-path copy lives in ./copy.ts and is asserted by
 * the co-located parity test). Reuses the live React auth scaffolding — does
 * NOT re-implement auth:
 *   - useAuthReady() gates on `loading` (F-007 race-free) before reading user/role
 *   - direct `supabase` Google OAuth + magic-link calls (no React Query in pages)
 *   - magic link + OAuth land on the React /auth-callback route (app.otterquote.com)
 *   - already-authenticated users are sent to their role-appropriate app shell,
 *     UNLESS bounced here by the admin gate (?reason=admin_required), so the
 *     "admin required" banner stays visible (parity with login.html).
 *
 * Auth model preserved: D-212 cross-subdomain cookie SSO + contractor-table-first
 * role resolution, both supplied by the shared AuthProvider / cookie-storage.
 */

'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { LOGIN_COPY as C } from './copy';
import {
  AUTH_CALLBACK_URL,
  GOOGLE_OAUTH_REDIRECT,
  CONTRACTOR_LOGIN_URL,
  GET_STARTED_URL,
  dashboardUrlForRole,
  isValidEmail,
} from './utils';

// ─── GA4 helper (parity with login.html gtag) ──────────────────────────
function gtag(...args: unknown[]) {
  if (typeof window !== 'undefined' && (window as { gtag?: (...a: unknown[]) => void }).gtag) {
    (window as { gtag: (...a: unknown[]) => void }).gtag(...args);
  }
}

function isFromAdminGate(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('reason') === 'admin_required';
}

export default function LoginPage() {
  const { user, role, loading } = useAuthReady();

  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [sentToEmail, setSentToEmail] = useState('');

  // Computed each render (client-only; guarded for SSR). Drives both the banner
  // and the already-authenticated redirect guard.
  const fromAdminGate = isFromAdminGate();

  // ── Already-authenticated redirect (skipped when bounced from admin gate) ──
  useEffect(() => {
    if (loading || !user) return;
    if (fromAdminGate) return;
    window.location.href = dashboardUrlForRole(role);
  }, [loading, user, role, fromAdminGate]);

  // ── Magic-link submit (mirrors Auth.sendMagicLink homeowner → /auth-callback) ──
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
      localStorage.setItem('cs_auth_role', 'homeowner');
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: AUTH_CALLBACK_URL },
      });
      if (otpError) throw otpError;

      setSentToEmail(trimmed);
      setMagicLinkSent(true);
      gtag('event', 'login', { method: 'magic_link' });
    } catch (err) {
      console.error('Login error:', err);
      setError(C.errorGeneric);
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
      localStorage.setItem('cs_auth_role', 'homeowner');
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
  // Spinner while auth is resolving, or while an authenticated (non-admin-gate)
  // user is being redirected away.
  if (loading || (user && !fromAdminGate)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="oq-login-spin" style={{ width: 28, height: 28, border: '3px solid rgba(224,123,0,0.2)', borderTopColor: 'var(--amber, #E07B00)', borderRadius: '50%' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } } .oq-login-spin { animation: spin 0.8s linear infinite; }`}</style>
      </div>
    );
  }

  return (
    <>
      <style>{STYLES}</style>

      <div className="login-layout">
        {/* ── Left: form ── */}
        <div className="login-left">
          <div className="login-form-wrap">
            {fromAdminGate && (
              <div className="admin-required-banner" role="alert">
                <strong>{C.adminBannerStrong}</strong>
                {C.adminBannerRest}
              </div>
            )}

            <h1>{C.title}</h1>
            <p className="login-subtitle">{C.subtitle}</p>

            {magicLinkSent ? (
              /* ── D-244 verbatim-locked magic-link-sent state ── */
              <div className="magic-link-sent">
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

                <form className="login-form" onSubmit={handleSubmit} noValidate>
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

                  <p className="text-sm-center">
                    {C.noAccountPrefix}{' '}
                    <a href={GET_STARTED_URL}>{C.noAccountLink}</a>
                  </p>

                  <p className="text-sm-center">
                    {C.contractorPrefix}{' '}
                    <a href={CONTRACTOR_LOGIN_URL}>{C.contractorLink}</a>
                  </p>
                </form>
              </>
            )}
          </div>
        </div>

        {/* ── Right: info panel ── */}
        <div className="login-right">
          <div className="login-info">
            <h2>{C.infoHeading}</h2>
            {C.info.map(item => (
              <div className="info-item" key={item.h}>
                <div className="info-icon">{item.icon}</div>
                <div className="info-text">
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

// ─── Google "G" mark (matches login.html SVG) ───────────────────────
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

// ─── Styles (self-contained; mirrors login.html + /get-started dark theme) ────
const STYLES = `
  .login-layout { display: grid; grid-template-columns: 1fr 1fr; min-height: calc(100vh - 64px); }
  .login-left { display: flex; align-items: center; justify-content: center; padding: var(--sp-12, 3rem) var(--sp-8, 2rem); }
  .login-form-wrap { width: 100%; max-width: 440px; }
  .login-form-wrap h1 { font-size: 2rem; margin-bottom: var(--sp-2, 0.5rem); color: var(--white, #fff); }
  .login-subtitle { color: var(--slate, #94a3b8); font-size: 1rem; margin-bottom: var(--sp-8, 2rem); line-height: 1.6; }
  .admin-required-banner { background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 0.5rem; padding: 0.875rem 1rem; margin-bottom: 1.25rem; font-size: 0.9rem; color: #92400E; }
  .btn-google { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; padding: 12px 20px; border-radius: 8px; border: 1.5px solid #dadce0; background: #fff; cursor: pointer; font-size: 15px; font-weight: 500; color: #3c4043; transition: box-shadow 0.15s, border-color 0.15s; font-family: inherit; margin-bottom: 16px; }
  .btn-google:hover:not(:disabled) { box-shadow: 0 1px 4px rgba(0,0,0,.16); border-color: #c6c9cd; }
  .btn-google:disabled { opacity: 0.7; cursor: not-allowed; }
  .oauth-divider { display: flex; align-items: center; gap: 12px; margin: 4px 0 16px; color: var(--gray, #64748b); font-size: 13px; }
  .oauth-divider::before, .oauth-divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.12); }
  .login-form { display: flex; flex-direction: column; gap: var(--sp-5, 1.25rem); }
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
  .text-sm-center { font-size: 0.85rem; text-align: center; color: var(--gray, #64748b); margin: 0; }
  .text-sm-center a { color: var(--amber, #E07B00); font-weight: 600; text-decoration: none; }
  .magic-link-sent { text-align: center; padding: var(--sp-8, 2rem) 0; }
  .magic-link-icon { font-size: 3rem; margin-bottom: 1rem; }
  .magic-link-sent h2 { font-size: 1.5rem; color: var(--white, #fff); margin-bottom: 0.75rem; }
  .magic-link-sent p { color: var(--slate, #94a3b8); max-width: 340px; margin: 0 auto; }
  .magic-link-email { display: inline-block; background: rgba(224,123,0,0.12); color: var(--amber, #E07B00); font-weight: 700; padding: 6px 14px; border-radius: 4px; margin: 12px 0; font-family: monospace; font-size: 0.9rem; }
  .resend-link { color: var(--amber, #E07B00); text-decoration: underline; cursor: pointer; background: none; border: none; font-family: inherit; font-size: inherit; }
  .login-right { background: var(--navy-2, #0f2036); display: flex; align-items: center; justify-content: center; padding: var(--sp-12, 3rem) var(--sp-8, 2rem); border-left: 1px solid rgba(255,255,255,0.06); }
  .login-info { max-width: 380px; }
  .login-info h2 { font-size: 1.5rem; color: var(--white, #fff); margin-bottom: var(--sp-6, 1.5rem); }
  .info-item { display: flex; gap: var(--sp-4, 1rem); margin-bottom: var(--sp-5, 1.25rem); }
  .info-icon { width: 40px; height: 40px; border-radius: 8px; background: rgba(224,123,0,0.12); display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; }
  .info-text h4 { font-size: 0.95rem; font-weight: 700; color: var(--white, #fff); margin: 0 0 4px; }
  .info-text p { font-size: 0.85rem; color: var(--slate, #94a3b8); margin: 0; line-height: 1.5; }
  @media (max-width: 768px) {
    .login-layout { grid-template-columns: 1fr; }
    .login-right { border-left: none; border-bottom: 1px solid rgba(255,255,255,0.06); padding: 1.5rem; order: -1; }
    .login-info h2 { font-size: 1.25rem; margin-bottom: 1rem; }
    .login-left { padding: 2rem 1.5rem; }
  }
  @keyframes spin { to { transform: rotate(360deg); } }
`;
