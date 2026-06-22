'use client';

/**
 * Contractor Contract-Signing surface — /contractor/sign/[claimId]
 * (D-211 Phase 17 Unit B). Builds the missing Step A of the IC 24-5-11 two-step
 * contract signing: the contractor signs FIRST (document_type "contractor_sign"),
 * then the homeowner signs via the existing contract-signing.html (Step C).
 *
 * This is the contractor analog of contract-signing.html (the live homeowner
 * embedded-signing reference) and reuses its proven embed pattern VERBATIM:
 * invoke create-docusign-envelope → load result.signing_url into an <iframe> →
 * listen via window.addEventListener('message', ...) for completion → success
 * state → route back to the dashboard. The create-docusign-envelope contract is
 * UNCHANGED (the EF derives the signer server-side from the authenticated
 * contractor; we pass signer for parity). Wrapped by the reusable ContractorShell
 * (auth + contractor-role gate + nav) — does NOT re-implement auth.
 *
 * Tier-3 legal copy is verbatim-locked in ./copy.ts (asserted by ./__tests__).
 * contractor_signed_at is owned by the docusign-webhook (NOT written here), so no
 * client-side write touches that column.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthReady } from '@/hooks/use-auth-ready';
import { supabase } from '@/lib/supabase';
import { ContractorShell } from '../../_shell/ContractorShell';
import { useContractorRecordGate } from '../../_shell/use-contractor-record';
import { SIGN_COPY as C } from './copy';
import {
  resolveClaimIdFromPath,
  resolveSelectedQuote,
  resolveSignGate,
  isSigningCompleteEvent,
  type SignableQuote,
  type SignGateState,
} from './utils';

const DASHBOARD_ROUTE = '/contractor/dashboard';

export default function ContractorSignPage() {
  // Resolve whether this render is the DocuSign embedded-return view loaded INSIDE
  // the signing iframe. Must short-circuit BEFORE ContractorShell so the return view
  // never renders nav chrome or triggers an auth bounce inside the iframe — mirrors
  // the iframe-detection block at the top of contract-signing.html (lines 1113-1125).
  const [view, setView] = useState<'pending' | 'iframe-return' | 'page'>('pending');
  useEffect(() => {
    const inIframe = window.self !== window.top;
    const search = new URLSearchParams(window.location.search);
    if (inIframe && isSigningCompleteEvent(search)) {
      try {
        window.parent.postMessage(
          JSON.stringify({ type: 'session_end', event: 'signing_complete' }),
          '*',
        );
      } catch {
        /* posting to parent is best-effort; the parent also accepts URL fallbacks */
      }
      setView('iframe-return');
      return;
    }
    setView('page');
  }, []);

  if (view === 'pending') {
    return (
      <div className="oqs-boot">
        <div className="oqs-spin" />
        <style>{STYLES}</style>
      </div>
    );
  }

  if (view === 'iframe-return') {
    return (
      <div className="oqs-return">
        <p>{C.returningText}</p>
        <style>{STYLES}</style>
      </div>
    );
  }

  return (
    <ContractorShell active="home">
      <style>{STYLES}</style>
      <SignContent />
    </ContractorShell>
  );
}

function SignContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;
  const { contractor, loading: contractorLoading } = useContractorRecordGate(userId);
  const router = useRouter();

  // Route segment from window.location (client-only) — same pattern as the bid route.
  const [claimId, setClaimId] = useState<string | null>(null);
  const [pathResolved, setPathResolved] = useState(false);
  useEffect(() => {
    setClaimId(resolveClaimIdFromPath(window.location.pathname));
    setPathResolved(true);
  }, []);

  // The contractor's quotes for this claim (RLS is the real gate).
  const [quotes, setQuotes] = useState<SignableQuote[] | null>(null);
  const [quotesChecked, setQuotesChecked] = useState(false);
  useEffect(() => {
    if (!contractor || !claimId) {
      if (pathResolved && !claimId) setQuotesChecked(true);
      return;
    }
    let active = true;
    (async () => {
      try {
        const { data } = await supabase
          .from('quotes')
          .select('id, claim_id, contractor_id, status, contractor_signed_at, total_price')
          .eq('claim_id', claimId)
          .eq('contractor_id', contractor.id);
        if (!active) return;
        setQuotes((data as SignableQuote[]) ?? []);
      } catch (err) {
        if (active) {
          console.error('[contractor-sign] quote load error:', err);
          setQuotes([]);
        }
      } finally {
        if (active) setQuotesChecked(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [contractor, claimId, pathResolved]);

  const selectedQuote = useMemo(
    () => (contractor ? resolveSelectedQuote(quotes, contractor.id) : null),
    [quotes, contractor],
  );
  const gate: SignGateState = useMemo(() => resolveSignGate(selectedQuote), [selectedQuote]);

  // ── Signing flow state ──
  const [phase, setPhase] = useState<'review' | 'signing' | 'done'>('review');
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);

  // Mark complete + route home. Held in a ref so the persistent message listener
  // always calls the latest closure without re-subscribing per render.
  const onCompleteRef = useRef<() => void>(() => {});
  onCompleteRef.current = () => {
    setPhase('done');
    setSigningUrl(null);
    setTimeout(() => router.push(DASHBOARD_ROUTE), 1500);
  };

  // Listen for the DocuSign iframe completion message — mirrors
  // handleDocuSignMessage in contract-signing.html (lines 1617-1632).
  useEffect(() => {
    function handle(event: MessageEvent) {
      if (!event.data || typeof event.data !== 'string') return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'session_end' || data.event === 'signing_complete') {
          onCompleteRef.current();
        }
      } catch {
        if (event.data.includes('signed=true') || event.data.includes('signing_complete')) {
          onCompleteRef.current();
        }
      }
    }
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, []);

  // ── Create the envelope + load the signing iframe — invoke + embed mirror
  //    initContractorSigning (contractor-bid-form.html:5833-5885) and
  //    initDocuSign (contract-signing.html:1536-1615). EF contract UNCHANGED. ──
  const prepareEnvelope = useCallback(async () => {
    if (!contractor || !claimId || !selectedQuote) return;
    setPhase('signing');
    setPreparing(true);
    setPrepError(null);
    setSigningUrl(null);
    try {
      const signerName =
        contractor.company_name || String(contractor.owner_name ?? '') || 'Contractor';
      const signerEmail = String(contractor.email ?? '') || user?.email || '';
      // Return the embedded iframe to THIS route so its in-iframe bridge can post
      // completion to the parent (the EF default points at the dead static page).
      const returnUrl = `${window.location.origin}/contractor/sign/${claimId}?signed=contractor`;

      const { data: result, error } = await supabase.functions.invoke(
        'create-docusign-envelope',
        {
          body: {
            claim_id: claimId,
            document_type: 'contractor_sign',
            contractor_id: contractor.id,
            quote_id: selectedQuote.id,
            signer: { email: signerEmail, name: signerName },
            return_url: returnUrl,
          },
        },
      );

      if (error) throw new Error(error.message || 'Failed to create DocuSign envelope');
      if (!result?.signing_url) throw new Error('No signing URL returned from DocuSign');

      setSigningUrl(result.signing_url as string);
      setPreparing(false);
    } catch (err) {
      console.error('[contractor-sign] prepareEnvelope error:', err);
      setPreparing(false);
      setPrepError(err instanceof Error ? err.message : C.errorDetail);
    }
  }, [contractor, claimId, selectedQuote, user]);

  // ── Render gates ──
  if (!pathResolved || contractorLoading || (!!claimId && !quotesChecked)) {
    return (
      <div className="oqs-boot">
        <div className="oqs-spin" />
      </div>
    );
  }
  if (!claimId) {
    return <Shell><div className="oqs-msg oqs-msg-err">{C.noProjectError}</div></Shell>;
  }
  if (!contractor) {
    return (
      <div className="oqs-boot">
        <div className="oqs-spin" />
      </div>
    );
  }

  if (gate === 'no-contract') {
    return (
      <Shell>
        <StatePanel tone="info" title={C.noContractTitle} body={C.noContractBody} />
      </Shell>
    );
  }

  if (gate === 'already-signed') {
    return (
      <Shell>
        <StatePanel tone="ok" title={C.alreadySignedTitle} body={C.alreadySignedBody} icon="✅" />
      </Shell>
    );
  }

  // gate === 'ready'
  return (
    <Shell>
      <h1 className="oqs-title">{C.pageTitle}</h1>

      {/* TIER-3 legal disclaimer (verbatim — ./copy.ts) */}
      <section className="oqs-legal">
        <h2 className="oqs-legal-head">{C.legalHeading}</h2>
        <p className="oqs-legal-p1">
          {C.legalPara1Lead}
          <strong>{C.legalPara1Emphasis}</strong>
          {C.legalPara1Tail}
        </p>
        <p className="oqs-legal-p2">{C.legalPara2}</p>
      </section>

      {phase === 'review' && (
        <div className="oqs-actions">
          <button type="button" className="oqs-btn oqs-btn-primary" onClick={prepareEnvelope}>
            {C.proceedCta}
          </button>
          <a className="oqs-back" href={DASHBOARD_ROUTE}>{C.backToDashboard}</a>
        </div>
      )}

      {phase === 'signing' && (
        <section className="oqs-sign">
          {prepError ? (
            <div className="oqs-ds-error">
              <div className="oqs-ds-icon">⚠️</div>
              <p className="oqs-ds-error-title">{C.errorTitle}</p>
              <p className="oqs-ds-error-detail">{prepError}</p>
              <button type="button" className="oqs-btn oqs-btn-primary" onClick={prepareEnvelope}>
                {C.retryCta}
              </button>
            </div>
          ) : preparing || !signingUrl ? (
            <div className="oqs-ds-loading">
              <div className="oqs-spin" />
              <p className="oqs-ds-loading-title">{C.loadingTitle}</p>
              <p className="oqs-ds-loading-hint">{C.loadingHint}</p>
            </div>
          ) : (
            <iframe
              id="docusignFrame"
              title="DocuSign contract signing"
              src={signingUrl}
              className="oqs-frame"
              allow="geolocation"
            />
          )}
        </section>
      )}

      {phase === 'done' && (
        <div className="oqs-signed">
          <div className="oqs-signed-icon">✅</div>
          <p className="oqs-signed-title">{C.signedTitle}</p>
          <p className="oqs-signed-body">{C.signedBody}</p>
          <p className="oqs-redirecting">{C.redirectingText}</p>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="oqs-wrap">{children}</div>;
}

function StatePanel({
  tone,
  title,
  body,
  icon,
}: {
  tone: 'info' | 'ok';
  title: string;
  body: string;
  icon?: string;
}) {
  return (
    <div className={'oqs-panel oqs-panel-' + tone}>
      {icon && <div className="oqs-panel-icon">{icon}</div>}
      <h1 className="oqs-panel-title">{title}</h1>
      <p className="oqs-panel-body">{body}</p>
      <a className="oqs-btn oqs-btn-primary" href={DASHBOARD_ROUTE}>{C.backToDashboard}</a>
    </div>
  );
}

const STYLES = `
  .oqs-boot, .oqs-return { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; gap:1rem; color:var(--white,#fff); }
  .oqs-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqs-spin .8s linear infinite; }
  @keyframes oqs-spin { to { transform:rotate(360deg); } }
  .oqs-wrap { max-width:820px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqs-title { font-size:1.6rem; margin:0 0 1.25rem; }
  .oqs-legal { background:#FFFBEB; border:2px solid #E07B00; border-radius:12px; padding:1.5rem; margin-bottom:1.5rem; }
  .oqs-legal-head { color:#0B1929; margin:0 0 .75rem; font-size:1.15rem; }
  .oqs-legal-p1 { color:#374151; font-size:.95rem; line-height:1.6; margin:0 0 .75rem; }
  .oqs-legal-p2 { color:#6B7280; font-size:.85rem; margin:0; }
  .oqs-actions { display:flex; align-items:center; gap:1.25rem; flex-wrap:wrap; }
  .oqs-back { color:var(--slate,#94a3b8); text-decoration:none; font-weight:600; font-size:.9rem; }
  .oqs-back:hover { color:var(--white,#fff); }
  .oqs-btn { display:inline-block; border:none; border-radius:8px; padding:.7rem 1.4rem; font-size:.95rem; font-weight:700; cursor:pointer; font-family:inherit; text-decoration:none; }
  .oqs-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqs-btn-primary:hover { filter:brightness(1.05); }
  .oqs-sign { margin-top:.5rem; }
  .oqs-frame { width:100%; min-height:600px; border:1px solid rgba(255,255,255,0.12); border-radius:8px; background:#fff; }
  .oqs-ds-loading { text-align:center; padding:2.5rem 1rem; display:flex; flex-direction:column; align-items:center; gap:.6rem; }
  .oqs-ds-loading-title { color:var(--white,#fff); font-weight:600; margin:.4rem 0 0; }
  .oqs-ds-loading-hint { color:var(--slate,#94a3b8); font-size:.9rem; margin:0; }
  .oqs-ds-error { text-align:center; padding:1.5rem; background:#FEF2F2; border:1px solid #FECACA; border-radius:8px; }
  .oqs-ds-icon { font-size:2rem; margin-bottom:.5rem; }
  .oqs-ds-error-title { color:#DC2626; font-weight:600; margin:0 0 .35rem; }
  .oqs-ds-error-detail { color:#6B7280; font-size:.9rem; margin:0 0 1rem; }
  .oqs-signed { text-align:center; padding:2rem 1rem; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); border-radius:12px; }
  .oqs-signed-icon { font-size:2.25rem; margin-bottom:.5rem; }
  .oqs-signed-title { color:#10b981; font-weight:700; font-size:1.15rem; margin:0 0 .35rem; }
  .oqs-signed-body { color:var(--slate,#94a3b8); font-size:.95rem; margin:0 0 .75rem; }
  .oqs-redirecting { color:var(--slate,#94a3b8); font-size:.85rem; margin:0; }
  .oqs-msg { padding:1.25rem 1.5rem; border-radius:12px; font-size:.95rem; }
  .oqs-msg-err { background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); color:#fca5a5; }
  .oqs-panel { text-align:center; padding:2.5rem 1.5rem; border-radius:12px; }
  .oqs-panel-info { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); }
  .oqs-panel-ok { background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); }
  .oqs-panel-icon { font-size:2.25rem; margin-bottom:.5rem; }
  .oqs-panel-title { font-size:1.3rem; margin:0 0 .6rem; }
  .oqs-panel-body { color:var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; max-width:520px; margin:0 auto 1.5rem; }
  @media (max-width:768px){ .oqs-frame{ min-height:520px; } }
`;
