'use client';

/**
 * Homeowner Color-Selection surface — /color-selection (D-211 Phase 27, PR 2/2).
 * Behaviour-faithful React port of color-selection.html (repo root).
 *
 * Tri-state top-level: pending → iframe-return → page (mirrors H4 project-confirmation).
 * Data layer: use-color-selection-data.ts.
 * Pure logic + locked copy: utils.ts + copy.ts (PR 1/2 — IMPORTED, never re-inlined).
 * Reusable embed: @/components/docusign-embed (IMPORTED, not rebuilt).
 *
 * Intentional deltas from the static (same family as H4):
 *   • buildColorAddendumPayload omits `signer` (D-220: the EF derives it) and adds a
 *     return_url targeting this React route (carries ?signed=true for the embed bridge).
 *   • Ownership/missing-claim are gate panels (H4 idiom) rather than alert()+redirect.
 *   • The empty-color guard is an inline error, not window.alert.
 *   • When the addendum guard fails (missing claim/contractor/signer-email) the page shows
 *     the saved/fallback copy. The static returned silently on a guard-fail; per the brief
 *     the fallback copy is surfaced so a saved color never leaves the user on a dead end.
 *     The color is always saved first, so no data is lost either way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  DocuSignEmbed,
  isSigningCompleteReturn,
  runSigningReturnBridge,
} from '@/components/docusign-embed';
import { HomeownerShell } from '../_shell/HomeownerShell';
import {
  COLOR_COPY as C,
  subtitleBrandKnown,
  subtitleBrandUnconfirmed,
  colorBoardVisitRequested,
  colorBoardPhoneSuffix,
  addendumFallbackWithPhone,
  addendumFallbackNoPhone,
  colorBoardMailtoBody,
} from './copy';
import {
  hasVisualizer,
  isLinkOutBrand,
  getVisualizerDescription,
  resolveLinkOut,
  canCreateAddendum,
  jobNumberFromClaimId,
} from './utils';
import {
  useColorSelectionData,
  saveColorSelection,
  createColorAddendumEnvelope,
  requestColorBoardVisit,
} from './use-color-selection-data';

// ── Top-level page: tri-state boot ────────────────────────────────────────────

export default function ColorSelectionPage() {
  const [view, setView] = useState<'pending' | 'iframe-return' | 'page'>('pending');

  useEffect(() => {
    if (runSigningReturnBridge()) {
      setView('iframe-return');
      return;
    }
    setView('page');
  }, []);

  if (view === 'pending') {
    return (
      <div className="oqcs-boot">
        <div className="oqcs-spin" />
        <style>{STYLES}</style>
      </div>
    );
  }

  if (view === 'iframe-return') {
    return (
      <div className="oqcs-return">
        <p>Finalizing your signature…</p>
        <style>{STYLES}</style>
      </div>
    );
  }

  return (
    <HomeownerShell active="dashboard">
      <style>{STYLES}</style>
      <Content />
    </HomeownerShell>
  );
}

// ── Content: auth + params + data layer ──────────────────────────────────────

function Content() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;

  const [claimId, setClaimId] = useState<string | null>(null);
  const [paramsReady, setParamsReady] = useState(false);
  const [signedReturn, setSignedReturn] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setClaimId(sp.get('claim_id'));
    setSignedReturn(isSigningCompleteReturn(sp));
    setParamsReady(true);
  }, []);

  const data = useColorSelectionData(userId, claimId, paramsReady);

  if (!paramsReady || data.loading) {
    return <Boot />;
  }

  if (data.gate === 'missing-claim') {
    return (
      <Wrap>
        <ErrorPanel
          title="Missing claim ID"
          detail={
            data.error ??
            'No claim ID was found in the URL. Please return to your dashboard and navigate here from your project page.'
          }
        />
      </Wrap>
    );
  }

  if (data.gate === 'access-denied') {
    return (
      <Wrap>
        <GatePanel
          title="Access Denied"
          body="You do not have permission to access this project."
        />
      </Wrap>
    );
  }

  // gate === 'ready'
  return (
    <PageBody
      data={data}
      claimId={claimId!}
      userId={userId!}
      signedReturn={signedReturn}
    />
  );
}

// ── PageBody: the color-selection flow ───────────────────────────────────────

function PageBody({
  data,
  claimId,
  userId,
  signedReturn,
}: {
  data: ReturnType<typeof useColorSelectionData>;
  claimId: string;
  userId: string;
  signedReturn: boolean;
}) {
  const { brand, contractorName, contractorPhone, contractorId, signerEmail, zipCode } = data;

  // ── Phase ──
  const [phase, setPhase] = useState<'page' | 'done'>('page');

  // ── Confirmation state ──
  const [colorInput, setColorInput] = useState<string>(data.selectedColorName ?? '');
  const [confirmed, setConfirmed] = useState<boolean>(!!data.selectedColorName);
  const [colorError, setColorError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Addendum state ──
  const [addendum, setAddendum] = useState<'none' | 'signing' | 'fallback'>('none');
  const [signingUrl, setSigningUrl] = useState<string | null>(null);

  // ── In-person request state ──
  const [inPersonMsg, setInPersonMsg] = useState<string | null>(null);
  const [inPersonDisabled, setInPersonDisabled] = useState(false);

  // ── Visualizer scroll target ──
  const visualizerRef = useRef<HTMLDivElement>(null);

  // ── onComplete ref (stable identity for the embed listener) ──
  const onCompleteRef = useRef<() => void>(() => {});
  onCompleteRef.current = () => {
    setPhase('done');
    setSigningUrl(null);
  };
  const handleComplete = useCallback(() => onCompleteRef.current(), []);

  // ── Init-time signed=true return (mirror H4) ──
  const firedReturn = useRef(false);
  useEffect(() => {
    if (signedReturn && !firedReturn.current) {
      firedReturn.current = true;
      setPhase('done');
    }
  }, [signedReturn]);

  // ── Confirm color (two-stage: save first → success → THEN addendum) ──
  const handleConfirm = useCallback(async () => {
    const name = colorInput.trim();
    if (!name) {
      setColorError(true);
      return;
    }
    setColorError(false);
    setSaveError(null);
    setSaving(true);

    // a. SAVE FIRST
    try {
      await saveColorSelection({ claimId, userId, brand, colorName: name });
    } catch (err) {
      setSaving(false);
      setSaveError(err instanceof Error ? err.message : 'Error saving color. Please try again.');
      return;
    }

    // b. Success state immediately (independent of signing)
    setConfirmed(true);
    setSaving(false);

    // c. THEN attempt the DocuSign addendum
    if (!canCreateAddendum({ claimId, contractorId, signerEmail })) {
      setAddendum('fallback');
      return;
    }
    try {
      const { signingUrl: url } = await createColorAddendumEnvelope({
        claimId,
        contractorId: contractorId!,
        origin: window.location.origin,
      });
      setSigningUrl(url);
      setAddendum('signing');
    } catch {
      setAddendum('fallback');
    }
  }, [colorInput, claimId, userId, brand, contractorId, signerEmail]);

  // ── In-person color board request ──
  const handleInPerson = useCallback(async () => {
    const res = await requestColorBoardVisit({ claimId, userId });
    if (res.status === 'already') {
      setInPersonMsg(C.colorBoardAlreadyRequested);
      return;
    }
    if (res.status === 'created') {
      let msg = colorBoardVisitRequested(contractorName);
      if (contractorPhone) msg += colorBoardPhoneSuffix(contractorPhone);
      setInPersonMsg(msg);
      setInPersonDisabled(true);
      return;
    }
    // error → mailto fallback (static 1054-1057)
    const subject = encodeURIComponent(C.colorBoardMailtoSubject);
    const body = encodeURIComponent(
      colorBoardMailtoBody(jobNumberFromClaimId(claimId), contractorName || 'unknown'),
    );
    window.location.href = `mailto:${C.colorBoardMailtoAddress}?subject=${subject}&body=${body}`;
  }, [claimId, userId, contractorName, contractorPhone]);

  // ── Option-card click ──
  const handleOptionClick = useCallback(
    (id: 'visualize' | 'browse' | 'inperson') => {
      if (id === 'visualize') {
        visualizerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (id === 'inperson') {
        void handleInPerson();
      }
      // 'browse' is a no-op in the static (analytics only) — preserved.
    },
    [handleInPerson],
  );

  // ── Done screen (after addendum signing completes or a signed=true return) ──
  if (phase === 'done') {
    return (
      <Wrap>
        <div className="oqcs-success-screen">
          <div className="oqcs-success-screen-icon">✅</div>
          <h2 className="oqcs-success-screen-title">Color Confirmed!</h2>
          <p className="oqcs-success-screen-body">{C.successText}</p>
          <a className="oqcs-btn oqcs-btn-primary" href="/dashboard">
            Back to Dashboard →
          </a>
        </div>
      </Wrap>
    );
  }

  const subtitle = brand
    ? subtitleBrandKnown(contractorName, brand)
    : subtitleBrandUnconfirmed(contractorName);

  const showLinkOutNote = isLinkOutBrand(brand);

  const OPTIONS: {
    id: 'visualize' | 'browse' | 'inperson';
    title: string;
    icon: string;
    description: string;
    primary: boolean;
    button: string;
  }[] = [
    {
      id: 'visualize',
      title: C.optionVisualizeTitle,
      icon: C.optionVisualizeIcon,
      description: getVisualizerDescription(brand),
      primary: true,
      button: C.optionVisualizeButton,
    },
    {
      id: 'browse',
      title: C.optionBrowseTitle,
      icon: C.optionBrowseIcon,
      description: C.optionBrowseDescription,
      primary: false,
      button: C.optionBrowseButton,
    },
    {
      id: 'inperson',
      title: C.optionInPersonTitle,
      icon: C.optionInPersonIcon,
      description: C.optionInPersonDescription,
      primary: false,
      button: C.optionInPersonButton,
    },
  ];

  return (
    <Wrap>
      {/* Header */}
      <header className="oqcs-head">
        <h1 className="oqcs-title">{C.headerTitle}</h1>
        <p className="oqcs-subtitle">{subtitle}</p>
      </header>

      {/* No-rush banner */}
      <div className="oqcs-norush">
        <div className="oqcs-norush-icon">{C.noRushIcon}</div>
        <p className="oqcs-norush-text">{C.noRushText}</p>
      </div>

      {/* Option cards */}
      <div className="oqcs-options">
        {OPTIONS.map((opt) => (
          <div
            key={opt.id}
            className={'oqcs-option-card' + (opt.primary ? ' is-primary' : '')}
          >
            <div className="oqcs-option-icon">{opt.icon}</div>
            <h3 className="oqcs-option-title">{opt.title}</h3>
            <p className="oqcs-option-desc">{opt.description}</p>
            {showLinkOutNote && (
              <div className="oqcs-option-note">
                <span className="oqcs-ext">
                  <span className="oqcs-ext-icon">{C.externalLinkIcon}</span> {C.opensInNewTabLabel}
                </span>
              </div>
            )}
            <button
              type="button"
              className="oqcs-btn oqcs-btn-primary oqcs-btn-full"
              onClick={() => handleOptionClick(opt.id)}
            >
              {opt.button}
            </button>
          </div>
        ))}
      </div>

      {/* Visualizer */}
      <div className="oqcs-visualizer" ref={visualizerRef}>
        <div className="oqcs-visualizer-title">{C.visualizerSectionTitle}</div>
        <Visualizer brand={brand} zip={zipCode} />
      </div>

      {/* In-person color samples */}
      <div className="oqcs-inperson">
        <div className="oqcs-inperson-icon">{C.inPersonIcon}</div>
        <div className="oqcs-inperson-content">
          <h3 className="oqcs-inperson-title">{C.inPersonTitle}</h3>
          <p className="oqcs-inperson-desc">{C.inPersonDescription}</p>
          <button
            type="button"
            className="oqcs-btn oqcs-btn-secondary"
            onClick={() => void handleInPerson()}
            disabled={inPersonDisabled}
          >
            {C.inPersonButton}
          </button>
          {inPersonMsg && <div className="oqcs-inperson-confirm">{inPersonMsg}</div>}
        </div>
      </div>

      {/* Confirmation */}
      <div className="oqcs-confirm">
        <div className="oqcs-confirm-head">
          <h2 className="oqcs-confirm-title">{C.confirmationTitle}</h2>
          <p className="oqcs-confirm-subtitle">{C.confirmationSubtitle}</p>
        </div>

        <form
          className="oqcs-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleConfirm();
          }}
        >
          <div className="oqcs-form-row">
            <div className="oqcs-form-group">
              <label className="oqcs-label">{C.brandLabel}</label>
              <div className="oqcs-brand-display">
                <span className="oqcs-brand-value">{brand || C.brandDisplayUnconfirmed}</span>
              </div>
            </div>

            <div className="oqcs-form-group">
              <label className="oqcs-label" htmlFor="color-input">
                {C.colorNameLabel}
              </label>
              <input
                type="text"
                id="color-input"
                className={'oqcs-input' + (colorError ? ' oqcs-input-error' : '')}
                placeholder={C.colorNamePlaceholder}
                value={colorInput}
                disabled={confirmed}
                onChange={(e) => {
                  setColorError(false);
                  setColorInput(e.target.value);
                }}
              />
              {colorError && (
                <div className="oqcs-field-error">Please enter a color name.</div>
              )}
            </div>
          </div>

          <div className="oqcs-note">{C.confirmationNote}</div>

          {saveError && <div className="oqcs-submit-error">{saveError}</div>}

          <div className="oqcs-form-actions">
            <button
              type="submit"
              id="confirmBtn"
              className="oqcs-btn oqcs-btn-primary oqcs-btn-lg"
              disabled={confirmed || saving}
            >
              {confirmed ? C.confirmButtonConfirmed : saving ? C.confirmButtonSaving : C.confirmButton}
            </button>
            <a href="/dashboard" className="oqcs-btn oqcs-btn-secondary oqcs-btn-lg">
              {C.backToDashboardButton}
            </a>
          </div>

          {confirmed && <div className="oqcs-success">{C.successText}</div>}
        </form>

        {/* Addendum (rendered below the form, like the static) */}
        {addendum === 'signing' && signingUrl && (
          <div className="oqcs-addendum">
            <h3 className="oqcs-addendum-heading">{C.addendumHeading}</h3>
            <p className="oqcs-addendum-body">{C.addendumBody}</p>
            <DocuSignEmbed
              signingUrl={signingUrl}
              onComplete={handleComplete}
              title={C.addendumIframeTitle}
            />
          </div>
        )}

        {addendum === 'fallback' && (
          <div className="oqcs-addendum-fallback">
            <p>
              {C.addendumFallbackBase}{' '}
              {contractorPhone
                ? addendumFallbackWithPhone(contractorName, contractorPhone)
                : addendumFallbackNoPhone(contractorName)}
            </p>
          </div>
        )}
      </div>
    </Wrap>
  );
}

