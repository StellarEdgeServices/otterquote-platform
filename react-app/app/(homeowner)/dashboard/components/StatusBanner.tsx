'use client';

/**
 * D-178 status banner + its contract_signed actions:
 *   • Switch Contractor (D-171) — disabled within the 3-day install cutoff,
 *     otherwise opens the survey modal that submits via send-support-email.
 *   • Warranty document button (W3-P4) — 7-day signed URL.
 * Mirrors dashboard.html updateStatusBanner() (2314-2483).
 */

import { useState } from 'react';
import { openWarrantyDoc, submitSwitchSurvey } from '../actions';
import {
  canSwitchContractor,
  deriveStatusBanner,
  isSwitchWithinCutoff,
  shouldShowWarrantyButton,
  SWITCH_REASONS,
} from '../utils';
import type { HomeownerClaim, HomeownerProfile } from '../types';

export function StatusBanner({
  claim,
  profile,
  email,
  bidCount,
  warrantyUrl,
}: {
  claim: HomeownerClaim;
  profile: HomeownerProfile | null;
  email: string | null | undefined;
  bidCount: number;
  warrantyUrl: string | null;
}) {
  const banner = deriveStatusBanner(claim, bidCount);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [warrantyErr, setWarrantyErr] = useState<string | null>(null);

  if (!banner) return null;

  const withinCutoff = isSwitchWithinCutoff(claim);
  const showWarranty = shouldShowWarrantyButton(claim, warrantyUrl);

  async function onWarranty() {
    setWarrantyErr(null);
    const res = await openWarrantyDoc(warrantyUrl as string);
    if (!res.ok) setWarrantyErr('Unable to open the warranty document. Please try again or contact support.');
  }

  return (
    <section
      className={`oqh-status oqh-status-${banner.variant}`}
      style={{
        marginBottom: '1.5rem',
        background: 'var(--navy-2, #0f2942)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '0.875rem',
        padding: '1.25rem 1.5rem',
        color: 'rgba(255,255,255,0.9)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem' }}>
        <div style={{ fontSize: '1.6rem', lineHeight: 1 }} aria-hidden="true">
          {banner.icon}
        </div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: '0 0 0.35rem', fontSize: '1.15rem' }}>{banner.title}</h2>
          <p style={{ margin: 0, fontSize: '0.9rem', lineHeight: 1.5 }}>{banner.text}</p>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1rem' }}>
            <a className="btn btn-sm" href={`https://otterquote.com/bids.html?claim_id=${encodeURIComponent(claim.id)}`}>
              View bids
            </a>

            {canSwitchContractor(claim) &&
              (withinCutoff ? (
                <span title="Switching is no longer available — installation is within 3 days.">
                  <button type="button" className="btn btn-sm btn-ghost" disabled style={{ opacity: 0.5, cursor: 'not-allowed' }}>
                    Switch Contractor
                  </button>
                </span>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSwitchOpen(true)}>
                  Switch Contractor
                </button>
              ))}

            {showWarranty && (
              <button
                type="button"
                className="btn btn-sm"
                style={{ background: '#0284C7', color: '#fff', border: 'none' }}
                onClick={onWarranty}
              >
                📄 Your warranty document
              </button>
            )}
          </div>
          {warrantyErr && (
            <p role="alert" style={{ color: '#f87171', marginTop: '0.5rem' }}>
              {warrantyErr}
            </p>
          )}
        </div>
      </div>

      {switchOpen && (
        <SwitchContractorModal
          claim={claim}
          profile={profile}
          email={email}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </section>
  );
}

function SwitchContractorModal({
  claim,
  profile,
  email,
  onClose,
}: {
  claim: HomeownerClaim;
  profile: HomeownerProfile | null;
  email: string | null | undefined;
  onClose: () => void;
}) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function toggle(value: string) {
    setReasons((cur) => (cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value]));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await submitSwitchSurvey({ claim, profile, email, reasons, notes });
    setBusy(false);
    if (res.ok) setDone(true);
    else setError('There was a problem submitting your request. Please try again or contact support.');
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switch contractor"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: 'var(--navy-2, #0f2942)',
          borderRadius: '1rem',
          padding: '1.75rem',
          maxWidth: 520,
          width: '100%',
          color: 'rgba(255,255,255,0.9)',
        }}
      >
        {done ? (
          <div>
            <h2 style={{ marginTop: 0 }}>We&apos;ve got you.</h2>
            <p style={{ lineHeight: 1.55 }}>
              Your request is in. Our team will review it and follow up shortly to help you switch.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <div>
            <h2 style={{ marginTop: 0 }}>🔄 What happened? Can we fix it?</h2>
            <p style={{ fontSize: '0.85rem', lineHeight: 1.5, color: 'rgba(255,255,255,0.75)' }}>
              Switching voids the signed contract, reopens your project to bidding, and refunds the
              platform fee. Tell us what went wrong:
            </p>
            <div style={{ display: 'grid', gap: '0.5rem', margin: '1rem 0' }}>
              {SWITCH_REASONS.map((r) => (
                <label key={r.value} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.9rem' }}>
                  <input
                    type="checkbox"
                    name="switch_reason"
                    value={r.value}
                    checked={reasons.includes(r.value)}
                    onChange={() => toggle(r.value)}
                  />
                  {r.label}
                </label>
              ))}
            </div>
            <textarea
              value={notes}
              maxLength={1000}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else we should know? (optional)"
              rows={3}
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            {error && (
              <p role="alert" style={{ color: '#f87171' }}>
                {error}
              </p>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={busy || reasons.length === 0} onClick={submit}>
                {busy ? 'Submitting…' : 'Submit Switch Request'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
