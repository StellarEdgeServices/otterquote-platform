'use client';

/**
 * Homeowner Help-Measurements surface — /help-measurements (D-211 Phase 28, PR 2/2).
 * Behaviour-faithful React port of help-measurements.html (repo root).
 *
 * Auth-gated by the existing (homeowner) _shell HomeownerShell (active="dashboard"),
 * exactly like the sibling H5 color-selection / H7 help-estimate sub-pages — no auth or
 * launch-gate handling is re-implemented here.
 *
 * Layers:
 *   • Locked copy + pure builders: ./copy (MEASUREMENTS_COPY) + ./utils (PR 1/2 — IMPORTED).
 *   • Data + EF-backed mutations:  ./use-help-measurements-data (reads + the three
 *     Services.* calls against the UNCHANGED Edge Functions).
 *   • Stripe card form:            ./HoverPaymentForm (CDN Stripe.js, publishable key only).
 *
 * Tier-3 boundary (the $150 Hover charge): this page only CALLS the already-hardened
 * create-payment-intent / create-hover-order / send-adjuster-email Edge Functions through
 * the Services layer with their contracts UNCHANGED. No EF/SQL/price/idempotency/DocuSign
 * change is made.
 *
 * Two paths, ported in the static's exact order:
 *   A. Hover (paid): create PaymentIntent → mount card form → confirmCardPayment → order
 *      created ONLY after paymentIntent.status === 'succeeded' (D-181 guard re-checked by
 *      the EF). A decline surfaces and does NOT create an order.
 *   B. Ask Adjuster (free): sendAdjusterEmail → write entered adjuster fields back into the
 *      claim ONLY where currently empty → email success state.
 *
 * Intentional, flagged deltas from the static (see PR body):
 *   • Path B advances to the email SUCCESS STATE on send (per the brief WIRING + to surface
 *     PR-1's locked emailSuccess* copy). The static never activated #emailSuccessSection —
 *     it only flipped the button to '✓ Email Sent!' + a toast (dead success markup). The
 *     unrendered locked strings (emailSentButton, statusEmailSent) are kept in copy.ts.
 *   • The email-preview area renders ONLY the locked 'Loading...' placeholder. The static's
 *     updateEmailPreview() is called-but-never-defined and there is NO preview-body template
 *     in the file, so no body is fabricated (PR-1 utils.ts header documents this).
 *   • No-claim edge: both actions require a loaded claim and surface an error rather than
 *     fabricate a "sent" success (the static silently showed success with no DB write).
 */

import { useCallback, useState } from 'react';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { MEASUREMENTS_COPY as M } from './copy';
import { isAdjusterFormValid, type MeasurementsUser } from './utils';
import {
  useHelpMeasurementsData,
  requestHoverPaymentIntent,
  placeHoverOrder,
  sendMeasurementRequest,
  type HelpMeasurementsData,
} from './use-help-measurements-data';
import { HoverPaymentForm, isStripeConfigured } from './HoverPaymentForm';

// ── Top-level page ───────────────────────────────────────────────────────────────

export default function HelpMeasurementsPage() {
  return (
    <HomeownerShell active="dashboard">
      <style>{STYLES}</style>
      <Content />
    </HomeownerShell>
  );
}

function Content() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const data = useHelpMeasurementsData(userId, true);

  if (data.loading) return <Boot />;

  const measUser: MeasurementsUser | null = user
    ? { id: user.id, email: user.email ?? null }
    : null;

  return <PageBody data={data} user={measUser} />;
}

// ── Page body: path state machine ───────────────────────────────────────────────

type View = 'select' | 'hover' | 'adjuster';
type HoverStage = 'intro' | 'card' | 'success';
type AdjusterStage = 'form' | 'success';
type Status = { text: string; type: 'success' | 'error' } | null;

