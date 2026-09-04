'use client';

/**
 * Refer-a-Friend — D-211 Phase 13 (port of refer-a-friend.html -> React /refer).
 *
 * The authenticated HOMEOWNER / CUSTOMER referral page: a customer's unique
 * referral link + QR, share tools (Facebook + before/after share card, SMS,
 * Nextdoor, email, email-signature badge), their referrals table, the D-172 W-9
 * banner, and the verbatim 1099 tax notice + D-180 commission disclosure +
 * D-266 referral-fee legality disclaimer.
 *
 * GATING (matches the static init() order):
 *   1. Homeowner coming-soon gate (mirrors the static <head> guard): if the
 *      launch flag is OFF -> full-page redirect to the STATIC /coming-soon.html.
 *      The flag is currently ON (js/config.js HOMEOWNER_LAUNCH_ENABLED = true);
 *      NEXT_PUBLIC_HOMEOWNER_LAUNCH_ENABLED='false' re-gates it.
 *   2. settled-gate (the #294/#296 hardened pattern via useAuthReady): never act
 *      on the transient blank screen.
 *   3. settled & no user -> router.replace('/login') (Auth.requireAuth parity).
 *   4. settled & user -> fetch-or-CREATE the customer referral_agents row
 *      (agent_type='customer'); then load this user's referrals.
 *   NOTE: this is the customer model (referral_agents.agent_type='customer',
 *   create-on-missing), NOT the partner-record resolver (which is partner-table-
 *   first and bounces to /partner-re.html). Force-fitting that resolver here
 *   would change behavior — so it is intentionally NOT used.
 *
 * #576: previously stale-schema broken — selected/inserted a phantom
 * referral_agents.code column, queried a phantom referrals.referrer_id, and
 * client-generated codes. Re-ported to match the current static page: code
 * fetch/create goes through the get_or_create_customer_referral_code() RPC
 * (v100/#624; unique_code is trigger-generated, never client-supplied), and
 * referrals resolve via the two-step referral_agents.id -> referrals.
 * referral_agent_id path (#567). See utils.ts for the full 7-status model and
 * the D-139 paid/pending commission split this now carries.
 *
 * §XSS: every DB/user value renders as JSX text (no innerHTML /
 * dangerouslySetInnerHTML). The email-signature badge HTML is shown as TEXT in a
 * code box for the user to copy — never injected.
 *
 * ⚠️ Tier-3 copy (1099 tax notice, FAQ tax answer, D-180 disclosure, D-266
 * referral-fee legality disclaimer, W-9 banner) is ported VERBATIM (copy.ts)
 * and pinned in refer.test.ts.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import {
  type CustomerReferral,
  type CustomerReferralAgent,
  REFERRAL_AGENT_TYPE,
  COMING_SOON_REDIRECT,
  referralUrl,
  referralRowCells,
  summarizeReferrals,
  referralSummaryLine,
  shouldShowW9Banner,
  isHomeownerLaunchEnabled,
  FACEBOOK_SHARE_MESSAGE,
  smsShareMessage,
  nextdoorShareMessage,
  EMAIL_SHARE_SUBJECT,
  emailShareBody,
  emailSignatureBadgeHtml,
  facebookShareUrl,
} from './utils';
import {
  LOGIN_ROUTE,
  W9_UPLOAD_LINK,
  REFERRAL_CODE_ERROR_TEXT,
  HERO,
  REFERRAL_LINK_LABEL,
  QR_HEADING,
  COPY_LINK_LABEL,
  COPIED_LABEL,
  SHARE_LABEL,
  SHARE_HEADING,
  SHARE_CARDS,
  HOW_IT_WORKS_HEADING,
  HOW_IT_WORKS,
  FAQ_HEADING,
  FAQ,
  TAX_NOTICE,
  COMMISSION_APPROVAL_DISCLOSURE,
  REFERRAL_FEE_DISCLAIMER,
  W9_BANNER,
  REFERRALS,
} from './copy';

// Minimal typing for the qrcodejs CDN global (same lib + version as the static page).
interface QRCodeOptions {
  text: string;
  width: number;
  height: number;
  colorDark: string;
  colorLight: string;
  correctLevel: number;
}
interface QRCodeCtor {
  new (el: HTMLElement, opts: QRCodeOptions): unknown;
  CorrectLevel: { H: number };
}
declare global {
  // eslint-disable-next-line no-var
  interface Window {
    QRCode?: QRCodeCtor;
  }
}
const QR_SCRIPT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';

function isMobileUA(): boolean {
  return typeof navigator !== 'undefined' && /iPhone|iPad|Android|mobile/i.test(navigator.userAgent);
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ReferAFriendPage() {
  const { user, settled } = useAuthReady();
  const router = useRouter();
  const initRan = useRef(false);

  const [gated, setGated] = useState(false);
  const [ready, setReady] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [agent, setAgent] = useState<CustomerReferralAgent | null>(null);
  const [referrals, setReferrals] = useState<CustomerReferral[]>([]);

  // 1. Homeowner coming-soon gate — runs once on mount (mirrors the static <head> guard).
  useEffect(() => {
    if (!isHomeownerLaunchEnabled(process.env.NEXT_PUBLIC_HOMEOWNER_LAUNCH_ENABLED)) {
      setGated(true);
      if (typeof window !== 'undefined') window.location.replace(COMING_SOON_REDIRECT);
    }
  }, []);

  // 2-4. Auth settled-gate -> fetch/create code -> load referrals.
  useEffect(() => {
    if (gated || !settled) return;
    if (!user) {
      router.replace(LOGIN_ROUTE);
      return;
    }
    if (initRan.current) return;
    initRan.current = true;

    void (async () => {
      try {
        // v100/#624: get_or_create_customer_referral_code() SECURITY DEFINER
        // RPC, keyed on auth.uid() only. Replaces the direct client
        // .insert().select().single() that the D-211 2026-06-13 RLS lockdown
        // made non-functional (same write-then-read gap #571's register_partner
        // fixed for the partner-signup pages). Idempotent get-or-create;
        // unique_code is trigger-generated and never supplied here.
        const { data, error } = await supabase.rpc('get_or_create_customer_referral_code');

        if (data && (data as CustomerReferralAgent).unique_code) {
          const a = data as CustomerReferralAgent;
          setCode(a.unique_code ?? null);
          setAgent(a);
        } else {
          // Genuine failure (RPC error, expired session, no verified email,
          // etc.) — do NOT fabricate a fake code; render an honest error
          // instead of a broken /ref/<falsy> link.
          console.error('Error fetching/creating referral code:', error);
          setCode(null);
          setAgent(null);
        }

        // Two-step (#567): referrals has no referrer_id column — resolve our
        // own agent row first, then match referrals.referral_agent_id.
        const { data: agentRow, error: agentError } = await supabase
          .from('referral_agents')
          .select('id')
          .eq('user_id', user.id)
          .eq('agent_type', REFERRAL_AGENT_TYPE)
          .maybeSingle();

        if (agentError) {
          console.error('Failed to resolve referral agent:', agentError);
        } else if (agentRow) {
          const { data: refs, error: refsError } = await supabase
            .from('referrals')
            .select('*')
            .eq('referral_agent_id', (agentRow as { id: string }).id)
            .order('created_at', { ascending: false });
          if (refsError) console.error('Failed to load referrals:', refsError);
          setReferrals((refs || []) as CustomerReferral[]);
        }
      } catch (err) {
        console.error('Error loading refer-a-friend data:', err);
      } finally {
        setReady(true);
      }
    })();
  }, [gated, settled, user, router]);

  if (gated) return null;

  if (!settled || !user || !ready) {
    return (
      <div className="orf-root">
        <style>{STYLES}</style>
        <main className="orf-loading" role="status" aria-live="polite">
          <div className="orf-spin" />
          <p>Loading…</p>
        </main>
      </div>
    );
  }

  if (!code) {
    return (
      <div className="orf-root">
        <style>{STYLES}</style>
        <main className="orf-loading" role="alert">
          <p>{REFERRAL_CODE_ERROR_TEXT}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="orf-root">
      <style>{STYLES}</style>
      <ReferView code={code} agent={agent} referrals={referrals} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function ReferView({
  code,
  agent,
  referrals,
}: {
  code: string;
  agent: CustomerReferralAgent | null;
  referrals: CustomerReferral[];
}) {
  const link = referralUrl(code);
  const showW9 = shouldShowW9Banner(agent);

  return (
    <main className="orf-main">
      {showW9 && (
        <div className="w9-banner">
          <span className="w9-icon">⚠️</span>
          <div>
            <strong className="w9-title">{W9_BANNER.title}</strong>
            <p className="w9-body">
              {W9_BANNER.body}{' '}
              <a href={W9_UPLOAD_LINK} className="w9-link">
                {W9_BANNER.link}
              </a>
            </p>
          </div>
        </div>
      )}

      {/* Hero */}
      <section className="hero-section">
        <h1>{HERO.heading}</h1>
        <p className="subtitle">{HERO.subtitle}</p>
      </section>

      {/* Referral link */}
      <section className="refer-section">
        <ReferralLinkCard link={link} />
      </section>

      {/* Share options */}
      <section className="refer-section">
        <h2 className="section-h2">{SHARE_HEADING}</h2>
        <div className="share-grid">
          <FacebookCard link={link} />
          <SmsCard link={link} />
          <NextdoorCard link={link} />
          <EmailCard link={link} />
          <BadgeCard link={link} />
        </div>
      </section>

      {/* Referrals dashboard */}
      <section className="refer-section">
        <ReferralsDashboard referrals={referrals} />
      </section>

      {/* How it works */}
      <section className="refer-section">
        <h2 className="section-h2">{HOW_IT_WORKS_HEADING}</h2>
        <div className="how-it-works">
          {HOW_IT_WORKS.map((s) => (
            <div className="how-step" key={s.number}>
              <div className="how-step-number">{s.number}</div>
              <h4>{s.title}</h4>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="refer-section">
        <h2 className="section-h2">{FAQ_HEADING}</h2>
        <div className="faq-list">
          {FAQ.map((f) => (
            <FaqItem key={f.q} q={f.q} a={f.a} />
          ))}
        </div>
      </section>

      {/* 1099 tax reporting notice (verbatim — disclosure 1099-misc-v1-2026-04) */}
      <section className="refer-section">
        <div className="tax-notice">
          <p className="tax-notice-label">{TAX_NOTICE.label}</p>
          <p className="tax-notice-body">{TAX_NOTICE.body}</p>
        </div>
      </section>

      {/* D-180 commission approval disclosure (verbatim) */}
      <section className="refer-section">
        <p className="commission-disclosure">{COMMISSION_APPROVAL_DISCLOSURE}</p>
      </section>

      {/* D-266 referral-fee legality disclaimer (verbatim, mandatory) */}
      <section className="refer-section">
        <p className="referral-fee-disclaimer">{REFERRAL_FEE_DISCLAIMER}</p>
      </section>
    </main>
  );
}

// ── Referral link card (+ QR) ─────────────────────────────────────────────────
function ReferralLinkCard({ link }: { link: string }) {
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const renderQr = () => {
      const el = qrRef.current;
      const QR = typeof window !== 'undefined' ? window.QRCode : undefined;
      if (!el || !QR) return;
      el.innerHTML = '';
      try {
        // eslint-disable-next-line no-new
        new QR(el, {
          text: link,
          width: 200,
          height: 200,
          colorDark: '#0D1B2E',
          colorLight: '#FFFFFF',
          correctLevel: QR.CorrectLevel.H,
        });
      } catch {
        /* QR is a non-essential enhancement — the link is shown above */
      }
    };

    if (typeof window !== 'undefined' && window.QRCode) {
      renderQr();
      return;
    }
    if (typeof document === 'undefined') return;
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${QR_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => {
        if (!cancelled) renderQr();
      });
      return () => {
        cancelled = true;
      };
    }
    const s = document.createElement('script');
    s.src = QR_SCRIPT_SRC;
    s.async = true;
    s.onload = () => {
      if (!cancelled) renderQr();
    };
    document.body.appendChild(s);
    return () => {
      cancelled = true;
    };
  }, [link]);

  function share() {
    if (typeof navigator !== 'undefined' && navigator.share) {
      void navigator
        .share({ title: 'Otter Quotes Referral', text: 'Check out Otter Quotes for getting competing contractor bids!', url: link })
        .catch(() => {
          /* user dismissed — non-fatal */
        });
    } else {
      void copyText(link);
    }
  }

  return (
    <div className="referral-link-card">
      <div className="referral-link-label">{REFERRAL_LINK_LABEL}</div>
      <div className="referral-link-display">{link}</div>
      <div className="referral-link-actions">
        <CopyButton text={link} label={COPY_LINK_LABEL} icon="📋" primary />
        <button className="btn btn-secondary" onClick={share}>
          <span>↗</span> {SHARE_LABEL}
        </button>
      </div>
      <div className="referral-link-qr">
        <h4>{QR_HEADING}</h4>
        <div id="qr-code" ref={qrRef} />
      </div>
    </div>
  );
}

