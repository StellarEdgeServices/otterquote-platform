'use client';

/**
 * D-178 state gate. Shown (and blocks the rest of the dashboard) when the claim's
 * property_state is set and is not 'IN'. Offers an expansion-waitlist opt-in,
 * mirroring dashboard.html:1752-1811.
 */

import { useState } from 'react';
import { joinExpansionWaitlist } from '../actions';
import type { HomeownerClaim } from '../types';

export function StateGateCard({
  claim,
  userId,
}: {
  claim: HomeownerClaim;
  userId: string;
}) {
  const state = claim.property_state || 'your state';
  const [optIn, setOptIn] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    const res = await joinExpansionWaitlist({
      userId,
      claimId: claim.id,
      state: String(claim.property_state || ''),
      optedIn: optIn,
      optedInAt: new Date().toISOString(),
    });
    setBusy(false);
    if (res.ok) setSubmitted(true);
    else setError(res.error || 'Something went wrong. Please try again.');
  }

  return (
    <section
      aria-labelledby="state-gate-title"
      style={{
        maxWidth: 560,
        margin: '3rem auto',
        padding: '2rem',
        background: 'var(--navy-2, #0f2942)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '1rem',
        color: 'rgba(255,255,255,0.9)',
      }}
    >
      <h1 id="state-gate-title" style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>
        We&apos;re not in {state} yet
      </h1>
      {submitted ? (
        <p>Thanks — you&apos;re on the list. We&apos;ll reach out the moment Otter Quotes launches in {state}.</p>
      ) : (
        <>
          <p style={{ lineHeight: 1.55, marginBottom: '1.25rem' }}>
            Otter Quotes is currently live in Indiana. Want us to let you know when we expand to {state}?
          </p>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1.25rem' }}>
            <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            Yes, notify me when you launch in {state}
          </label>
          {error && (
            <p role="alert" style={{ color: '#f87171', marginBottom: '0.75rem' }}>
              {error}
            </p>
          )}
          <button type="button" className="btn" disabled={busy} onClick={onSubmit}>
            {busy ? 'Saving…' : 'Join the waitlist'}
          </button>
        </>
      )}
    </section>
  );
}
