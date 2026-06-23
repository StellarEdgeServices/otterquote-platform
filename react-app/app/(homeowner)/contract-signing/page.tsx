'use client';

/**
 * Homeowner Contract-Signing surface — /contract-signing (D-211 Phase 25, H3,
 * PR 2/2). The (homeowner) route group adds no path segment, so this IS the route
 * the create-docusign-envelope return_url targets and the static page's URL shape
 * (/contract-signing?claim_id=…&signed=true).
 *
 * Behaviour-faithful React port of contract-signing.html (repo root), built on the
 * PR1 scaffolding (DocuSignEmbed, verbatim copy.ts, pure utils.ts) and the contractor
 * analog (react-app/app/contractor/sign/[claimId]/page.tsx). Reuses HomeownerShell
 * (auth + homeowner-role gate + nav) — does NOT re-implement auth. The verbatim
 * Tier-3 legal blocks render from ./copy.ts unchanged. Data + mutations live in
 * ./use-contract-signing-data (the impure layer); this file is the UI + flow.
 *
 * Two deliberate HARDENINGS over the static (net improvements, not behavior ports):
 *   • a defensive claim-ownership check (claim.user_id === user.id), and
 *   • a clearer "waiting on your contractor to sign first" state when the EF reports
 *     the contractor hasn't signed yet — neither alters the signing path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthReady } from '@/hooks/use-auth-ready';
import {
  DocuSignEmbed,
  isSigningCompleteReturn,
  runSigningReturnBridge,
} from '@/components/docusign-embed';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { SIGN_COPY as C } from './copy';
import { resolveClaimId } from './utils';
import {
  buildProjectConfirmationUrl,
  createHomeownerEnvelope,
  recordHomeownerSigned,
  requestBidRenewal,
  sendContractorNudge,
  useContractSigningData,
  type SigningParams,
} from './use-contract-signing-data';

export default function ContractSigningPage() {
  // Resolve whether this render is the DocuSign embedded-return view loaded INSIDE
  // the signing iframe. Short-circuit BEFORE HomeownerShell so the return view never
  // renders nav chrome or triggers an auth bounce inside the iframe — mirrors the
  // iframe-detection block at the top of contract-signing.html (1113-1125) and the
  // contractor page.
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
        <p>{C.returningText}</p>
        <style>{STYLES}</style>
      </div>
    );
  }

  return (
    <HomeownerShell active="dashboard">
      <style>{STYLES}</style>
      <SignContent />
    </HomeownerShell>
  );
}

function SignContent() {
  const { user } = useAuthReady();
  const userId = user?.id ?? null;

  // Resolve URL params once, client-side (the route carries claim_id in the query
  // string — see utils.resolveClaimId / buildHomeownerReturnUrl).
  const [params, setParams] = useState<SigningParams | null>(null);
  const [paramsReady, setParamsReady] = useState(false);
  const [signedReturn, setSignedReturn] = useState(false);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setParams({
      claimId: resolveClaimId(sp, window.location.pathname),
      bid: sp.get('bid'),
      quoteId: sp.get('quote_id'),
      contractorId: sp.get('contractor_id'),
    });
    setSignedReturn(isSigningCompleteReturn(sp));
    setParamsReady(true);
  }, []);

  const data = useContractSigningData(userId, params, paramsReady);
  const { claim, quote, contractor, contractorId, quoteId, gate, ownershipOk, bidExpired } = data;

  // ── Signing flow state ──
  const [phase, setPhase] = useState<'review' | 'signing' | 'done'>('review');
  const [acknowledged, setAcknowledged] = useState(false);
  const [signingUrl, setSigningUrl] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);

  // Signer derived client-side, mirroring contract-signing.html:1562-1566.
  const signerName =
    (claim?.homeowner_name ?? '').trim() ||
    (user?.user_metadata as { full_name?: string } | undefined)?.full_name ||
    user?.email ||
    '';
  const signerEmail = user?.email ?? '';

  // ── onComplete: write homeowner_signed_at, then redirect to the static
  //    project-confirmation (coexistence — React route lands Phase 26). Held in a
  //    ref so the DocuSignEmbed listener always calls the latest closure. ──
  const onCompleteRef = useRef<() => void>(() => {});
  onCompleteRef.current = () => {
    setPhase('done');
    setSigningUrl(null);
    const cid = data.claim?.id ?? params?.claimId ?? '';
    void recordHomeownerSigned({
      claimId: cid,
      quoteId,
      contractorId,
      signedAt: new Date().toISOString(),
    }).finally(() => {
      if (cid) {
        window.location.href = buildProjectConfirmationUrl(cid);
      }
    });
  };
  const handleComplete = useCallback(() => onCompleteRef.current(), []);

  // Init-time return: DocuSign may redirect the TOP window back with ?signed=true /
  // event=signing_complete (not just postMessage). Treat it as completion once the
  // claim is loaded — mirrors contract-signing.html:1299-1303.
  const firedReturn = useRef(false);
  useEffect(() => {
    if (signedReturn && !firedReturn.current && claim && gate !== 'no-contract') {
      firedReturn.current = true;
      onCompleteRef.current();
    }
  }, [signedReturn, claim, gate]);

  // ── Proceed → create the envelope + load the signing iframe. EF UNCHANGED. ──
  const prepareEnvelope = useCallback(async () => {
    if (!contractorId || !quoteId) return;
    const cid = claim?.id ?? params?.claimId ?? '';
    if (!cid) return;
    setPhase('signing');
    setPreparing(true);
    setPrepError(null);
    setSigningUrl(null);
    try {
      const { signingUrl: url } = await createHomeownerEnvelope({
        claimId: cid,
        contractorId,
        quoteId,
        signer: { email: signerEmail, name: signerName },
        origin: window.location.origin,
      });
      setSigningUrl(url);
      setPreparing(false);
    } catch (err) {
      console.error('[contract-signing] prepareEnvelope error:', err);
      setPreparing(false);
      setPrepError(err instanceof Error ? err.message : C.errorDetail);
    }
  }, [contractorId, quoteId, claim, params, signerEmail, signerName]);

  // ── Render gates ──
  if (!paramsReady || data.loading) {
    return <Boot />;
  }

  if (data.error) {
    return (
      <Wrap>
        <ErrorPanel title={C.errorTitle} detail={data.error} />
      </Wrap>
    );
  }

  // Defensive ownership failure (HARDENING) — surface as no-contract, never the
  // signing UI for someone else's claim. RLS is the real gate.
  if (!ownershipOk || gate === 'no-contract') {
    return (
      <Wrap>
        <StatePanel tone="info" title={C.noContractTitle} body={C.noContractBody} />
      </Wrap>
    );
  }

  if (gate === 'already-signed') {
    return (
      <Wrap>
        <StatePanel tone="ok" icon="✅" title={C.alreadySignedTitle} body={C.alreadySignedBody} />
      </Wrap>
    );
  }

  // Expired-bid guard (D-150) — offer a renewal instead of the signing UI.
  if (bidExpired) {
    return (
      <Wrap>
        <BidExpired
          bidId={quoteId ?? quote?.id ?? ''}
          contractor={contractor}
          claim={claim}
          claimId={claim?.id ?? params?.claimId ?? null}
        />
      </Wrap>
    );
  }

  // gate === 'ready'
  const contractorName = contractor?.company_name || contractor?.name || C.ackContractorNameFallback;
  const waitingOnContractor = !quote?.contractor_signed_at;

  return (
    <Wrap>
      <header className="oqcs-head">
        <h1 className="oqcs-title">{C.headerTitle}</h1>
        <p className="oqcs-subtitle">{C.headerSubtitle}</p>
      </header>

      {phase === 'review' && (
        <>
          {/* ── Step 1 disclosures (verbatim — copy.ts) ── */}
          <section className="oqcs-callout">
            <div className="oqcs-callout-icon" aria-hidden="true">
              ⚖️
            </div>
            <div>
              <div className="oqcs-callout-title">{C.rightToCancelTitle}</div>
              <div className="oqcs-callout-body">{C.rightToCancelBody}</div>
            </div>
          </section>

          <section className="oqcs-callout">
            <div className="oqcs-callout-icon" aria-hidden="true">
              💳
            </div>
            <div>
              <div className="oqcs-callout-title">{C.noCostTitle}</div>
              <div className="oqcs-callout-body">{C.noCostBody}</div>
            </div>
          </section>

          {/* ── D-123 acknowledgment — gates Proceed (required before signing) ── */}
          <div className="oqcs-ack">
            <input
              type="checkbox"
              id="otterquoteAcknowledgment"
              className="oqcs-ack-input"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <label className="oqcs-ack-label" htmlFor="otterquoteAcknowledgment">
              <span className="oqcs-ack-text">
                {C.ackLabelLead}
                <span id="ackContractorName">{contractorName}</span>
                {C.ackLabelTail}
              </span>
              <span className="oqcs-ack-hint">{C.ackHint}</span>
            </label>
          </div>

          <div className="oqcs-actions">
            <button
              type="button"
              id="proceedToSignBtn"
              className="oqcs-btn oqcs-btn-primary"
              disabled={!acknowledged}
              onClick={prepareEnvelope}
            >
              {C.proceedCta}
            </button>
          </div>
        </>
      )}

      {phase === 'signing' && (
        <section className="oqcs-sign">
          <h2 className="oqcs-step2-title">{C.step2Title}</h2>
          <p className="oqcs-step2-intro">{C.step2Intro}</p>

          {prepError ? (
            waitingOnContractor ? (
              <StatePanel
                tone="info"
                icon="⏳"
                title="Waiting on your contractor to sign first"
                body="Your contractor signs first under Indiana law (IC 24-5-11). We'll email you the moment it's your turn — no action is needed right now."
              />
            ) : (
              <ErrorPanel title={C.errorTitle} detail={prepError} onRetry={prepareEnvelope} />
            )
          ) : preparing || !signingUrl ? (
            <div className="oqcs-loading">
              <div className="oqcs-spin" />
              <p className="oqcs-loading-title">{C.loadingTitle}</p>
              <p className="oqcs-loading-hint">{C.loadingHint}</p>
            </div>
          ) : (
            <DocuSignEmbed signingUrl={signingUrl} onComplete={handleComplete} />
          )}
        </section>
      )}

      {phase === 'done' && (
        <Confirmation
          contractorName={contractorName}
          contractor={contractor}
          claim={claim}
          claimId={claim?.id ?? params?.claimId ?? null}
        />
      )}
    </Wrap>
  );
}