// ── Facebook card (with before/after share-card generator) ────────────────────
function FacebookCard({ link }: { link: string }) {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const beforeInput = useRef<HTMLInputElement>(null);
  const afterInput = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  function onFile(kind: 'before' | 'after', file: File | null | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = typeof e.target?.result === 'string' ? e.target.result : null;
      if (!result) return;
      if (kind === 'before') setBefore(result);
      else setAfter(result);
    };
    reader.readAsDataURL(file);
  }

  // Generate the share card once both photos are present (ports generateShareCard()).
  useEffect(() => {
    if (!before || !after) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = 800;
    const height = 420;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#0D1B2E';
    ctx.fillRect(0, 0, width, 60);
    ctx.fillStyle = '#E07B00';
    ctx.font = 'bold 24px "Rubik"';
    ctx.fillText('Otter Quotes', 20, 40);

    const beforeImg = new Image();
    const afterImg = new Image();
    let loaded = 0;
    const draw = () => {
      const pW = (width - 60) / 2;
      const pH = height - 130;
      const pY = 70;
      ctx.drawImage(beforeImg, 20, pY, pW, pH);
      ctx.drawImage(afterImg, pW + 40, pY, pW, pH);
      ctx.fillStyle = '#0D1B2E';
      ctx.font = 'bold 14px "Rubik"';
      ctx.fillText('Before', 30, pY + pH + 20);
      ctx.fillText('After', pW + 50, pY + pH + 20);
      ctx.fillStyle = '#0D1B2E';
      ctx.fillRect(0, height - 50, width, 50);
      ctx.fillStyle = '#E07B00';
      ctx.font = '12px "Rubik"';
      ctx.fillText('Powered by Otter Quotes', 20, height - 15);
      ctx.font = 'bold 12px "Rubik"';
      ctx.fillText(link, width - 300, height - 15);
    };
    beforeImg.onload = () => {
      if (++loaded === 2) draw();
    };
    afterImg.onload = () => {
      if (++loaded === 2) draw();
    };
    beforeImg.src = before;
    afterImg.src = after;
  }, [before, after, link]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'otterquote-referral-card.png';
    a.click();
  }

  return (
    <div className="share-card">
      <div className="share-card-header">
        <div className="share-card-icon">👍</div>
        <h3 className="share-card-title">{SHARE_CARDS.facebook.title}</h3>
      </div>
      <p className="share-card-description">{SHARE_CARDS.facebook.description}</p>
      <div className="share-actions">
        <button className="btn btn-primary btn-block" onClick={() => window.open(facebookShareUrl(link), 'facebook-share', 'width=600,height=400')}>
          {SHARE_CARDS.facebook.button}
        </button>
      </div>
      <div className="photo-upload-section">
        <h5>{SHARE_CARDS.facebook.photoHeading}</h5>
        <p className="photo-upload-hint">{SHARE_CARDS.facebook.photoText}</p>
        <div className="photo-upload-grid">
          <UploadZone label="Before Photo" preview={before} inputRef={beforeInput} onPick={(f) => onFile('before', f)} />
          <UploadZone label="After Photo" preview={after} inputRef={afterInput} onPick={(f) => onFile('after', f)} />
        </div>
        {before && after && (
          <div className="card-preview">
            <p className="card-preview-label">{SHARE_CARDS.facebook.previewLabel}</p>
            <canvas id="preview-canvas" ref={canvasRef} width={800} height={420} />
            <button className="btn btn-primary" onClick={download}>
              <span>⬇</span> {SHARE_CARDS.facebook.downloadButton}
            </button>
            <p className="card-preview-hint">{SHARE_CARDS.facebook.downloadHint}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function UploadZone({
  label,
  preview,
  inputRef,
  onPick,
}: {
  label: string;
  preview: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onPick: (f: File | undefined) => void;
}) {
  return (
    <div className="upload-zone" onClick={() => inputRef.current?.click()}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => onPick(e.target.files?.[0])}
      />
      {preview ? (
        <div className="photo-preview-container">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} className="photo-preview" alt={label} />
          <p>{label}</p>
          <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
            Change
          </button>
        </div>
      ) : (
        <div>
          <div className="upload-zone-icon">📷</div>
          <div className="upload-zone-text">Click to upload</div>
          <div className="upload-zone-text small">or drag and drop</div>
          <div className="upload-zone-text accent">{label}</div>
        </div>
      )}
    </div>
  );
}

// ── SMS card ──────────────────────────────────────────────────────────────────
function SmsCard({ link }: { link: string }) {
  const [revealed, setRevealed] = useState(false);
  const message = smsShareMessage(link);
  function send() {
    if (isMobileUA()) {
      window.location.href = `sms:?body=${encodeURIComponent(message)}`;
    } else {
      setRevealed(true);
    }
  }
  return (
    <div className="share-card">
      <div className="share-card-header">
        <div className="share-card-icon">💬</div>
        <h3 className="share-card-title">{SHARE_CARDS.sms.title}</h3>
      </div>
      <p className="share-card-description">{SHARE_CARDS.sms.description}</p>
      {revealed && <div className="message-box">{message}</div>}
      <div className="share-actions">
        {!revealed && (
          <button className="btn btn-primary btn-block" onClick={send}>
            {SHARE_CARDS.sms.button}
          </button>
        )}
        {revealed && <CopyButton text={message} label={SHARE_CARDS.sms.copyButton} secondary block />}
      </div>
    </div>
  );
}

// ── Nextdoor card ─────────────────────────────────────────────────────────────
function NextdoorCard({ link }: { link: string }) {
  const message = nextdoorShareMessage(link);
  return (
    <div className="share-card">
      <div className="share-card-header">
        <div className="share-card-icon">🏘</div>
        <h3 className="share-card-title">{SHARE_CARDS.nextdoor.title}</h3>
      </div>
      <p className="share-card-description">{SHARE_CARDS.nextdoor.description}</p>
      <div className="message-box">{message}</div>
      <div className="share-actions">
        <CopyButton text={message} label={SHARE_CARDS.nextdoor.button} primary block />
        <a href={SHARE_CARDS.nextdoor.openHref} target="_blank" rel="noreferrer" className="btn btn-secondary btn-block">
          {SHARE_CARDS.nextdoor.openLink}
        </a>
      </div>
    </div>
  );
}

// ── Email card ────────────────────────────────────────────────────────────────
function EmailCard({ link }: { link: string }) {
  const body = emailShareBody(link);
  function send() {
    window.location.href = `mailto:?subject=${encodeURIComponent(EMAIL_SHARE_SUBJECT)}&body=${encodeURIComponent(body)}`;
  }
  return (
    <div className="share-card">
      <div className="share-card-header">
        <div className="share-card-icon">✉️</div>
        <h3 className="share-card-title">{SHARE_CARDS.email.title}</h3>
      </div>
      <p className="share-card-description">{SHARE_CARDS.email.description}</p>
      <div className="message-box">{body}</div>
      <div className="share-actions">
        <button className="btn btn-primary btn-block" onClick={send}>
          {SHARE_CARDS.email.button}
        </button>
        <CopyButton text={body} label={SHARE_CARDS.email.copyButton} secondary block />
      </div>
    </div>
  );
}

// ── Email-signature badge card ────────────────────────────────────────────────
function BadgeCard({ link }: { link: string }) {
  const html = emailSignatureBadgeHtml(link);
  return (
    <div className="share-card">
      <div className="share-card-header">
        <div className="share-card-icon">🦦</div>
        <h3 className="share-card-title">{SHARE_CARDS.badge.title}</h3>
      </div>
      <p className="share-card-description">{SHARE_CARDS.badge.description}</p>
      <div className="badge-preview">
        <div className="badge-chip">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/img/otter-logo.svg" alt="Otter Quotes" className="badge-logo" />
          <strong className="badge-trust">{SHARE_CARDS.badge.badgeTrust}</strong>
          <p className="badge-sub">{SHARE_CARDS.badge.badgeSub}</p>
        </div>
      </div>
      <div className="badge-html">{html}</div>
      <div className="share-actions badge-actions">
        <CopyButton text={html} label={SHARE_CARDS.badge.copyButton} primary block />
      </div>
      <div className="badge-instructions">
        <strong>{SHARE_CARDS.badge.instructionsTitle}</strong>
        <ul>
          <li>{SHARE_CARDS.badge.gmail}</li>
          <li>{SHARE_CARDS.badge.outlook}</li>
        </ul>
      </div>
    </div>
  );
}

// ── Referrals dashboard (BUG-1 fixed table; BUG-2 fixed summary) ──────────────
function ReferralsDashboard({ referrals }: { referrals: CustomerReferral[] }) {
  if (referrals.length === 0) {
    return (
      <div className="referrals-section">
        <div className="referrals-header">
          <h3>{REFERRALS.heading}</h3>
        </div>
        <div className="empty-referrals">
          <p>{REFERRALS.empty}</p>
        </div>
      </div>
    );
  }

  const summary = summarizeReferrals(referrals);

  return (
    <div className="referrals-section">
      <div className="referrals-header">
        <h3>{REFERRALS.heading}</h3>
        <p className="referral-summary">{referralSummaryLine(summary)}</p>
        <div className="referrals-summary">
          <div className="summary-item">
            <span className="summary-label">{REFERRALS.totalEarnedLabel}</span>
            <span className="summary-value">${summary.earned.toLocaleString('en-US')}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">{REFERRALS.pendingLabel}</span>
            <span className="summary-value">${summary.pending.toLocaleString('en-US')}</span>
          </div>
        </div>
      </div>
      <table className="referrals-table">
        <thead>
          <tr>
            <th>{REFERRALS.thFriend}</th>
            <th>{REFERRALS.thDate}</th>
            <th>{REFERRALS.thStatus}</th>
            <th>{REFERRALS.thCommission}</th>
          </tr>
        </thead>
        <tbody>
          {referrals.map((r, i) => {
            const cells = referralRowCells(r, i);
            return (
              <tr key={r.id ?? i}>
                <td>{cells.friend}</td>
                <td>{cells.date}</td>
                <td>
                  <span className={`status-badge ${cells.statusClass}`}>{cells.statusLabel}</span>
                </td>
                <td>{cells.commission}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── FAQ item ──────────────────────────────────────────────────────────────────
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`faq-item${open ? ' open' : ''}`}>
      <button className="faq-question" onClick={() => setOpen((v) => !v)}>
        <span>{q}</span>
        <span className="faq-icon">▼</span>
      </button>
      <div className="faq-answer">
        <p>{a}</p>
      </div>
    </div>
  );
}

// ── Copy helpers ──────────────────────────────────────────────────────────────
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* non-fatal */
  }
  return false;
}

function CopyButton({
  text,
  label,
  icon,
  primary = false,
  secondary = false,
  block = false,
}: {
  text: string;
  label: string;
  icon?: string;
  primary?: boolean;
  secondary?: boolean;
  block?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const cls = ['btn', primary ? 'btn-primary' : '', secondary ? 'btn-secondary' : '', block ? 'btn-block' : '', copied ? 'copied' : '']
    .filter(Boolean)
    .join(' ');
  async function onCopy() {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }
  return (
    <button className={cls} onClick={onCopy}>
      {copied ? <><span>✓</span> {COPIED_LABEL}</> : <>{icon ? <span>{icon}</span> : null} {label}</>}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles — ported from refer-a-friend.html <style> + the design-system vars the
// static page inherited from css/design-system.css. Scoped under .orf-root.
// ─────────────────────────────────────────────────────────────────────────────
const STYLES = `
  .orf-root {
    --navy: #0D1B2E; --navy-2: #0F2440; --navy-3: #102A4C; --mid: #1B3A5C;
    --amber: #E07B00; --amber-2: #F08C10; --amber-glow: rgba(224,123,0,0.15);
    --amber-light: #FEF3C7; --blue-light: #DBEAFE; --green: #10B981; --green-light: #D1FAE5;
    --white: #FFFFFF; --slate: #94A3B8;
    --sp-2:0.5rem; --sp-3:0.75rem; --sp-4:1rem; --sp-6:1.5rem; --sp-8:2rem; --sp-10:2.5rem; --sp-12:3rem; --sp-16:4rem; --sp-20:5rem;
    --radius-sm:0.375rem; --radius-md:0.5rem; --radius-lg:0.75rem; --radius-full:9999px;
    --font-body:'Rubik',sans-serif; --font-mono:'SFMono-Regular',Consolas,Menlo,monospace;
    --ease: ease; --duration: 0.2s; --shadow-md: 0 4px 12px rgba(0,0,0,0.2); --shadow-lg: 0 10px 30px rgba(0,0,0,0.3);
    font-family: var(--font-body); color: var(--white); background: var(--navy); min-height: 100vh;
  }
  .orf-loading { text-align:center; padding:5rem 1.5rem; color: var(--slate); }
  .orf-spin { width:40px;height:40px;border:3px solid rgba(255,255,255,0.1);border-top:3px solid var(--amber);border-radius:50%;animation: orf-spin .8s linear infinite;margin:0 auto 1.5rem; }
  @keyframes orf-spin { to { transform: rotate(360deg); } }

  .orf-main { max-width: 1200px; margin: 0 auto; padding: var(--sp-12) var(--sp-4); }
  .refer-section { margin-bottom: var(--sp-20); }
  .section-h2 { margin-bottom: var(--sp-8); font-size: 1.75rem; font-weight: 700; color: var(--white); }

  .w9-banner { background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:16px 20px;margin-bottom:1.5rem;display:flex;align-items:flex-start;gap:12px; }
  .w9-icon { font-size:1.25rem;flex-shrink:0; }
  .w9-title { color:#92400e;font-size:0.95rem; }
  .w9-body { margin:4px 0 0;color:#78350f;font-size:0.875rem;line-height:1.5; }
  .w9-link { color:#d97706;font-weight:600; }

  .hero-section { background: linear-gradient(135deg, var(--navy-2) 0%, var(--navy-3) 100%); padding: var(--sp-16) var(--sp-8); text-align:center; margin-bottom: var(--sp-20); border-bottom:1px solid rgba(224,123,0,0.1); border-radius: var(--radius-lg); }
  .hero-section h1 { font-size: clamp(2rem,5vw,3.5rem); margin-bottom: var(--sp-4); color: var(--white); }
  .hero-section .subtitle { font-size: clamp(1rem,2vw,1.25rem); color: var(--slate); max-width:700px; margin:0 auto; line-height:1.8; }

  .referral-link-card { background: var(--navy-2); border:2px solid var(--amber-glow); border-radius: var(--radius-lg); padding: var(--sp-10); text-align:center; }
  .referral-link-label { font-size:0.85rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--amber);margin-bottom:var(--sp-3); }
  .referral-link-display { background: var(--navy); border:1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); padding: var(--sp-4) var(--sp-6); font-family: var(--font-mono); font-size:1.1rem; color: var(--amber); word-break: break-all; margin-bottom: var(--sp-6); }
  .referral-link-actions { display:flex; gap: var(--sp-4); justify-content:center; flex-wrap:wrap; }
  .referral-link-qr { margin-top: var(--sp-8); padding-top: var(--sp-8); border-top:1px solid rgba(255,255,255,0.06); }
  .referral-link-qr h4 { font-size:0.9rem; margin-bottom: var(--sp-4); color: var(--slate); }
  #qr-code { display:inline-block; padding: var(--sp-4); background:white; border-radius: var(--radius-md); }
  #qr-code img, #qr-code canvas { display:block; }

  .share-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(320px,1fr)); gap: var(--sp-8); }
  .share-card { background: var(--navy-2); border:1px solid rgba(255,255,255,0.06); border-radius: var(--radius-lg); padding: var(--sp-8); }
  .share-card-header { display:flex; align-items:center; gap: var(--sp-4); margin-bottom: var(--sp-6); }
  .share-card-icon { width:48px;height:48px;border-radius:var(--radius-md);background:var(--amber-glow);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0; }
  .share-card-title { font-size:1.1rem;font-weight:700;color:var(--white);margin:0; }
  .share-card-description { font-size:0.9rem;color:var(--slate);margin-bottom:var(--sp-6);line-height:1.6; }
  .share-actions { display:flex; gap: var(--sp-3); flex-wrap:wrap; }

  .photo-upload-section { background: var(--navy); border:1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); padding: var(--sp-6); margin-top: var(--sp-6); }
  .photo-upload-section h5 { font-size:0.9rem;font-weight:600;color:var(--amber);margin-bottom:var(--sp-4);text-transform:uppercase; }
  .photo-upload-hint { font-size:0.85rem;color:var(--slate);margin-bottom:var(--sp-4); }
  .photo-upload-grid { display:grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); margin-bottom: var(--sp-6); }
  .upload-zone { border:2px dashed rgba(224,123,0,0.3); border-radius: var(--radius-md); padding: var(--sp-6); text-align:center; cursor:pointer; background: rgba(224,123,0,0.05); }
  .upload-zone:hover { border-color: var(--amber); background: var(--amber-glow); }
  .upload-zone-icon { font-size:2rem; margin-bottom: var(--sp-3); }
  .upload-zone-text { font-size:0.85rem; color: var(--slate); margin-bottom: var(--sp-2); }
  .upload-zone-text.small { font-size:0.75rem; }
  .upload-zone-text.accent { color: var(--amber); font-weight:600; }
  .photo-preview { width:100%; height:200px; border-radius: var(--radius-md); object-fit:cover; margin-bottom: var(--sp-3); }
  .photo-preview-container p { font-size:0.8rem; color: var(--slate); margin-top: var(--sp-2); }
  .card-preview { background: var(--navy-2); border:1px solid rgba(255,255,255,0.06); border-radius: var(--radius-md); padding: var(--sp-6); margin-top: var(--sp-4); text-align:center; }
  .card-preview-label { margin-bottom: var(--sp-4); color: var(--slate); font-size:0.9rem; }
  #preview-canvas { width:100%; max-width:400px; height:auto; border-radius: var(--radius-md); margin:0 auto var(--sp-4); display:block; }
  .card-preview-hint { margin-top: var(--sp-3); color: var(--slate); font-size:0.85rem; }

  .message-box { background: var(--navy); border:1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); padding: var(--sp-4); margin: var(--sp-4) 0; font-family: var(--font-mono); font-size:0.85rem; color: var(--slate); word-break: break-word; line-height:1.6; white-space: pre-wrap; }

  .badge-preview { background: var(--navy); border:1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); padding: var(--sp-6); margin: var(--sp-4) 0; text-align:center; }
  .badge-chip { display:inline-block; padding: var(--sp-4); background:white; border-radius: var(--radius-sm); }
  .badge-logo { width:20px;height:20px;margin-right:var(--sp-2);display:inline;vertical-align:middle; }
  .badge-trust { color: var(--navy); }
  .badge-sub { font-size:0.75rem; color: var(--slate); margin:4px 0 0; }
  .badge-html { font-family: var(--font-mono); font-size:0.75rem; background: var(--navy-2); border:1px solid rgba(255,255,255,0.06); border-radius: var(--radius-sm); padding: var(--sp-3); margin-top: var(--sp-3); color: var(--slate); word-break: break-all; max-height:200px; overflow-y:auto; white-space: pre-wrap; }
  .badge-actions { margin-top: var(--sp-6); }
  .badge-instructions { margin-top: var(--sp-6); padding: var(--sp-4); background: var(--navy); border-radius: var(--radius-sm); font-size:0.85rem; color: var(--slate); line-height:1.6; }
  .badge-instructions strong { color: var(--white); }
  .badge-instructions ul { margin: var(--sp-3) 0 0; padding-left: var(--sp-6); }

  .referrals-section { background: var(--navy-2); border:1px solid rgba(255,255,255,0.06); border-radius: var(--radius-lg); padding: var(--sp-8); }
  .referrals-header { display:flex; justify-content:space-between; align-items:center; margin-bottom: var(--sp-8); flex-wrap:wrap; gap: var(--sp-4); }
  .referrals-header h3 { margin:0; }
  .referral-summary { font-size:0.85rem; color: var(--slate); margin: var(--sp-2) 0 0; }
  .referrals-summary { display:flex; gap: var(--sp-8); }
  .summary-item { display:flex; flex-direction:column; gap: var(--sp-2); }
  .summary-label { font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--slate); }
  .summary-value { font-size:1.5rem;font-weight:700;color:var(--amber); }
  .referrals-table { width:100%; border-collapse:collapse; font-size:0.95rem; }
  .referrals-table thead { border-bottom:1px solid rgba(255,255,255,0.06); }
  .referrals-table th { text-align:left; padding: var(--sp-4); font-weight:600; color: var(--slate); font-size:0.8rem; text-transform:uppercase; letter-spacing:0.05em; }
  .referrals-table td { padding: var(--sp-4); border-bottom:1px solid rgba(255,255,255,0.06); color: var(--white); }
  .referrals-table tbody tr:hover { background: rgba(224,123,0,0.05); }
  .status-badge { display:inline-block; padding:4px 12px; border-radius: var(--radius-full); font-size:0.75rem; font-weight:600; text-transform:uppercase; }
  .status-clicked { background: var(--blue-light); color:#1E40AF; }
  .status-registered { background: var(--blue-light); color:#1E40AF; }
  .status-submitted { background: var(--amber-light); color:#92400E; }
  .status-in-progress { background: var(--amber-light); color:#92400E; }
  .status-completed { background: var(--green-light); color:#065F46; }
  .status-paid { background: var(--green-light); color:#065F46; }
  .empty-referrals { text-align:center; padding: var(--sp-12); color: var(--slate); }
  .empty-referrals p { margin:0; }

  .how-it-works { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px,1fr)); gap: var(--sp-8); }
  .how-step { background: var(--navy-2); border:1px solid rgba(255,255,255,0.06); border-radius: var(--radius-lg); padding: var(--sp-8); text-align:center; }
  .how-step-number { width:48px;height:48px;background:var(--amber-glow);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;color:var(--amber);margin:0 auto var(--sp-4); }
  .how-step h4 { margin-bottom: var(--sp-3); color: var(--white); }
  .how-step p { font-size:0.95rem; line-height:1.6; margin:0; color: var(--slate); }

  .faq-list { display:flex; flex-direction:column; gap: var(--sp-4); }
  .faq-item { background: var(--navy-2); border:1px solid rgba(255,255,255,0.06); border-radius: var(--radius-md); overflow:hidden; }
  .faq-question { width:100%; cursor:pointer; padding: var(--sp-6); display:flex; justify-content:space-between; align-items:center; font-weight:600; color: var(--white); background: var(--navy-2); border:none; text-align:left; font-family: var(--font-body); font-size:1rem; }
  .faq-question:hover { background: var(--navy-3); }
  .faq-icon { font-size:1.2rem; color: var(--amber); transition: transform 0.3s; }
  .faq-item.open .faq-icon { transform: rotate(180deg); }
  .faq-answer { max-height:0; overflow:hidden; transition: max-height 0.3s; background: var(--navy); }
  .faq-item.open .faq-answer { max-height:500px; padding: var(--sp-6); }
  .faq-answer p { margin:0; line-height:1.7; color: var(--slate); }

  .tax-notice { background: rgba(11,25,41,0.6); border:1px solid rgba(224,123,0,0.2); border-radius: var(--radius-md); padding: var(--sp-8); }
  .tax-notice-label { font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--amber);margin-bottom:var(--sp-3); }
  .tax-notice-body { color: var(--slate); font-size:0.9rem; line-height:1.7; margin:0; }
  .commission-disclosure { color: var(--slate); font-size:0.85rem; line-height:1.6; text-align:center; margin:0; }
  .referral-fee-disclaimer { color: var(--slate); font-size:0.85rem; line-height:1.6; text-align:center; margin:0; }

  .btn { padding: var(--sp-3) var(--sp-6); border-radius: var(--radius-md); font-weight:600; font-size:0.95rem; border:none; cursor:pointer; transition: all var(--duration) var(--ease); font-family: var(--font-body); display:inline-flex; align-items:center; justify-content:center; gap: var(--sp-2); text-decoration:none; }
  .btn-primary { background: var(--amber); color: var(--navy); font-weight:700; }
  .btn-primary:hover { background: var(--amber-2); }
  .btn-primary.copied { background: var(--green); color: var(--white); }
  .btn-secondary { background: var(--navy-3); color: var(--white); border:1px solid rgba(255,255,255,0.12); }
  .btn-secondary:hover { background: var(--mid); }
  .btn-secondary.copied { background: var(--green); color: var(--white); }
  .btn-sm { padding: var(--sp-2) var(--sp-4); font-size:0.85rem; }
  .btn-block { width:100%; }

  @media (max-width: 768px) {
    .referral-link-actions { flex-direction: column; }
    .referral-link-actions .btn { width:100%; }
    .photo-upload-grid { grid-template-columns: 1fr; }
    .share-grid { grid-template-columns: 1fr; }
    .referrals-summary { flex-direction: column; gap: var(--sp-4); }
    .referrals-table { font-size:0.85rem; }
    .referrals-table th, .referrals-table td { padding: var(--sp-2); }
  }
`;