function PageBody({
  data,
  user,
}: {
  data: HelpMeasurementsData;
  user: MeasurementsUser | null;
}) {
  const { claim, profile, alreadySentBoth } = data;

  const [view, setView] = useState<View>('select');
  const [status, setStatus] = useState<Status>(null);

  // ── Path A (Hover) state ──
  const [hoverStage, setHoverStage] = useState<HoverStage>('intro');
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [hoverLoading, setHoverLoading] = useState(false);

  // ── Path B (Adjuster) state ──
  const [adjStage, setAdjStage] = useState<AdjusterStage>('form');
  const [adjusterName, setAdjusterName] = useState(claim?.adjuster_name ?? '');
  const [adjusterEmail, setAdjusterEmail] = useState(claim?.adjuster_email ?? '');
  const [adjusterPhone, setAdjusterPhone] = useState(claim?.adjuster_phone ?? '');
  const [sending, setSending] = useState(false);

  const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  const selectPath = useCallback((path: 'hover' | 'adjuster') => {
    setStatus(null);
    if (path === 'hover') {
      setHoverStage('intro');
      setView('hover');
    } else {
      setAdjStage('form');
      setView('adjuster');
    }
    scrollTop();
  }, []);

  const goBack = useCallback(() => {
    setStatus(null);
    setView('select');
    scrollTop();
  }, []);

  // ── Path A — step 1: create the PaymentIntent, then show the card form ──
  const purchaseHover = useCallback(async () => {
    if (!claim?.id) {
      setStatus({ text: M.statusPaymentInitError, type: 'error' });
      return;
    }
    // Mirror the static's pre-PI Stripe gate (initHoverStripe throws without a key).
    if (!isStripeConfigured()) {
      setStatus({ text: M.statusPaymentInitError, type: 'error' });
      return;
    }
    setHoverLoading(true);
    setStatus(null);
    try {
      const res = await requestHoverPaymentIntent(claim);
      if (!res?.client_secret) {
        setStatus({ text: M.statusPaymentInitError, type: 'error' });
        return;
      }
      setClientSecret(res.client_secret);
      setHoverStage('card');
    } catch {
      setStatus({ text: M.statusPaymentInitError, type: 'error' });
    } finally {
      setHoverLoading(false);
    }
  }, [claim]);

  // ── Path A — step 2: payment succeeded → create the Hover order ──
  // Throwing here propagates to HoverPaymentForm.onPay (error shown by the card, Pay
  // re-enabled) — the static's confirmHoverPayment catch behaviour. A graceful
  // EF-pending result resolves (placeholder) and advances to the success state.
  const handlePaid = useCallback(
    async (paymentIntentId: string) => {
      if (!claim) throw new Error('Missing claim. Please refresh and try again.');
      await placeHoverOrder({ profile, claim, user, paymentIntentId });
      setHoverStage('success');
    },
    [profile, claim, user],
  );

  const cancelHoverPayment = useCallback(() => {
    setClientSecret(null);
    setHoverStage('intro');
  }, []);

  // ── Path B — send the measurement request, then advance to success ──
  const handleSend = useCallback(async () => {
    const name = adjusterName.trim();
    const email = adjusterEmail.trim();
    const phone = adjusterPhone.trim();
    if (!isAdjusterFormValid({ adjusterEmail: email })) {
      setStatus({ text: M.statusEmailValidation, type: 'error' });
      return;
    }
    if (!claim?.id) {
      setStatus({ text: M.statusEmailError, type: 'error' });
      return;
    }
    setSending(true);
    setStatus(null);
    try {
      await sendMeasurementRequest({
        claim,
        profile,
        adjusterName: name,
        adjusterEmail: email,
        adjusterPhone: phone,
      });
      setAdjStage('success');
    } catch {
      setStatus({ text: M.statusEmailError, type: 'error' });
      setSending(false);
    }
  }, [adjusterName, adjusterEmail, adjusterPhone, claim, profile]);

  const canSend = isAdjusterFormValid({ adjusterEmail: adjusterEmail.trim() }) && !sending;

  return (
    <div className="hm-container">
      {status && (
        <div
          className={'hm-status ' + status.type}
          role={status.type === 'error' ? 'alert' : 'status'}
        >
          {status.text}
        </div>
      )}

      <div className="hm-header">
        <div>
          <h1 className="hm-title">{M.pageTitle}</h1>
          <p className="hm-subtitle">{M.pageSubtitle}</p>
        </div>
        <a className="hm-back" href="/dashboard">
          {M.backLink}
        </a>
      </div>

      {/* ── Path selection ── */}
      {view === 'select' && (
        <div>
          <div className="hm-path-intro">
            <h2>{M.pathIntroTitle}</h2>
            <p>{M.pathIntroText}</p>
          </div>

          <div className="hm-path-cards">
            <PathCard
              badge={M.hoverBadge}
              icon={M.hoverIcon}
              title={M.hoverCardTitle}
              price={M.hoverCardPrice}
              description={M.hoverCardDescription}
              features={M.hoverCardFeatures}
              onSelect={() => selectPath('hover')}
            />
            <PathCard
              badge={M.adjusterBadge}
              icon={M.adjusterIcon}
              title={M.adjusterCardTitle}
              price={M.adjusterCardPrice}
              description={M.adjusterCardDescription}
              features={M.adjusterCardFeatures}
              onSelect={() => selectPath('adjuster')}
            />
          </div>
        </div>
      )}

      {/* ── Path A: Hover ── */}
      {view === 'hover' && hoverStage === 'success' && <HoverSuccess />}
      {view === 'hover' && hoverStage !== 'success' && (
        <div className="hm-section-card">
          <h3 className="hm-section-title">{M.hoverSectionTitle}</h3>
          <p className="hm-section-intro">{M.hoverSectionIntro}</p>

          <div className="hm-rebate">{M.rebateCallout}</div>

          <div className="hm-steps">
            <HoverStep n={1} title={M.hoverStep1Title} text={M.hoverStep1Text} />
            <HoverStep n={2} title={M.hoverStep2Title} text={M.hoverStep2Text} />
            <HoverStep n={3} title={M.hoverStep3Title} text={M.hoverStep3Text} />
          </div>

          <div className="hm-info">{M.hoverWhatYouNeed}</div>

          <div className="hm-btn-row">
            {hoverStage === 'intro' && (
              <button
                type="button"
                className="hm-btn hm-btn-green"
                disabled={hoverLoading}
                onClick={() => void purchaseHover()}
              >
                {hoverLoading ? (
                  <>
                    <span className="hm-spinner" aria-hidden="true" /> {M.loadingButton}
                  </>
                ) : (
                  M.hoverPurchaseButton
                )}
              </button>
            )}
            <button type="button" className="hm-btn hm-btn-outline" onClick={goBack}>
              {M.chooseDifferentButton}
            </button>
          </div>

          {hoverStage === 'card' && clientSecret && (
            <HoverPaymentForm
              clientSecret={clientSecret}
              onPaid={handlePaid}
              onCancel={cancelHoverPayment}
            />
          )}
        </div>
      )}

      {/* ── Path B: Ask Adjuster ── */}
      {view === 'adjuster' && adjStage === 'success' && <EmailSuccess />}
      {view === 'adjuster' && adjStage === 'form' && (
        <div>
          <div className="hm-section-card">
            <h3 className="hm-section-title">{M.adjusterSectionTitle}</h3>
            <p className="hm-section-intro">{M.adjusterIntro}</p>
          </div>

          {alreadySentBoth && <div className="hm-info">{M.alreadySentEstimateNote}</div>}

          <div className="hm-section-card">
            <h3 className="hm-section-title">{M.adjusterInfoTitle}</h3>
            <p className="hm-section-intro">{M.adjusterInfoText}</p>

            <div className="hm-form">
              <div className="hm-form-group">
                <label htmlFor="hm-adjuster-name">
                  {M.adjusterNameLabel} <span className="hm-required-star">{M.requiredStar}</span>
                </label>
                <input
                  id="hm-adjuster-name"
                  type="text"
                  placeholder={M.adjusterNamePlaceholder}
                  value={adjusterName}
                  onChange={(e) => setAdjusterName(e.target.value)}
                />
              </div>
              <div className="hm-form-group">
                <label htmlFor="hm-adjuster-email">
                  {M.adjusterEmailLabel} <span className="hm-required-star">{M.requiredStar}</span>
                </label>
                <input
                  id="hm-adjuster-email"
                  type="email"
                  placeholder={M.adjusterEmailPlaceholder}
                  value={adjusterEmail}
                  onChange={(e) => setAdjusterEmail(e.target.value)}
                />
              </div>
              <div className="hm-form-group">
                <label htmlFor="hm-adjuster-phone">{M.adjusterPhoneLabel}</label>
                <input
                  id="hm-adjuster-phone"
                  type="tel"
                  placeholder={M.adjusterPhonePlaceholder}
                  value={adjusterPhone}
                  onChange={(e) => setAdjusterPhone(e.target.value)}
                />
              </div>
            </div>

            <h4 className="hm-preview-heading">{M.emailPreviewHeading}</h4>
            <div className="hm-email-preview">{M.emailPreviewLoading}</div>

            <div className="hm-followup">{M.adjusterFollowupNote}</div>

            <div className="hm-btn-row">
              <button
                type="button"
                className="hm-btn hm-btn-amber"
                disabled={!canSend}
                onClick={() => void handleSend()}
              >
                {sending ? M.sendingButton : M.sendMeasurementEmailButton}
              </button>
              <button type="button" className="hm-btn hm-btn-outline" onClick={goBack}>
                {M.chooseDifferentButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Presentational pieces ────────────────────────────────────────────────────────

function PathCard({
  badge,
  icon,
  title,
  price,
  description,
  features,
  onSelect,
}: {
  badge: string;
  icon: string;
  title: string;
  price: string;
  description: string;
  features: readonly string[];
  onSelect: () => void;
}) {
  return (
    <div className="hm-path-card">
      <div className="hm-card-badge">{badge}</div>
      <div className="hm-card-icon">{icon}</div>
      <h3 className="hm-card-title">{title}</h3>
      <div className="hm-card-price">{price}</div>
      <p className="hm-card-desc">{description}</p>
      <ul className="hm-features">
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <button type="button" className="hm-select-btn" onClick={onSelect}>
        {M.cardSelectButton}
      </button>
    </div>
  );
}

function HoverStep({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="hm-step">
      <div className="hm-step-number">{n}</div>
      <div className="hm-step-content">
        <h4>{title}</h4>
        <p>{text}</p>
      </div>
    </div>
  );
}

function HoverSuccess() {
  return (
    <div className="hm-section-card">
      <div className="hm-success-state">
        <div className="hm-success-icon">{M.hoverSuccessIcon}</div>
        <h2>{M.hoverSuccessTitle}</h2>
        <p>{M.hoverSuccessText}</p>
        <div className="hm-info hm-info-left">{M.hoverSuccessNextSteps}</div>
        <div className="hm-btn-row hm-btn-row-center">
          <a className="hm-btn hm-btn-amber" href="/dashboard">
            {M.returnToDashboardButton}
          </a>
        </div>
      </div>
    </div>
  );
}

function EmailSuccess() {
  return (
    <div className="hm-section-card">
      <div className="hm-success-state">
        <div className="hm-success-icon">{M.emailSuccessIcon}</div>
        <h2>{M.emailSuccessTitle}</h2>
        <p>{M.emailSuccessText}</p>
        <div className="hm-followup">{M.emailSuccess48HourNote}</div>
        <div className="hm-btn-row hm-btn-row-center">
          <a className="hm-btn hm-btn-amber" href="/dashboard">
            {M.returnToDashboardButton}
          </a>
        </div>
      </div>
    </div>
  );
}

function Boot() {
  return (
    <div className="hm-boot" role="status" aria-label="Loading">
      <div className="hm-boot-spin" />
      <style>{STYLES}</style>
    </div>
  );
}

// ── Styles (dark homeowner theme, matching the H5/H7 sibling ports) ───────────────

const STYLES = `
  .hm-container { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem 3rem; color: var(--white,#fff); }
  .hm-boot { display:flex; align-items:center; justify-content:center; min-height:60vh; }
  .hm-boot-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:hm-spin .8s linear infinite; }
  @keyframes hm-spin { to { transform: rotate(360deg); } }

  .hm-status { padding: 1rem 1.25rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.95rem; }
  .hm-status.success { background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.35); color: #6ee7b7; }
  .hm-status.error { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.35); color: #fca5a5; }

  .hm-header { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:2.5rem; padding-bottom:1.5rem; border-bottom:1px solid rgba(255,255,255,0.08); }
  .hm-title { font-size: clamp(1.5rem,4vw,2rem); margin:0 0 .5rem; }
  .hm-subtitle { color: var(--slate,#94a3b8); margin:0; }
  .hm-back { display:inline-flex; align-items:center; gap:.5rem; color:#b8860b; text-decoration:none; font-weight:600; white-space:nowrap; }
  .hm-back:hover { color: var(--white,#fff); }

  .hm-path-intro { text-align:center; margin-bottom:2rem; }
  .hm-path-intro h2 { font-size:1.5rem; margin:0 0 .75rem; }
  .hm-path-intro p { color: var(--slate,#94a3b8); margin:0; }
  .hm-path-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:1.5rem; margin-bottom:2rem; }
  .hm-path-card { position:relative; background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:16px; padding:2rem; display:flex; flex-direction:column; transition:border-color .2s, box-shadow .2s; }
  .hm-path-card:hover { border-color:#b8860b; box-shadow:0 6px 20px rgba(184,134,11,0.12); }
  .hm-card-badge { position:absolute; top:-10px; right:16px; background:#2d5016; color:#fff; font-size:.7rem; font-weight:700; text-transform:uppercase; letter-spacing:.05em; padding:.35rem .75rem; border-radius:20px; }
  .hm-card-icon { width:56px; height:56px; border-radius:14px; background:rgba(184,134,11,0.12); display:flex; align-items:center; justify-content:center; font-size:1.75rem; margin-bottom:1.25rem; }
  .hm-card-title { font-size:1.2rem; font-weight:700; margin:0 0 .5rem; }
  .hm-card-price { font-size:1rem; font-weight:600; color:#d4a017; margin-bottom:.75rem; }
  .hm-card-desc { color: var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; margin:0 0 1rem; }
  .hm-features { list-style:none; padding:0; margin:0; flex:1; }
  .hm-features li { color: rgba(255,255,255,0.85); font-size:.9rem; padding:.3rem 0 .3rem 1.5rem; position:relative; }
  .hm-features li::before { content:"✓"; position:absolute; left:0; color:#10B981; font-weight:700; }
  .hm-select-btn { display:block; width:100%; margin-top:1.5rem; background:#b8860b; color:#0B1929; border:none; padding:.85rem; border-radius:8px; font-weight:700; font-size:1rem; cursor:pointer; font-family:inherit; transition:filter .2s; }
  .hm-select-btn:hover { filter:brightness(1.05); }

  .hm-section-card { background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:2rem; margin-bottom:2rem; }
  .hm-section-title { font-size:1.3rem; margin:0 0 1rem; }
  .hm-section-intro { color: var(--slate,#94a3b8); line-height:1.7; margin:0 0 1rem; }

  .hm-rebate { background: rgba(16,185,129,0.08); border-left:4px solid #10B981; border-radius:6px; padding:1.25rem 1.5rem; margin:1.5rem 0; font-size:.95rem; color: rgba(255,255,255,0.9); line-height:1.6; }
  .hm-info { background: rgba(59,130,246,0.08); border-left:4px solid #3B82F6; border-radius:6px; padding:1.25rem 1.5rem; margin:1.5rem 0; font-size:.95rem; color: rgba(255,255,255,0.88); line-height:1.6; }
  .hm-info-left { text-align:left; }

  .hm-steps { display:flex; flex-direction:column; gap:1.5rem; margin:2rem 0; }
  .hm-step { display:flex; gap:1.25rem; align-items:flex-start; }
  .hm-step-number { width:40px; height:40px; border-radius:50%; background:#b8860b; color:#0B1929; display:flex; align-items:center; justify-content:center; font-weight:700; flex-shrink:0; }
  .hm-step-content h4 { font-size:1rem; font-weight:600; margin:0 0 .3rem; }
  .hm-step-content p { color: var(--slate,#94a3b8); font-size:.9rem; margin:0; }

  .hm-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1rem; margin-bottom:1.5rem; }
  .hm-form-group label { display:block; font-size:.85rem; font-weight:600; color: rgba(255,255,255,0.85); margin-bottom:.4rem; text-transform:uppercase; letter-spacing:.03em; }
  .hm-form-group input { width:100%; box-sizing:border-box; padding:.6rem .8rem; border:1px solid rgba(255,255,255,0.12); border-radius:6px; background: rgba(255,255,255,0.05); color: var(--white,#fff); font-family:inherit; font-size:.95rem; }
  .hm-form-group input:focus { outline:none; border-color:#b8860b; box-shadow:0 0 0 3px rgba(184,134,11,0.12); }
  .hm-required-star { color:#e74c3c; }

  .hm-preview-heading { font-size:1rem; font-weight:600; margin:0 0 .75rem; }
  .hm-email-preview { background: rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:1.25rem; margin:1rem 0; font-size:.9rem; color: var(--slate,#94a3b8); line-height:1.7; white-space:pre-wrap; }

  .hm-followup { background: rgba(184,134,11,0.08); border:1px solid rgba(184,134,11,0.25); border-radius:8px; padding:1.25rem; margin-top:1.5rem; font-size:.9rem; color: rgba(255,255,255,0.85); line-height:1.6; }

  .hm-btn { display:inline-flex; align-items:center; justify-content:center; gap:.5rem; border:none; border-radius:8px; padding:.85rem 1.75rem; font-weight:700; font-size:1rem; cursor:pointer; font-family:inherit; text-decoration:none; transition:filter .2s, background .2s; }
  .hm-btn:disabled { opacity:.5; cursor:not-allowed; }
  .hm-btn-green { background:#10B981; color:#fff; }
  .hm-btn-green:hover:not(:disabled) { background:#059669; }
  .hm-btn-amber { background:#b8860b; color:#0B1929; }
  .hm-btn-amber:hover:not(:disabled) { filter:brightness(1.05); }
  .hm-btn-outline { background:transparent; border:2px solid #b8860b; color:#b8860b; }
  .hm-btn-outline:hover:not(:disabled) { background: rgba(184,134,11,0.08); }
  .hm-btn-row { display:flex; gap:1rem; margin-top:1.5rem; flex-wrap:wrap; }
  .hm-btn-row-center { justify-content:center; }

  .hm-payform { margin-top:1.5rem; padding:1.5rem; background: rgba(255,255,255,0.04); border:1.5px solid rgba(255,255,255,0.12); border-radius:8px; }
  .hm-payform-lead { font-size:.875rem; color: rgba(255,255,255,0.85); margin:0 0 1rem; font-weight:500; }
  .hm-card-element { padding:.75rem; border:1.5px solid rgba(255,255,255,0.18); border-radius:6px; background:#fff; }
  .hm-card-errors { color:#fca5a5; font-size:.8rem; margin-top:.4rem; min-height:1.1rem; }
  .hm-stripe-note { font-size:.75rem; color: var(--slate,#94a3b8); margin:.75rem 0 0; text-align:center; }

  .hm-success-state { text-align:center; padding:2rem 1rem; }
  .hm-success-icon { width:80px; height:80px; border-radius:50%; background:linear-gradient(135deg,#10B981,#059669); color:#fff; display:flex; align-items:center; justify-content:center; font-size:2.5rem; margin:0 auto 1.5rem; }
  .hm-success-state h2 { margin:0 0 .75rem; }
  .hm-success-state p { color: var(--slate,#94a3b8); max-width:550px; margin:0 auto 1.5rem; }

  .hm-spinner { display:inline-block; width:16px; height:16px; border:2px solid rgba(255,255,255,0.4); border-top-color:#fff; border-radius:50%; animation:hm-spin .6s linear infinite; }

  @media (max-width:768px) {
    .hm-header { flex-direction:column; align-items:flex-start; }
    .hm-path-cards { grid-template-columns:1fr; }
    .hm-form { grid-template-columns:1fr; }
    .hm-btn-row { flex-direction:column; }
    .hm-btn-row .hm-btn { width:100%; }
  }
`;
