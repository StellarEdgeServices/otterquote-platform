'use client';

/**
 * Pre-submission checklist + progress (estimate / measurements / material) with
 * document upload (→ parse-loss-sheet), the Hover resend-link action, and the
 * Submit-for-Bids action (→ notify-contractors). Mirrors renderChecklist() +
 * updateProgressBar() + handleUpload()/resendHoverLink()/submitForBids().
 */

import { useRef, useState } from 'react';
import { resendHoverLink, submitForBids, uploadClaimDocument } from '../actions';
import { computeProgress } from '../utils';
import type { HomeownerClaim, HoverOrder } from '../types';

type DocKind = 'estimate' | 'measurements';

export function Checklist({
  claim,
  hoverOrder,
  userId,
  onChange,
}: {
  claim: HomeownerClaim;
  hoverOrder: HoverOrder | null;
  userId: string;
  onChange: () => void;
}) {
  const progress = computeProgress(claim);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const estimateRef = useRef<HTMLInputElement>(null);
  const measurementsRef = useRef<HTMLInputElement>(null);

  async function onFile(kind: DocKind, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    const res = await uploadClaimDocument({ userId, claimId: claim.id, file, timestamp: Date.now(), kind });
    setBusy(null);
    e.target.value = '';
    if (res.ok) {
      setNotice("Document uploaded. We'll process it shortly.");
      onChange();
    } else {
      setError(res.error || 'Upload failed. Please try again.');
    }
  }

  async function onResend() {
    setBusy('resend');
    setError(null);
    setNotice(null);
    const res = await resendHoverLink(claim.id);
    setBusy(null);
    if (res.ok) setNotice('Measurement link re-sent.');
    else setError(res.error || 'Could not resend the link. You may have hit the daily limit.');
  }

  async function onSubmitForBids() {
    setBusy('submit');
    setError(null);
    const res = await submitForBids(claim.id);
    setBusy(null);
    if (res.ok) {
      setNotice('Your project has been submitted for bids!');
      onChange();
    } else {
      setError(res.error || 'Could not submit for bids. Please try again.');
    }
  }

  // #482: static-stack parity (dashboard.html updateSubmitButton) — retail/cash
  // claims have no insurance estimate (measurements are their hard gate);
  // insurance claims gate on the estimate. Material selection required for both.
  const isCash = claim.funding_type === 'cash';
  const items: { id: DocKind | 'material'; label: string; done: boolean }[] = [
    ...(isCash ? [] : [{ id: 'estimate' as DocKind, label: 'Insurance estimate', done: !!claim.has_estimate }]),
    { id: 'measurements' as DocKind, label: 'Property measurements', done: !!claim.has_measurements },
    { id: 'material' as const, label: 'Material selection', done: !!claim.has_material_selection },
  ];

  const canSubmit =
    !claim.ready_for_bids &&
    (isCash ? !!claim.has_measurements : !!claim.has_estimate) &&
    !!claim.has_material_selection;
  const showResend =
    !!hoverOrder && ['pending', 'link_sent'].includes(hoverOrder.status) && !!hoverOrder.capture_link;

  return (
    <section
      style={{
        background: 'var(--navy-2, #0f2942)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '0.875rem',
        padding: '1.5rem',
        color: 'rgba(255,255,255,0.9)',
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Get ready for bids</h2>

      {/* Progress */}
      <div style={{ margin: '0.75rem 0 1.25rem' }}>
        <div style={{ fontSize: '0.8rem', marginBottom: '0.35rem' }}>{progress.percent}% complete</div>
        <div style={{ height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 9999 }}>
          <div
            style={{
              height: 8,
              width: `${progress.percent}%`,
              background: 'var(--amber, #E07B00)',
              borderRadius: 9999,
              transition: 'width 0.3s',
            }}
          />
        </div>
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.75rem' }}>
        {items.map((item) => (
          <li
            key={item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              padding: '0.75rem 1rem',
              background: 'rgba(255,255,255,0.03)',
              borderRadius: '0.5rem',
            }}
          >
            <span>
              <span aria-hidden="true" style={{ marginRight: '0.5rem' }}>
                {item.done ? '✅' : '⬜'}
              </span>
              {item.label}
            </span>

            {!item.done && item.id === 'estimate' && (
              <>
                <button type="button" className="btn btn-sm btn-secondary" disabled={busy === 'estimate'} onClick={() => estimateRef.current?.click()}>
                  {busy === 'estimate' ? 'Uploading…' : 'Upload'}
                </button>
                <input ref={estimateRef} type="file" hidden onChange={(e) => onFile('estimate', e)} />
              </>
            )}
            {!item.done && item.id === 'measurements' && (
              <>
                <button type="button" className="btn btn-sm btn-secondary" disabled={busy === 'measurements'} onClick={() => measurementsRef.current?.click()}>
                  {busy === 'measurements' ? 'Uploading…' : 'Upload'}
                </button>
                <input ref={measurementsRef} type="file" hidden onChange={(e) => onFile('measurements', e)} />
              </>
            )}
            {!item.done && item.id === 'material' && (
              <a className="btn btn-sm btn-secondary" href={`https://otterquote.com/color-selection.html?claim_id=${encodeURIComponent(claim.id)}`}>
                Choose
              </a>
            )}
          </li>
        ))}
      </ul>

      {showResend && (
        <div style={{ marginTop: '1rem' }}>
          <button type="button" className="btn btn-sm btn-secondary" disabled={busy === 'resend'} onClick={onResend}>
            {busy === 'resend' ? 'Sending…' : 'Resend measurement link'}
          </button>
        </div>
      )}

      {canSubmit && (
        <div style={{ marginTop: '1.25rem' }}>
          <button type="button" className="btn" disabled={busy === 'submit'} onClick={onSubmitForBids}>
            {busy === 'submit' ? 'Submitting…' : 'Submit for Bids'}
          </button>
        </div>
      )}

      {notice && (
        <p style={{ color: '#34D399', marginTop: '0.85rem' }}>{notice}</p>
      )}
      {error && (
        <p role="alert" style={{ color: '#f87171', marginTop: '0.85rem' }}>
          {error}
        </p>
      )}
    </section>
  );
}
