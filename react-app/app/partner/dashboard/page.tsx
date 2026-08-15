'use client';

/**
 * Partner Dashboard — D-211 Phase 12 (port of partner-dashboard.html → React
 * /partner/dashboard). The authenticated dashboard for a referral PARTNER
 * (referral_agent): referrals + commission status, the D-180 payout-approval
 * badges, the v36 recruit/sub-partner earnings chain, and the D-172 W-9 status
 * card (uploads via the submit-partner-w9 Edge Function).
 *
 * GATING (referral_agents-TABLE-FIRST; matches the static init() order):
 *   - This is a partner page rendering the shared SITE header in the static stack
 *     (NOT a contractor/admin app nav) — so we do NOT build a PartnerShell. It is
 *     a bare page using the React app's standard page chrome, gated directly on
 *     AuthProvider `settled` (the #294/#296 hardened pattern via useAuthReady).
 *   - not settled            → render nothing but the loading state (never act on
 *     the provider's transient blank-screen fallback).
 *   - settled & no user      → router.replace('/login') (React route).
 *   - settled & user, but no referral_agents record → window.location to the
 *     STATIC /partner-re.html signup chooser (coexistence; do NOT build a React
 *     chooser). The role-resolution + email-link + no-record decision is factored
 *     into lib/partner-record.ts (reused by Phase 13).
 *   No loop-proof marker is needed: the bounce targets (/partner-re.html, /login)
 *   are not React routes that bounce back here.
 *
 * ⚠️ Tier-3 contracts UNCHANGED: the submit-partner-w9 EF is called with the exact
 * static request shape (multipart `w9_file`, Authorization: Bearer <access token>,
 * POST ${SUPABASE_URL}/functions/v1/submit-partner-w9). The referral_agents /
 * referrals / payout_approvals reads are byte-for-byte. The W-9 / IRS / payout
 * legal copy is ported VERBATIM (copy.ts) and pinned in the parity test. No EF,
 * SQL, payment, or legal-copy surface is modified.
 *
 * §XSS: every DB/user value renders as JSX text (no innerHTML /
 * dangerouslySetInnerHTML) — the static page's innerHTML sinks are closed by
 * construction (proven in dashboard-xss.test.tsx).
 *
 * Analytics: the React app's global gtag is used app-wide; this page fires no
 * analytics events (the static dashboard fired none), so the stale GA4 id
 * (G-D1Y1TLGEFY) is intentionally NOT carried over.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import {
  resolvePartnerRecord,
  fetchPartnerByUserId,
  type PartnerRecord,
} from '@/lib/partner-record';
import {
  type PartnerReferral,
  type RecruitRecord,
  type PayoutApproval,
  type PartnerResolutionKind,
  agentDisplayName,
  partnerBadgeLabel,
  referralLinkFor,
  recruitLinkState,
  w9CardState,
  w9CardDate,
  referralStatusLabel,
  referralStatusClass,
  referralClientName,
  referralDate,
  fmtMoneyCell,
  payoutBadge,
  referralIdsForPayout,
  payoutStatusByReferral,
  computeStats,
  fmtMoneyWhole,
  referralsSubtext,
  activeSubtext,
  completedSubtext,
  partnersRecruitedSubtext,
  recruitTypeLabel,
  recruitName,
  aggregateRecruitEarnings,
  recruitStats,
  fmtRecruitEarnings,
  formatRelativeDate,
  w9SubmitUrl,
} from './utils';
import {
  LOGIN_ROUTE,
  PARTNER_SIGNUP_REDIRECT,
  IRS_W9_URL,
  W9_EF_FORM_FIELD,
  W9_COPY,
  PAYOUT_COPY,
  RECRUIT_LINK_HINT,
  REFERRAL_FEE_DISCLAIMER,
  RECRUIT_LINK_PENDING,
  RECRUIT_EARNINGS_TOOLTIP,
  HERO_COPY,
  EMPTY_STATES,
  SECTION_HEADERS,
} from './copy';

export default function PartnerDashboardPage() {
  const { user, settled } = useAuthReady();
  const router = useRouter();
  const initRan = useRef(false);

  const [resolution, setResolution] = useState<PartnerResolutionKind>('pending');
  const [partner, setPartner] = useState<PartnerRecord | null>(null);
  const [referrals, setReferrals] = useState<PartnerReferral[]>([]);
  const [payoutByReferral, setPayoutByReferral] = useState<Record<string, string>>({});
  const [recruits, setRecruits] = useState<RecruitRecord[]>([]);

  // ── Data loaders (supabase singleton — ADR-009 pattern) ─────────────────────
  const loadReferrals = useCallback(async (p: PartnerRecord) => {
    const { data: refs } = await supabase
      .from('referrals')
      .select('*')
      .eq('referral_agent_id', p.id)
      .order('created_at', { ascending: false });

    const list = (refs || []) as PartnerReferral[];
    setReferrals(list);

    // D-180: payout-approval status only for commission rows (commission_amount > 0).
    const ids = referralIdsForPayout(list);
    if (ids.length > 0) {
      const { data: approvals } = await supabase
        .from('payout_approvals')
        .select('referral_id, status, payout_type')
        .in('referral_id', ids)
        .eq('payout_type', 'commission_referral')
        .order('created_at', { ascending: false });
      setPayoutByReferral(payoutStatusByReferral((approvals || []) as PayoutApproval[]));
    } else {
      setPayoutByReferral({});
    }
  }, []);

  const loadRecruits = useCallback(async (p: PartnerRecord) => {
    const { data: recs } = await supabase
      .from('referral_agents')
      .select('*')
      .eq('recruited_by_id', p.id)
      .order('created_at', { ascending: false });

    const list = (recs || []) as RecruitRecord[];
    if (list.length > 0) {
      const ids = list.map((r) => r.id);
      const { data: paidRefs } = await supabase
        .from('referrals')
        .select('referral_agent_id, recruit_commission_amount')
        .in('referral_agent_id', ids)
        .not('recruit_commission_amount', 'is', null);
      const earnings = aggregateRecruitEarnings((paidRefs || []) as PartnerReferral[]);
      list.forEach((r) => {
        r._yourEarnings = earnings[r.id] || 0;
      });
    }
    setRecruits(list);
  }, []);

  // ── Init: settled-gate → resolve partner → load data ────────────────────────
  useEffect(() => {
    if (!settled) return;
    if (!user) {
      router.replace(LOGIN_ROUTE);
      return;
    }
    if (initRan.current) return;
    initRan.current = true;

    void (async () => {
      try {
        const res = await resolvePartnerRecord(user.id, user.email ?? '');
        if (res.kind === 'no-record') {
          setResolution('no-record');
          // Full-page navigation to the STATIC signup chooser (outside the React app).
          if (typeof window !== 'undefined') window.location.href = PARTNER_SIGNUP_REDIRECT;
          return;
        }
        setPartner(res.partner);
        setResolution('ok');
        await Promise.all([loadReferrals(res.partner), loadRecruits(res.partner)]);
      } catch (err) {
        console.error('Error loading partner data:', err);
      }
    })();
  }, [settled, user, router, loadReferrals, loadRecruits]);

  // ── Gate render ─────────────────────────────────────────────────────────────
  if (!settled || resolution !== 'ok' || !partner) {
    return (
      <div className="opd-root">
        <style>{STYLES}</style>
        <main className="opd-loading" role="status" aria-live="polite">
          <div className="opd-spin" />
          <p>Loading your dashboard…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="opd-root">
      <style>{STYLES}</style>
      <DashboardView
        partner={partner}
        referrals={referrals}
        payoutByReferral={payoutByReferral}
        recruits={recruits}
        onPartnerRefresh={(p) => setPartner(p)}
        userId={user?.id ?? ''}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard (rendered only once a partner record is resolved)
// ─────────────────────────────────────────────────────────────────────────────

function DashboardView({
  partner,
  referrals,
  payoutByReferral,
  recruits,
  onPartnerRefresh,
  userId,
}: {
  partner: PartnerRecord;
  referrals: PartnerReferral[];
  payoutByReferral: Record<string, string>;
  recruits: RecruitRecord[];
  onPartnerRefresh: (p: PartnerRecord) => void;
  userId: string;
}) {
  const name = agentDisplayName(partner);
  const badge = partnerBadgeLabel(partner.agent_type);
  const referralLink = referralLinkFor(partner);
  const recruitLink = recruitLinkState(partner, RECRUIT_LINK_PENDING);

  const stats = computeStats(partner, referrals);
  const rStats = recruitStats(partner, recruits);

  return (
    <main className="opd-main">
      {/* Hero */}
      <div className="dashboard-hero">
        <div className="hero-top">
          <div className="hero-left">
            <h1>Welcome back, {name}</h1>
            <span className="partner-badge">{badge}</span>
          </div>
        </div>

        <div className="referral-link-section">
          <div className="referral-link-label">{HERO_COPY.referralLinkLabel}</div>
          <div className="referral-link-display">
            <div className="referral-link-url">{referralLink}</div>
            <CopyButton text={referralLink} />
          </div>
          {/* D-266 — mandatory verbatim funnel-legality disclaimer */}
          <p className="link-hint referral-fee-disclaimer">{REFERRAL_FEE_DISCLAIMER}</p>
        </div>

        <div className="referral-link-section recruit-link-section">
          <div className="referral-link-label">{HERO_COPY.recruitLinkLabel}</div>
          <div className="referral-link-display">
            <div className="referral-link-url">{recruitLink.text}</div>
            <CopyButton text={recruitLink.enabled ? recruitLink.text : ''} disabled={!recruitLink.enabled} />
          </div>
          <p className="link-hint">{RECRUIT_LINK_HINT}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <StatCard label="Total Referrals" value={String(stats.total)} subtext={referralsSubtext(stats.total)} />
        <StatCard label="Active / In Progress" value={String(stats.active)} subtext={activeSubtext(stats.active)} />
        <StatCard label="Completed Jobs" value={String(stats.completed)} subtext={completedSubtext(stats.completed)} />
        <StatCard label="Total Earned" value={fmtMoneyWhole(stats.earned)} subtext="from completed jobs" />
        <StatCard label="Partners Recruited" value={String(rStats.count)} subtext={partnersRecruitedSubtext(rStats.count)} />
        <StatCard label="Recruit Earnings" value={fmtMoneyWhole(rStats.earnings)} subtext="from recruit bonuses" />
      </div>

      {/* W-9 status card (D-172) */}
      <W9Card partner={partner} userId={userId} onPartnerRefresh={onPartnerRefresh} />

      {/* Quick Actions */}
      <h2 className="section-header">{SECTION_HEADERS.quickActions}</h2>
      <QuickActions referralLink={referralLink} />

      {/* Portfolio Report */}
      <h2 className="section-header">{SECTION_HEADERS.portfolio}</h2>
      <div className="table-filters">
        <div className="filter-group">
          <label className="form-label">Date Range</label>
          <select className="form-select" defaultValue="this-month">
            <option value="this-month">This Month</option>
            <option value="last-month">Last Month</option>
            <option value="last-3-months">Last 3 Months</option>
            <option value="all-time">All Time</option>
          </select>
        </div>
      </div>

      {referrals.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">{EMPTY_STATES.referrals.icon}</span>
          <h3 className="empty-state-title">{EMPTY_STATES.referrals.title}</h3>
          <p className="empty-state-text">{EMPTY_STATES.referrals.text}</p>
        </div>
      ) : (
        <table className="referrals-table">
          <thead>
            <tr>
              <th>Client Name</th>
              <th>Date Referred</th>
              <th>Status</th>
              <th>Job Value</th>
              <th>Commission</th>
            </tr>
          </thead>
          <tbody>
            {referrals.map((ref) => (
              <ReferralRow key={ref.id} referral={ref} payoutStatus={payoutByReferral[ref.id] ?? null} />
            ))}
          </tbody>
        </table>
      )}

      {/* Recruit Network */}
      <h2 className="section-header">{SECTION_HEADERS.recruitNetwork}</h2>
      {recruits.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state-icon">{EMPTY_STATES.recruits.icon}</span>
          <h3 className="empty-state-title">{EMPTY_STATES.recruits.title}</h3>
          <p className="empty-state-text">{EMPTY_STATES.recruits.text}</p>
        </div>
      ) : (
        <table className="referrals-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Signed Up</th>
              <th>Their Referrals</th>
              <th>
                Your Earnings <span className="th-info" title={RECRUIT_EARNINGS_TOOLTIP} aria-hidden="true">ⓘ</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {recruits.map((r) => (
              <RecruitRow key={r.id} recruit={r} />
            ))}
          </tbody>
        </table>
      )}

      {/* Profile Settings */}
      <h2 className="section-header">{SECTION_HEADERS.profile}</h2>
      <ProfileSettings
        partner={partner}
        referralLink={referralLink}
        userId={userId}
        onPartnerRefresh={onPartnerRefresh}
      />
    </main>
  );
}