// ── Step-3 confirmation + contractor nudge ──
function Confirmation({
  contractorName,
  contractor,
  claim,
  claimId,
}: {
  contractorName: string;
  contractor: Parameters<typeof sendContractorNudge>[0]['contractor'];
  claim: Parameters<typeof sendContractorNudge>[0]['claim'];
  claimId: string | null;
}) {
  const [nudge, setNudge] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const onNudge = useCallback(async () => {
    setNudge('sending');
    const ok = await sendContractorNudge({ contractor, claim, claimId });
    setNudge(ok ? 'sent' : 'failed');
  }, [contractor, claim, claimId]);

  return (
    <div className="oqcs-confirm">
      <div className="oqcs-confirm-icon" aria-hidden="true">
        ✅
      </div>
      <h2 className="oqcs-confirm-title">{C.allSetTitle}</h2>
      <p className="oqcs-confirm-sub">
        Contract signed with {contractorName}. They will contact you soon.
      </p>

      <div className="oqcs-nudge">
        <button
          type="button"
          className="oqcs-btn oqcs-btn-secondary"
          disabled={nudge === 'sending' || nudge === 'sent'}
          onClick={onNudge}
        >
          {nudge === 'sent'
            ? '✓ Message sent'
            : nudge === 'sending'
              ? 'Sending…'
              : "Haven't heard from your contractor? Click here."}
        </button>
        {nudge === 'sent' && (
          <p className="oqcs-nudge-status ok">
            We&apos;ve notified {contractorName} and our team. You should hear back soon.
          </p>
        )}
        {nudge === 'failed' && (
          <p className="oqcs-nudge-status err">
            Message failed to send. Please call us directly at (844) 875-3412.
          </p>
        )}
      </div>

      {/* Your Signed Contract (verbatim — copy.ts) */}
      <section className="oqcs-info oqcs-info-green">
        <div className="oqcs-info-title">{C.signedContractTitle}</div>
        <p className="oqcs-info-body">{C.signedContractBody}</p>
        <p className="oqcs-info-note">{C.signedContractSpam}</p>
      </section>

      {/* Your Rights Under Indiana Law (verbatim — copy.ts) */}
      <section className="oqcs-info oqcs-info-amber">
        <div className="oqcs-info-title oqcs-info-title-upper">{C.indianaRightsTitle}</div>
        <p className="oqcs-info-body">{C.indianaRightsBody}</p>
      </section>

      {/* Otter Quotes Contractor Switch Policy (verbatim — copy.ts) */}
      <section className="oqcs-info">
        <div className="oqcs-info-title oqcs-info-title-upper">{C.switchPolicyTitle}</div>
        <p className="oqcs-info-body">{C.switchPolicyP1}</p>
        <p className="oqcs-info-body">{C.switchPolicyP2}</p>
        <p className="oqcs-info-note">{C.switchPolicyNote}</p>
      </section>

      <a className="oqcs-btn oqcs-btn-primary" href="/dashboard">
        {C.goToDashboard}
      </a>
    </div>
  );
}