// ── Visualizer (faithful to the static: OC embed / link-out / brand-unknown) ──

function Visualizer({ brand, zip }: { brand: string | null; zip: string }) {
  if (!brand || !hasVisualizer(brand)) {
    return (
      <div className="oqcs-brand-unknown">
        <div className="oqcs-brand-unknown-icon">{C.brandUnknownIcon}</div>
        <div className="oqcs-brand-unknown-title">{C.brandUnknownTitle}</div>
        <p className="oqcs-brand-unknown-text">{C.brandUnknownText}</p>
      </div>
    );
  }

  if (brand === 'Owens Corning') {
    return <OCVisualizer zip={zip} />;
  }

  if (isLinkOutBrand(brand)) {
    return <LinkOutVisualizer brand={brand} />;
  }

  // hasVisualizer is true for exactly the six KNOWN_BRANDS, all handled above; this
  // is unreachable but keeps the function total.
  return null;
}

// ── Owens Corning Design EyeQ — lazy embed (desktop) / link-out (mobile) ──

function OCVisualizer({ zip }: { zip: string }) {
  const [isMobile, setIsMobile] = useState(false);
  const [launched, setLaunched] = useState(false);

  // window is unavailable during SSR — read viewport after mount to avoid a hydration
  // mismatch (the static reads window.innerWidth synchronously on the client).
  useEffect(() => {
    setIsMobile(window.innerWidth <= 768);
  }, []);

  // Inject the OC widget script ONLY on user click, once (the script blocks the main
  // thread synchronously — auto-loading on init freezes the tab; static B3 fix 866-901).
  const launch = useCallback(() => {
    setLaunched(true);
    const selector = `script[src*="apis.owenscorning.com/client/widget.js"]`;
    if (!document.querySelector(selector)) {
      const script = document.createElement('script');
      script.src = C.ocWidgetScriptUrl;
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  if (isMobile) {
    return (
      <div className="oqcs-oc-mobile">
        <p className="oqcs-oc-lead">{C.ocLeadParagraph}</p>
        <a
          href={C.ocMobileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="oqcs-btn oqcs-btn-primary"
        >
          {C.ocMobileButton} <span className="oqcs-ext-icon">{C.externalLinkIcon}</span>
        </a>
        <div className="oqcs-option-note oqcs-oc-after">{C.ocAfterVisualizingMobile}</div>
      </div>
    );
  }

  return (
    <div className="oqcs-oc-desktop">
      <p className="oqcs-oc-lead">{C.ocLeadParagraph}</p>
      {!launched ? (
        <div className="oqcs-oc-launcher">
          <button type="button" className="oqcs-btn oqcs-btn-primary" onClick={launch}>
            {C.ocLauncherButton}
          </button>
          <p className="oqcs-oc-launcher-note">{C.ocLauncherSubNote}</p>
        </div>
      ) : (
        <div id="oc-widget-container" className="oqcs-oc-widget">
          <div id="visualizer" data-zip={zip} />
        </div>
      )}
      <div className="oqcs-option-note oqcs-oc-after">{C.ocAfterVisualizingDesktop}</div>
    </div>
  );
}

// ── Link-out visualizer (GAF / CertainTeed / TAMKO / Atlas / IKO) ──

function LinkOutVisualizer({ brand }: { brand: string }) {
  const target = resolveLinkOut(brand);
  const copy = C.linkOut[brand as keyof typeof C.linkOut];
  if (!target || !copy) return null;

  return (
    <div className="oqcs-linkout">
      <p className="oqcs-linkout-lead">{copy.paragraph}</p>
      <a
        href={target.url}
        target="_blank"
        rel="noopener noreferrer"
        className="oqcs-btn oqcs-btn-primary"
      >
        {target.label} <span className="oqcs-ext-icon">{C.externalLinkIcon}</span>
      </a>
      <div className="oqcs-option-note oqcs-oc-after">{copy.afterNote}</div>
    </div>
  );
}

// ── Presentational helpers ─────────────────────────────────────────────────────

function Boot() {
  return (
    <div className="oqcs-boot">
      <div className="oqcs-spin" />
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="oqcs-wrap">{children}</div>;
}

function GatePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="oqcs-panel oqcs-panel-info">
      <h1 className="oqcs-panel-title">{title}</h1>
      <p className="oqcs-panel-body">{body}</p>
      <a className="oqcs-btn oqcs-btn-primary" href="/dashboard">
        Back to Dashboard →
      </a>
    </div>
  );
}

function ErrorPanel({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="oqcs-error">
      <div className="oqcs-error-icon">⚠️</div>
      <p className="oqcs-error-title">{title}</p>
      <p className="oqcs-error-detail">{detail}</p>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const STYLES = `
  .oqcs-boot, .oqcs-return { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; gap:1rem; color:var(--white,#fff); }
  .oqcs-return p { color:var(--green,#10b981); font-size:1.2rem; }
  .oqcs-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqcs-spin .8s linear infinite; }
  @keyframes oqcs-spin { to { transform:rotate(360deg); } }
  .oqcs-wrap { max-width:960px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqcs-head { margin-bottom:1.5rem; }
  .oqcs-title { font-size:clamp(1.75rem,4vw,2.5rem); margin:0 0 .5rem; }
  .oqcs-subtitle { color:var(--slate,#94a3b8); font-size:1.1rem; max-width:600px; margin:0; }
  .oqcs-btn { display:inline-flex; align-items:center; justify-content:center; gap:.35rem; border:none; border-radius:8px; padding:.7rem 1.4rem; font-size:.95rem; font-weight:700; cursor:pointer; font-family:inherit; text-decoration:none; }
  .oqcs-btn:disabled { opacity:.5; cursor:not-allowed; }
  .oqcs-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqcs-btn-primary:hover:not(:disabled) { filter:brightness(1.05); }
  .oqcs-btn-secondary { background:transparent; color:var(--white,#fff); border:1.5px solid rgba(255,255,255,0.2); }
  .oqcs-btn-secondary:hover:not(:disabled) { border-color:var(--amber,#E07B00); background:rgba(224,123,0,0.08); }
  .oqcs-btn-full { width:100%; }
  .oqcs-btn-lg { padding:.85rem 2rem; font-size:1rem; }
  .oqcs-norush { display:flex; align-items:flex-start; gap:1rem; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); border-left:4px solid var(--green,#10b981); border-radius:12px; padding:1.25rem; margin-bottom:2rem; }
  .oqcs-norush-icon { font-size:1.5rem; flex-shrink:0; color:var(--green,#10b981); }
  .oqcs-norush-text { margin:0; color:rgba(255,255,255,0.9); }
  .oqcs-options { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:1.5rem; margin-bottom:2rem; }
  .oqcs-option-card { background:var(--navy-2,rgba(255,255,255,0.03)); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:1.75rem; display:flex; flex-direction:column; }
  .oqcs-option-card.is-primary { border-color:var(--amber,#E07B00); box-shadow:0 0 0 1px rgba(224,123,0,0.3); }
  .oqcs-option-icon { font-size:2.5rem; margin-bottom:.75rem; }
  .oqcs-option-title { font-size:1.25rem; font-weight:700; margin:0 0 .5rem; }
  .oqcs-option-desc { color:rgba(255,255,255,0.85); margin:0 0 1.25rem; flex:1; line-height:1.6; }
  .oqcs-option-note { font-size:.85rem; color:rgba(255,255,255,0.7); margin-bottom:1rem; padding:.75rem 1rem; background:rgba(255,255,255,0.02); border-radius:6px; border-left:2px solid var(--amber,#E07B00); }
  .oqcs-ext { display:inline-flex; align-items:center; gap:.4rem; }
  .oqcs-ext-icon { font-size:.9rem; }
  .oqcs-visualizer { background:var(--navy-3,rgba(255,255,255,0.04)); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:1.75rem; margin-bottom:2rem; scroll-margin-top:80px; }
  .oqcs-visualizer-title { font-size:1.1rem; font-weight:600; margin-bottom:1rem; }
  .oqcs-oc-lead, .oqcs-linkout-lead { color:var(--slate,#94a3b8); margin:0 0 1rem; }
  .oqcs-oc-launcher { text-align:center; padding:1.5rem 0; }
  .oqcs-oc-launcher-note { color:var(--slate,#94a3b8); font-size:.875rem; margin:.75rem 0 0; }
  .oqcs-oc-widget { min-height:420px; background:rgba(0,0,0,0.15); border-radius:8px; overflow:hidden; }
  .oqcs-oc-after { margin-top:1rem; margin-bottom:0; }
  .oqcs-oc-mobile, .oqcs-linkout { padding:1.5rem; background:rgba(255,255,255,0.03); border-radius:8px; }
  .oqcs-brand-unknown { text-align:center; padding:2.5rem 1.75rem; background:rgba(255,255,255,0.02); border-radius:8px; border:1px dashed rgba(255,255,255,0.1); }
  .oqcs-brand-unknown-icon { font-size:2.5rem; margin-bottom:.75rem; }
  .oqcs-brand-unknown-title { font-size:1rem; font-weight:600; margin-bottom:.5rem; }
  .oqcs-brand-unknown-text { color:var(--slate,#94a3b8); font-size:.9rem; max-width:480px; margin:0 auto; line-height:1.6; }
  .oqcs-inperson { display:flex; align-items:flex-start; gap:1.5rem; background:rgba(224,123,0,0.06); border:1px solid rgba(224,123,0,0.25); border-left:4px solid #E07B00; border-radius:12px; padding:1.75rem; margin-bottom:2rem; }
  .oqcs-inperson-icon { font-size:2.2rem; flex-shrink:0; line-height:1; }
  .oqcs-inperson-content { flex:1; }
  .oqcs-inperson-title { font-size:1.1rem; font-weight:600; margin:0 0 .5rem; }
  .oqcs-inperson-desc { color:var(--slate,#94a3b8); margin:0 0 1.25rem; font-size:.95rem; line-height:1.6; }
  .oqcs-inperson-confirm { margin-top:1.25rem; background:var(--green-light,#D1FAE5); color:#065F46; padding:1.25rem; border-radius:12px; border-left:4px solid var(--green,#10b981); }
  .oqcs-confirm { background:var(--navy-2,rgba(255,255,255,0.03)); border:1px solid rgba(255,255,255,0.06); border-radius:12px; padding:1.75rem; margin-bottom:2rem; }
  .oqcs-confirm-head { margin-bottom:1.5rem; padding-bottom:1.5rem; border-bottom:1px solid rgba(255,255,255,0.06); }
  .oqcs-confirm-title { font-size:1.25rem; margin:0 0 .5rem; }
  .oqcs-confirm-subtitle { color:var(--slate,#94a3b8); margin:0; }
  .oqcs-form { display:grid; gap:1.5rem; }
  .oqcs-form-row { display:grid; grid-template-columns:1fr 1fr; gap:1.5rem; }
  .oqcs-form-group { display:flex; flex-direction:column; gap:.4rem; }
  .oqcs-label { font-size:.87rem; font-weight:600; color:var(--slate,#94a3b8); }
  .oqcs-brand-display { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:8px; padding:.85rem 1rem; }
  .oqcs-brand-value { font-size:1rem; font-weight:600; color:var(--white,#fff); }
  .oqcs-input { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); border-radius:7px; padding:.7rem .95rem; color:var(--white,#fff); font-family:inherit; font-size:.95rem; }
  .oqcs-input:focus { outline:none; border-color:var(--amber,#E07B00); }
  .oqcs-input:disabled { opacity:.7; }
  .oqcs-input-error { border-color:#ef4444 !important; }
  .oqcs-field-error { color:#ef4444; font-size:.8rem; }
  .oqcs-note { font-size:.9rem; color:var(--slate,#94a3b8); padding:1rem; background:rgba(224,123,0,0.08); border-radius:6px; border-left:2px solid var(--amber,#E07B00); }
  .oqcs-submit-error { background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:8px; padding:.75rem 1rem; color:#ef4444; font-size:.9rem; }
  .oqcs-form-actions { display:flex; gap:1rem; flex-wrap:wrap; }
  .oqcs-success { background:var(--green-light,#D1FAE5); color:#065F46; padding:1.25rem; border-radius:12px; border-left:4px solid var(--green,#10b981); }
  .oqcs-addendum { margin-top:2rem; padding:1.5rem; background:rgba(224,123,0,0.08); border:1px solid rgba(224,123,0,0.3); border-left:4px solid #E07B00; border-radius:12px; }
  .oqcs-addendum-heading { margin:0 0 .75rem; }
  .oqcs-addendum-body { color:var(--slate,#94a3b8); margin:0 0 1rem; }
  .oqcs-addendum-fallback { margin-top:1.5rem; padding:1rem 1.25rem; background:rgba(245,158,11,0.08); border-left:3px solid var(--amber,#E07B00); border-radius:8px; }
  .oqcs-addendum-fallback p { color:rgba(255,255,255,0.8); margin:0; font-size:.9rem; }
  .oqcs-success-screen { text-align:center; padding:3rem 1.5rem; }
  .oqcs-success-screen-icon { font-size:2.5rem; margin-bottom:.75rem; }
  .oqcs-success-screen-title { font-size:1.6rem; margin:0 0 .75rem; }
  .oqcs-success-screen-body { color:var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; max-width:520px; margin:0 auto 1.5rem; }
  .oqcs-panel { text-align:center; padding:2.5rem 1.5rem; border-radius:12px; }
  .oqcs-panel-info { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); }
  .oqcs-panel-title { font-size:1.3rem; margin:0 0 .6rem; }
  .oqcs-panel-body { color:var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; max-width:520px; margin:0 auto 1.5rem; }
  .oqcs-error { text-align:center; padding:1.75rem 1.5rem; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:12px; }
  .oqcs-error-icon { font-size:2rem; margin-bottom:.5rem; }
  .oqcs-error-title { color:#ef4444; font-weight:600; margin:0 0 .35rem; }
  .oqcs-error-detail { color:var(--slate,#94a3b8); font-size:.9rem; margin:0; }
  @media (max-width:768px){ .oqcs-wrap{ padding:1.5rem 1rem 2.5rem; } .oqcs-form-row{ grid-template-columns:1fr; } .oqcs-options{ grid-template-columns:1fr; } .oqcs-inperson{ flex-direction:column; gap:1rem; } }
`;