// ── Hero copy button ──────────────────────────────────────────────────────────
function CopyButton({ text, disabled = false }: { text: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    if (disabled || !text) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  }
  return (
    <button
      type="button"
      className={'copy-btn' + (copied ? ' copied' : '')}
      onClick={onCopy}
      disabled={disabled}
      style={disabled ? { opacity: 0.5 } : undefined}
    >
      {copied ? HERO_COPY.copied : HERO_COPY.copyLink}
    </button>
  );
}

function StatCard({ label, value, subtext }: { label: string; value: string; subtext: string }) {
  return (
    <div className="stat-card">
      <span className="stat-card-label">{label}</span>
      <span className="stat-card-value">{value}</span>
      <span className="stat-card-subtext">{subtext}</span>
    </div>
  );
}

// ── Referral row ──────────────────────────────────────────────────────────────
function ReferralRow({ referral, payoutStatus }: { referral: PartnerReferral; payoutStatus: string | null }) {
  const badge = payoutBadge(payoutStatus, PAYOUT_COPY);
  return (
    <tr>
      <td>{referralClientName(referral)}</td>
      <td>{referralDate(referral.created_at)}</td>
      <td>
        <span className={`status-badge ${referralStatusClass(referral.status)}`}>
          {referralStatusLabel(referral.status)}
        </span>
      </td>
      <td>{fmtMoneyCell(referral.job_value)}</td>
      <td>
        {fmtMoneyCell(referral.commission_amount)}
        {badge && (
          <span className={`payout-badge ${badge.className}`} title={badge.title}>
            {badge.label}
          </span>
        )}
      </td>
    </tr>
  );
}