// ── Expired-bid renewal state (D-150) ──
function BidExpired({
  bidId,
  contractor,
  claim,
  claimId,
}: {
  bidId: string;
  contractor: Parameters<typeof requestBidRenewal>[0]['contractor'];
  claim: Parameters<typeof requestBidRenewal>[0]['claim'];
  claimId: string | null;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');

  const onRenew = useCallback(async () => {
    setState('sending');
    await requestBidRenewal({ bidId, contractor, claim, claimId });
    setState('sent');
  }, [bidId, contractor, claim, claimId]);

  return (
    <div className="oqcs-panel oqcs-panel-info">
      <div className="oqcs-panel-icon" aria-hidden="true">
        ⏰
      </div>
      <h1 className="oqcs-panel-title">This bid has expired</h1>
      <p className="oqcs-panel-body">
        The bid you selected is no longer current. Request an updated bid from your contractor and
        we&apos;ll let them know.
      </p>
      <button
        type="button"
        className="oqcs-btn oqcs-btn-primary"
        disabled={state !== 'idle'}
        onClick={onRenew}
      >
        {state === 'sent' ? '✓ Request Sent' : state === 'sending' ? 'Sending request…' : 'Request an Updated Bid'}
      </button>
    </div>
  );
}

// ── Presentational helpers ──
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
    <div className={'oqcs-panel oqcs-panel-' + tone}>
      {icon && (
        <div className="oqcs-panel-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h1 className="oqcs-panel-title">{title}</h1>
      <p className="oqcs-panel-body">{body}</p>
    </div>
  );
}

function ErrorPanel({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
}) {
  return (
    <div className="oqcs-error">
      <div className="oqcs-error-icon" aria-hidden="true">
        ⚠️
      </div>
      <p className="oqcs-error-title">{title}</p>
      <p className="oqcs-error-detail">{detail}</p>
      {onRetry && (
        <button type="button" className="oqcs-btn oqcs-btn-primary" onClick={onRetry}>
          {C.retryCta}
        </button>
      )}
    </div>
  );
}

const STYLES = `
  .oqcs-boot, .oqcs-return { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:60vh; gap:1rem; color:var(--white,#fff); }
  .oqcs-return p { color:var(--green,#10b981); font-size:1.2rem; }
  .oqcs-spin { width:28px; height:28px; border:3px solid rgba(224,123,0,0.2); border-top-color:var(--amber,#E07B00); border-radius:50%; animation:oqcs-spin .8s linear infinite; }
  @keyframes oqcs-spin { to { transform:rotate(360deg); } }
  .oqcs-wrap { max-width:820px; margin:0 auto; padding:2rem 1.5rem 3rem; color:var(--white,#fff); }
  .oqcs-head { margin-bottom:1.5rem; }
  .oqcs-title { font-size:1.6rem; margin:0 0 .35rem; }
  .oqcs-subtitle { color:var(--slate,#94a3b8); font-size:.95rem; margin:0; }
  .oqcs-callout { display:flex; gap:1rem; background:#FFFBEB; border:1px solid #E07B00; border-radius:12px; padding:1.25rem 1.5rem; margin-bottom:1rem; }
  .oqcs-callout-icon { font-size:1.5rem; line-height:1.2; }
  .oqcs-callout-title { color:#0B1929; font-weight:700; margin-bottom:.35rem; }
  .oqcs-callout-body { color:#374151; font-size:.92rem; line-height:1.6; }
  .oqcs-ack { display:flex; gap:.75rem; align-items:flex-start; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:1rem 1.25rem; margin:1.25rem 0; }
  .oqcs-ack-input { margin-top:.2rem; width:18px; height:18px; flex:0 0 auto; accent-color:var(--amber,#E07B00); cursor:pointer; }
  .oqcs-ack-label { cursor:pointer; }
  .oqcs-ack-text { display:block; color:var(--white,#fff); font-size:.95rem; line-height:1.5; }
  .oqcs-ack-hint { display:block; color:var(--slate,#94a3b8); font-size:.82rem; margin-top:.3rem; }
  .oqcs-actions { display:flex; align-items:center; gap:1.25rem; flex-wrap:wrap; margin-top:.5rem; }
  .oqcs-btn { display:inline-block; border:none; border-radius:8px; padding:.7rem 1.4rem; font-size:.95rem; font-weight:700; cursor:pointer; font-family:inherit; text-decoration:none; }
  .oqcs-btn:disabled { opacity:.5; cursor:not-allowed; }
  .oqcs-btn-primary { background:var(--amber,#E07B00); color:var(--navy,#0B1929); }
  .oqcs-btn-primary:hover:not(:disabled) { filter:brightness(1.05); }
  .oqcs-btn-secondary { background:transparent; color:var(--white,#fff); border:1.5px solid rgba(255,255,255,0.2); }
  .oqcs-btn-secondary:hover:not(:disabled) { border-color:var(--amber,#E07B00); }
  .oqcs-sign { margin-top:.5rem; }
  .oqcs-step2-title { font-size:1.25rem; margin:0 0 .5rem; }
  .oqcs-step2-intro { color:var(--slate,#94a3b8); font-size:.92rem; margin:0 0 1.25rem; }
  .oqcs-loading { text-align:center; padding:2.5rem 1rem; display:flex; flex-direction:column; align-items:center; gap:.6rem; }
  .oqcs-loading-title { color:var(--white,#fff); font-weight:600; margin:.4rem 0 0; }
  .oqcs-loading-hint { color:var(--slate,#94a3b8); font-size:.9rem; margin:0; }
  .oqcs-error { text-align:center; padding:1.75rem 1.5rem; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:12px; }
  .oqcs-error-icon { font-size:2rem; margin-bottom:.5rem; }
  .oqcs-error-title { color:#ef4444; font-weight:600; margin:0 0 .35rem; }
  .oqcs-error-detail { color:var(--slate,#94a3b8); font-size:.9rem; margin:0 0 1rem; }
  .oqcs-panel { text-align:center; padding:2.5rem 1.5rem; border-radius:12px; }
  .oqcs-panel-info { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); }
  .oqcs-panel-ok { background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); }
  .oqcs-panel-icon { font-size:2.25rem; margin-bottom:.5rem; }
  .oqcs-panel-title { font-size:1.3rem; margin:0 0 .6rem; }
  .oqcs-panel-body { color:var(--slate,#94a3b8); font-size:.95rem; line-height:1.6; max-width:520px; margin:0 auto 1.5rem; }
  .oqcs-confirm { text-align:center; padding:1rem 0 2rem; }
  .oqcs-confirm-icon { font-size:2.5rem; margin-bottom:.5rem; }
  .oqcs-confirm-title { font-size:1.6rem; margin:0 0 .5rem; }
  .oqcs-confirm-sub { color:var(--slate,#94a3b8); font-size:.95rem; margin:0 0 1.5rem; }
  .oqcs-nudge { margin:0 0 2rem; }
  .oqcs-nudge-status { font-size:.9rem; margin-top:.75rem; }
  .oqcs-nudge-status.ok { color:var(--green,#10b981); }
  .oqcs-nudge-status.err { color:#ef4444; }
  .oqcs-info { text-align:left; border-radius:12px; padding:1.25rem 1.5rem; margin-bottom:1.25rem; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1); }
  .oqcs-info-green { background:rgba(16,185,129,0.07); border-color:rgba(16,185,129,0.25); }
  .oqcs-info-amber { background:rgba(245,158,11,0.07); border-color:rgba(245,158,11,0.3); }
  .oqcs-info-title { font-weight:700; color:var(--white,#fff); margin-bottom:.5rem; font-size:1rem; }
  .oqcs-info-title-upper { font-size:.9rem; text-transform:uppercase; letter-spacing:.04em; }
  .oqcs-info-body { color:var(--slate,#94a3b8); font-size:.9rem; line-height:1.65; margin:0 0 .75rem; }
  .oqcs-info-note { color:var(--slate,#94a3b8); font-size:.85rem; line-height:1.65; margin:0; }
  @media (max-width:768px){ .oqcs-wrap{ padding:1.5rem 1rem 2.5rem; } }
`;