// ── Recruit row ───────────────────────────────────────────────────────────────
function RecruitRow({ recruit }: { recruit: RecruitRecord }) {
  return (
    <tr>
      <td>{recruitName(recruit)}</td>
      <td>{recruitTypeLabel(recruit.agent_type)}</td>
      <td>{formatRelativeDate(recruit.created_at, Date.now())}</td>
      <td>{Number(recruit.total_referrals) || 0}</td>
      <td>{fmtRecruitEarnings(Number(recruit._yourEarnings) || 0)}</td>
    </tr>
  );
}

// ── W-9 status card (D-172) ───────────────────────────────────────────────────
function W9Card({
  partner,
  userId,
  onPartnerRefresh,
}: {
  partner: PartnerRecord;
  userId: string;
  onPartnerRefresh: (p: PartnerRecord) => void;
}) {
  const state = w9CardState(partner);
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ kind: 'info' | 'error'; msg: string } | null>(null);

  const onUpload = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      setStatus({ kind: 'info', msg: W9_COPY.uploadingText });
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        if (!token) throw new Error('Not authenticated — please refresh and try again');

        const formData = new FormData();
        formData.append(W9_EF_FORM_FIELD, file);

        const res = await fetch(w9SubmitUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(json.error || `Upload failed (HTTP ${res.status})`);

        // Refresh the partner row and re-render the card.
        const updated = userId ? await fetchPartnerByUserId(userId) : null;
        if (updated) onPartnerRefresh(updated);
        setStatus(null);
      } catch (err) {
        console.error('W-9 upload error:', err);
        setStatus({ kind: 'error', msg: `Upload failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    [userId, onPartnerRefresh],
  );

  if (state === 'hidden') return null;

  const hiddenInput = (
    <input
      ref={fileRef}
      type="file"
      accept="application/pdf"
      style={{ display: 'none' }}
      onChange={(e) => onUpload(e.target.files?.[0])}
    />
  );
  const statusEl = status && (
    <div style={{ fontSize: '0.85rem', marginTop: 8, color: status.kind === 'error' ? '#dc2626' : undefined }}>
      {status.msg}
    </div>
  );

  if (state === 'verified') {
    return (
      <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: '20px 24px', marginBottom: 'var(--sp-6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: '1.5rem' }}>✅</span>
          <div>
            <div style={{ fontWeight: 700, color: '#15803d', fontSize: '1rem' }}>{W9_COPY.verified.title}</div>
            <div style={{ color: '#166534', fontSize: '0.875rem', marginTop: 2 }}>
              {W9_COPY.verified.bodyPrefix}
              {w9CardDate(partner.w9_verified_at)}
              {W9_COPY.verified.bodySuffix}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'submitted') {
    return (
      <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 12, padding: '20px 24px', marginBottom: 'var(--sp-6)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{ fontSize: '1.5rem' }}>📋</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: '#1d4ed8', fontSize: '1rem' }}>{W9_COPY.submitted.title}</div>
            <div style={{ color: '#1e40af', fontSize: '0.875rem', marginTop: 4 }}>
              {W9_COPY.submitted.bodyPrefix}
              {w9CardDate(partner.w9_submitted_at)}
              {W9_COPY.submitted.bodySuffix}
            </div>
            <div style={{ marginTop: 12 }}>
              {hiddenInput}
              <span
                onClick={() => fileRef.current?.click()}
                style={{ fontSize: '0.8rem', color: '#2563eb', textDecoration: 'underline', cursor: 'pointer' }}
              >
                {W9_COPY.submitted.replaceLink}
              </span>
              {statusEl}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // action-required
  return (
    <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12, padding: '20px 24px', marginBottom: 'var(--sp-6)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ fontSize: '1.5rem' }}>⚠️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: '#92400e', fontSize: '1rem' }}>{W9_COPY.actionRequired.title}</div>
          <div style={{ color: '#78350f', fontSize: '0.875rem', marginTop: 4, lineHeight: 1.5 }}>
            {W9_COPY.actionRequired.body}
          </div>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn"
              onClick={() => fileRef.current?.click()}
              style={{ background: '#d97706', borderColor: '#d97706', fontSize: '0.9rem', padding: '10px 20px' }}
            >
              {W9_COPY.actionRequired.uploadBtn}
            </button>
            <a href={IRS_W9_URL} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', color: '#92400e' }}>
              {W9_COPY.actionRequired.irsLinkText}
            </a>
          </div>
          {hiddenInput}
          {statusEl}
        </div>
      </div>
    </div>
  );
}

// ── Quick Actions (marketing tools — ported visual + lightweight client state) ─
function QuickActions({ referralLink }: { referralLink: string }) {
  const [clientName, setClientName] = useState('');
  const [contactMethod, setContactMethod] = useState<'sms' | 'email'>('sms');
  const [widgetStyle, setWidgetStyle] = useState<'button' | 'card'>('button');

  const message =
    `Hi ${clientName || '[Client Name]'},\n\n` +
    `I wanted to refer you to Otter Quotes — a quick and easy way to get a free quote from qualified contractors.\n\n` +
    `Check it out: ${referralLink}\n\n` +
    `Let me know if you have any questions!`;

  const widgetCode =
    widgetStyle === 'button'
      ? `<a href="${referralLink}" style="display: inline-block; padding: 12px 24px; background-color: #E07B00; color: #00D1B2E; text-decoration: none; border-radius: 6px; font-weight: 600; font-family: Rubik, sans-serif; font-size: 0.9rem;">Get a Free Contractor Quote</a>`
      : `<div style="padding: 20px; background: #0D1B2E; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; max-width: 320px;"><div style="font-size: 1rem; font-weight: 700; color: #FFFFFF; margin-bottom: 8px;">Get a Free Quote</div><div style="font-size: 0.875rem; color: #94A3B8; margin-bottom: 16px;">Connect with qualified contractors and get quotes instantly</div><a href="${referralLink}" style="display: inline-block; padding: 10px 20px; background-color: #E07B00; color: #0D1B2E; text-decoration: none; border-radius: 6px; font-weight: 600;">Get Started</a></div>`;

  return (
    <div className="quick-actions-grid">
      {/* Send to Client */}
      <div className="action-card">
        <h3 className="action-card-title">📬 Send to Client</h3>
        <div className="form-group">
          <label className="form-label">Client Name</label>
          <input
            type="text"
            className="form-input"
            placeholder="e.g., John Smith"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Contact Method</label>
          <div className="toggle-group">
            <button
              type="button"
              className={'toggle-btn' + (contactMethod === 'sms' ? ' active' : '')}
              onClick={() => setContactMethod('sms')}
            >
              SMS
            </button>
            <button
              type="button"
              className={'toggle-btn' + (contactMethod === 'email' ? ' active' : '')}
              onClick={() => setContactMethod('email')}
            >
              Email
            </button>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">{contactMethod === 'sms' ? 'Phone Number' : 'Email Address'}</label>
          <input
            type="text"
            className="form-input"
            placeholder={contactMethod === 'sms' ? '+1 (555) 123-4567' : 'client@email.com'}
          />
        </div>
        <div className="message-preview" style={{ whiteSpace: 'pre-wrap' }}>{message}</div>
        <div className="btn-group">
          <button type="button" className="btn">Send</button>
          <CopyTextButton text={message} label="Copy Message" className="btn secondary" />
        </div>
      </div>

      {/* Get Your Widget */}
      <div className="action-card">
        <h3 className="action-card-title">🔧 Get Your Widget</h3>
        <div className="form-group">
          <label className="form-label">Widget Style</label>
          <div className="toggle-group">
            <button
              type="button"
              className={'toggle-btn' + (widgetStyle === 'button' ? ' active' : '')}
              onClick={() => setWidgetStyle('button')}
            >
              Button
            </button>
            <button
              type="button"
              className={'toggle-btn' + (widgetStyle === 'card' ? ' active' : '')}
              onClick={() => setWidgetStyle('card')}
            >
              Card
            </button>
          </div>
        </div>
        <div className="widget-preview">
          {widgetStyle === 'button' ? (
            <button className="widget-button" disabled>Get a Free Contractor Quote</button>
          ) : (
            <div className="widget-card">
              <div className="widget-card-title">Get a Free Quote</div>
              <div className="widget-card-text">Connect with qualified contractors and get quotes instantly</div>
              <button className="widget-card-button" disabled>Get Started</button>
            </div>
          )}
        </div>
        <div className="btn-group">
          <CopyTextButton text={widgetCode} label="Copy Code" className="btn" />
        </div>
      </div>

      {/* Download One-Pager */}
      <div className="action-card">
        <h3 className="action-card-title">📄 Download One-Pager</h3>
        <div className="onepager-preview">
          <div className="onepager-icon">📋</div>
          <div className="onepager-text">Partner Marketing Material<br /><br />Share with your network</div>
        </div>
        <div className="btn-group">
          <a href="#" className="btn">Download PDF</a>
        </div>
      </div>
    </div>
  );
}

function CopyTextButton({ text, label, className }: { text: string; label: string; className: string }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* non-fatal */
    }
  }
  return (
    <button type="button" className={className} onClick={onCopy}>
      {copied ? HERO_COPY.copied : label}
    </button>
  );
}

// ── Profile Settings ──────────────────────────────────────────────────────────
// gh-861 AC7: the static page's #profileForm had no submit handler at all
// (default GET navigation → silent data loss, fixed separately in
// partner-dashboard.html). This React port never had that specific bug — no
// <form action> exists in JSX, so there's no default navigation — but its
// onSubmit was JUST `e.preventDefault()`: the button reads "Save Changes" and
// nothing is ever read from the fields or written anywhere. That is the same
// destructive-save-loss outcome (edits silently discarded, no error shown), so
// it gets the same fix here in the same PR.
function ProfileSettings({
  partner,
  referralLink,
  userId,
  onPartnerRefresh,
}: {
  partner: PartnerRecord;
  referralLink: string;
  userId: string;
  onPartnerRefresh: (p: PartnerRecord) => void;
}) {
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const name = agentDisplayName(partner);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setStatus(null);

    const form = new FormData(e.currentTarget);
    const fullName = String(form.get('name') ?? '').trim();
    const nameParts = fullName.split(/\s+/).filter(Boolean);

    const updates = {
      first_name: nameParts[0] ?? '',
      last_name: nameParts.slice(1).join(' '),
      email: String(form.get('email') ?? '').trim(),
      phone: String(form.get('phone') ?? '').trim(),
      company: String(form.get('company') ?? '').trim(),
      service_area: String(form.get('service_area') ?? '').trim(),
      website: String(form.get('website') ?? '').trim(),
      bio: String(form.get('bio') ?? '').trim(),
    };

    try {
      if (!userId) throw new Error('Not signed in — please refresh and try again.');

      const { data: updated, error } = await supabase
        .from('referral_agents')
        .update(updates)
        .eq('user_id', userId)
        .select()
        .single();

      if (error) throw error;

      if (updated) onPartnerRefresh(updated as PartnerRecord);
      setStatus({ kind: 'success', msg: 'Saved.' });
    } catch (err) {
      console.error('Profile save error:', err);
      setStatus({
        kind: 'error',
        msg: `Could not save your changes: ${err instanceof Error ? err.message : String(err)}. Please try again.`,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="profile-section">
      <div className="profile-section-header" onClick={() => setOpen((v) => !v)}>
        <h3>Edit Your Profile</h3>
        <span className={'toggle-icon' + (open ? ' open' : '')}>▼</span>
      </div>

      <form className={'profile-form' + (open ? '' : ' collapsed')} onSubmit={onSubmit}>
        <div className="form-group">
          <label className="form-label">Name</label>
          <input type="text" name="name" className="form-input" defaultValue={name} placeholder="Your Name" />
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input type="email" name="email" className="form-input" defaultValue={partner.email ?? ''} placeholder="your@email.com" />
        </div>
        <div className="form-group">
          <label className="form-label">Phone</label>
          <input type="tel" name="phone" className="form-input" defaultValue={partner.phone ?? ''} placeholder="+1 (555) 123-4567" />
        </div>
        <div className="form-group">
          <label className="form-label">Company</label>
          <input type="text" name="company" className="form-input" defaultValue={partner.company ?? ''} placeholder="Company Name" />
        </div>
        <div className="form-group">
          <label className="form-label">Service Area</label>
          <input type="text" name="service_area" className="form-input" defaultValue={partner.service_area ?? ''} placeholder="City, State" />
        </div>
        <div className="form-group">
          <label className="form-label">Website</label>
          <input type="url" name="website" className="form-input" defaultValue={partner.website ?? ''} placeholder="https://yourwebsite.com" />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <div className="form-group">
            <label className="form-label">Bio</label>
            <textarea
              name="bio"
              className="form-input"
              defaultValue={partner.bio ?? ''}
              placeholder="Tell us about yourself..."
              style={{ minHeight: 100, resize: 'vertical' }}
            />
          </div>
        </div>
        {status && (
          <div
            style={{
              gridColumn: '1 / -1',
              fontSize: '0.85rem',
              color: status.kind === 'error' ? '#dc2626' : '#15803d',
            }}
          >
            {status.msg}
          </div>
        )}
        <div style={{ gridColumn: '1 / -1' }}>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </form>

      <div className="profile-link">
        <div className="profile-link-label">Your Personalized Landing Page</div>
        <div className="profile-link-url">{referralLink}</div>
        <a href="#" className="btn secondary" style={{ width: '100%', textAlign: 'center', display: 'block', marginTop: 'var(--sp-2)' }}>
          Preview
        </a>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles (ported from partner-dashboard.html page <style> + the design-system
// CSS vars the static page inherited from css/design-system.css). Scoped under
// .opd-root; one route mounts at a time (sibling-page precedent).
// ─────────────────────────────────────────────────────────────────────────────

const STYLES = `
  .opd-root {
    --navy: #0D1B2E; --navy-2: #0F2440; --amber: #E07B00; --white: #FFFFFF;
    --slate: #94A3B8; --green: #10B981;
    --sp-2: 0.5rem; --sp-3: 0.75rem; --sp-4: 1rem; --sp-6: 1.5rem; --sp-8: 2rem; --sp-12: 3rem;
    --radius-md: 0.5rem; --radius-lg: 0.75rem;
    --font-heading: 'Rubik', sans-serif; --font-body: 'Rubik', sans-serif;
    --font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-family: var(--font-body); color: var(--white); background: var(--navy); min-height: 100vh;
  }
  .opd-loading { text-align: center; padding: 5rem 1.5rem; color: var(--slate); }
  .opd-spin { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid var(--amber); border-radius: 50%; animation: opd-spin .8s linear infinite; margin: 0 auto 1.5rem; }
  @keyframes opd-spin { to { transform: rotate(360deg); } }

  .opd-main { padding: var(--sp-8) var(--sp-4); max-width: 1400px; margin: 0 auto; }

  .dashboard-hero { margin-bottom: var(--sp-12); background: linear-gradient(135deg, rgba(224,123,0,0.05), rgba(224,123,0,0)); padding: var(--sp-8); border-radius: var(--radius-lg); border: 1px solid rgba(224,123,0,0.1); }
  .hero-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--sp-6); flex-wrap: wrap; gap: var(--sp-4); }
  .hero-left h1 { font-family: var(--font-heading); font-size: 2.5rem; font-weight: 700; color: var(--white); margin-bottom: var(--sp-2); line-height: 1.1; }
  .partner-badge { display: inline-block; background: var(--amber); color: var(--navy); padding: var(--sp-2) var(--sp-4); border-radius: var(--radius-md); font-family: var(--font-body); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

  .referral-link-section { background: rgba(224,123,0,0.1); border: 1px solid var(--amber); border-radius: var(--radius-md); padding: var(--sp-4); margin-top: var(--sp-4); }
  .referral-link-label { font-family: var(--font-body); font-size: 0.85rem; font-weight: 500; color: var(--slate); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--sp-2); }
  .referral-link-display { display: flex; gap: var(--sp-2); align-items: center; }
  .referral-link-url { flex: 1; background: var(--navy-2); color: var(--white); padding: var(--sp-3) var(--sp-4); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: 0.9rem; word-break: break-all; border: 1px solid rgba(224,123,0,0.2); }
  .link-hint { font-family: var(--font-body); font-size: 0.8rem; color: var(--slate); margin-top: var(--sp-2); line-height: 1.4; }
  .recruit-link-section { margin-top: var(--sp-3); }
  .th-info { color: var(--slate); font-size: 0.9em; margin-left: 4px; cursor: help; text-transform: none; }

  .copy-btn { background: var(--amber); color: var(--navy); border: none; padding: var(--sp-3) var(--sp-4); border-radius: var(--radius-md); font-family: var(--font-body); font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; white-space: nowrap; }
  .copy-btn:hover { background: #A85C00; color: var(--white); }
  .copy-btn.copied { background: var(--green); color: var(--white); }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: var(--sp-6); margin-bottom: var(--sp-12); }
  .stat-card { background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.2); border-radius: var(--radius-lg); padding: var(--sp-6); transition: all 0.2s ease; cursor: pointer; }
  .stat-card:hover { border-color: var(--amber); background: rgba(224,123,0,0.1); box-shadow: 0 4px 12px rgba(224,123,0,0.1); }
  .stat-card-label { font-family: var(--font-body); font-size: 0.875rem; font-weight: 500; color: var(--slate); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--sp-3); display: block; }
  .stat-card-value { font-family: var(--font-heading); font-size: 2.25rem; font-weight: 700; color: var(--white); margin-bottom: var(--sp-3); display: block; }
  .stat-card-subtext { font-family: var(--font-body); font-size: 0.85rem; color: var(--slate); }

  .section-header { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; color: var(--white); margin-bottom: var(--sp-6); margin-top: var(--sp-12); }

  .quick-actions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--sp-6); margin-bottom: var(--sp-12); }
  .action-card { background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.2); border-radius: var(--radius-lg); padding: var(--sp-6); transition: all 0.2s ease; }
  .action-card:hover { border-color: var(--amber); background: rgba(224,123,0,0.08); }
  .action-card-title { font-family: var(--font-heading); font-size: 1.25rem; font-weight: 700; color: var(--white); margin-bottom: var(--sp-4); }

  .form-group { margin-bottom: var(--sp-4); }
  .form-label { display: block; font-family: var(--font-body); font-size: 0.875rem; font-weight: 600; color: var(--slate); margin-bottom: var(--sp-2); text-transform: uppercase; letter-spacing: 0.05em; }
  .form-input, .form-select { width: 100%; padding: var(--sp-3) var(--sp-4); background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); font-family: var(--font-body); font-size: 1rem; color: var(--white); transition: all 0.2s ease; box-sizing: border-box; }
  .form-input::placeholder { color: var(--slate); }
  .form-input:focus, .form-select:focus { outline: none; border-color: var(--amber); background: rgba(255,255,255,0.08); }
  .form-select { cursor: pointer; }
  .form-select option { background: var(--navy); color: var(--white); }

  .toggle-group { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-4); }
  .toggle-btn { flex: 1; padding: var(--sp-3) var(--sp-4); background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.2); color: var(--slate); border-radius: var(--radius-md); font-family: var(--font-body); font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; }
  .toggle-btn.active { background: var(--amber); color: var(--navy); border-color: var(--amber); }

  .message-preview { background: rgba(255,255,255,0.03); border: 1px solid rgba(224,123,0,0.15); border-radius: var(--radius-md); padding: var(--sp-4); margin-bottom: var(--sp-4); font-family: var(--font-body); font-size: 0.95rem; color: var(--white); line-height: 1.6; max-height: 120px; overflow-y: auto; }
  .widget-preview { background: rgba(255,255,255,0.03); border: 1px solid rgba(224,123,0,0.15); border-radius: var(--radius-md); padding: var(--sp-6); margin-bottom: var(--sp-4); text-align: center; min-height: 120px; display: flex; align-items: center; justify-content: center; }
  .widget-button { background: var(--amber); color: var(--navy); padding: var(--sp-3) var(--sp-6); border-radius: var(--radius-md); font-family: var(--font-body); font-weight: 600; border: none; cursor: pointer; transition: all 0.2s ease; font-size: 0.95rem; }
  .widget-button:hover { background: #A85C00; color: var(--white); }
  .widget-card { background: var(--white); color: var(--navy); padding: var(--sp-6); border-radius: var(--radius-lg); text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
  .widget-card-title { font-family: var(--font-heading); font-size: 1.125rem; font-weight: 700; margin-bottom: var(--sp-2); }
  .widget-card-text { font-size: 0.9rem; color: var(--slate); margin-bottom: var(--sp-4); }
  .widget-card-button { background: var(--amber); color: var(--navy); padding: var(--sp-2) var(--sp-4); border-radius: var(--radius-md); border: none; cursor: pointer; font-weight: 600; transition: all 0.2s ease; }
  .widget-card-button:hover { background: #A85C00; color: var(--white); }

  .onepager-preview { background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.15); border-radius: var(--radius-md); padding: var(--sp-4); margin-bottom: var(--sp-4); text-align: center; min-height: 200px; display: flex; align-items: center; justify-content: center; flex-direction: column; }
  .onepager-icon { font-size: 2rem; margin-bottom: var(--sp-2); }
  .onepager-text { font-family: var(--font-body); color: var(--slate); font-size: 0.9rem; }

  .btn { display: inline-block; padding: var(--sp-3) var(--sp-6); background: var(--amber); color: var(--navy); border: none; border-radius: var(--radius-md); font-family: var(--font-body); font-weight: 600; cursor: pointer; transition: all 0.2s ease; text-decoration: none; text-align: center; font-size: 0.95rem; }
  .btn:hover { background: #A85C00; color: var(--white); }
  .btn.secondary { background: rgba(255,255,255,0.1); color: var(--white); border: 1px solid rgba(224,123,0,0.3); }
  .btn.secondary:hover { background: rgba(255,255,255,0.15); border-color: var(--amber); }
  .btn-group { display: flex; gap: var(--sp-3); margin-top: var(--sp-4); flex-wrap: wrap; }

  .referrals-table { width: 100%; border-collapse: collapse; background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.2); border-radius: var(--radius-lg); overflow: hidden; margin-bottom: var(--sp-12); }
  .referrals-table thead { background: rgba(224,123,0,0.15); border-bottom: 1px solid rgba(224,123,0,0.3); }
  .referrals-table th { padding: var(--sp-4); font-family: var(--font-body); font-size: 0.875rem; font-weight: 600; color: var(--white); text-align: left; text-transform: uppercase; letter-spacing: 0.05em; }
  .referrals-table td { padding: var(--sp-4); font-family: var(--font-body); font-size: 0.95rem; color: var(--white); border-bottom: 1px solid rgba(224,123,0,0.1); }
  .referrals-table tbody tr:hover { background: rgba(224,123,0,0.08); }

  .status-badge { display: inline-block; padding: var(--sp-2) var(--sp-4); border-radius: var(--radius-md); font-family: var(--font-body); font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .status-clicked { background: rgba(148,163,184,0.3); color: var(--slate); }
  .status-registered { background: rgba(59,130,246,0.3); color: #60A5FA; }
  .status-submitted { background: rgba(224,123,0,0.3); color: var(--amber); }
  .status-in-progress { background: rgba(245,158,11,0.3); color: #FBBF24; }
  .status-completed { background: rgba(16,185,129,0.3); color: var(--green); }
  .status-paid { background: rgba(16,185,129,0.5); color: var(--green); font-weight: 700; }

  .payout-badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 0.3rem; font-size: 0.7rem; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .payout-badge-pending { background: #FEF3C7; color: #92400E; }
  .payout-badge-rejected { background: #FEE2E2; color: #991B1B; }

  .table-filters { margin-bottom: var(--sp-6); display: flex; gap: var(--sp-3); align-items: flex-end; flex-wrap: wrap; }
  .filter-group { flex: 1; min-width: 200px; }

  .empty-state { text-align: center; padding: var(--sp-12); color: var(--slate); margin-bottom: var(--sp-12); }
  .empty-state-icon { font-size: 3rem; margin-bottom: var(--sp-4); display: block; opacity: 0.5; }
  .empty-state-title { font-family: var(--font-heading); font-size: 1.5rem; font-weight: 700; color: var(--white); margin-bottom: var(--sp-2); }
  .empty-state-text { font-family: var(--font-body); font-size: 1rem; color: var(--slate); margin-bottom: var(--sp-6); }

  .profile-section { background: rgba(255,255,255,0.05); border: 1px solid rgba(224,123,0,0.2); border-radius: var(--radius-lg); padding: var(--sp-6); margin-bottom: var(--sp-12); }
  .profile-section-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: var(--sp-4); border-bottom: 1px solid rgba(224,123,0,0.1); margin-bottom: var(--sp-4); cursor: pointer; }
  .profile-section-header h3 { font-family: var(--font-heading); font-size: 1.25rem; font-weight: 700; color: var(--white); margin: 0; }
  .toggle-icon { color: var(--amber); font-size: 1.5rem; transition: transform 0.2s ease; }
  .toggle-icon.open { transform: rotate(180deg); }
  .profile-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--sp-4); }
  .profile-form.collapsed { display: none; }
  .profile-link { background: rgba(224,123,0,0.1); border: 1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); padding: var(--sp-4); margin-top: var(--sp-4); }
  .profile-link-label { font-family: var(--font-body); font-size: 0.85rem; font-weight: 600; color: var(--slate); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: var(--sp-2); }
  .profile-link-url { font-family: var(--font-mono); font-size: 0.9rem; color: var(--amber); word-break: break-all; margin-bottom: var(--sp-2); }

  @media (max-width: 768px) {
    .opd-main { padding: var(--sp-4) var(--sp-3); }
    .dashboard-hero { padding: var(--sp-4); }
    .hero-top { flex-direction: column; }
    .hero-left h1 { font-size: 1.75rem; }
    .stats-grid { grid-template-columns: 1fr 1fr; gap: var(--sp-4); }
    .quick-actions-grid { grid-template-columns: 1fr; }
    .referral-link-display { flex-direction: column; }
    .copy-btn { width: 100%; }
    .profile-form { grid-template-columns: 1fr; }
    .table-filters { flex-direction: column; }
    .filter-group { width: 100%; }
    .referrals-table { font-size: 0.85rem; }
    .referrals-table th, .referrals-table td { padding: var(--sp-3); }
  }
`;
