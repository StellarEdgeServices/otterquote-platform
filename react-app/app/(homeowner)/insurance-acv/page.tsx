'use client';

/**
 * D-407 3/8 (gh-3284) ACV explainer -> /insurance-acv.
 *
 * Shows the approved ACV wording (copy.ts, verbatim from #3273) and a Continue
 * that lands on the Out-of-pocket route (#3285, /out-of-pocket), carrying the
 * claim_id. Writes NOTHING: no policy_type, no job_type, no funding_type; the
 * homeowner's own answers were stored by the routing question (D-079).
 *
 * LEGAL: customer-facing insurance wording; the only copy on the page besides the
 * Continue label is the approved text. No heading, no added sentence.
 *
 * New file; the PAYMENT_DESTINATIONS 'acv' row in trade-selector/payment-route.ts
 * switches to this route in a follow-up.
 */

import { useState } from 'react';
import { HomeownerShell } from '../_shell/HomeownerShell';
import { ACV_CONTINUE, ACV_EXPLAINER_TEXT } from './copy';
import { oopHref } from './utils';

export default function InsuranceAcvPage() {
  return (
    <HomeownerShell active="dashboard">
      <InsuranceAcvContent />
    </HomeownerShell>
  );
}

/** claim_id from the URL (the routing step appends it), or null. */
function readClaimId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('claim_id');
  } catch {
    return null;
  }
}

function InsuranceAcvContent() {
  const [href] = useState(() => oopHref(readClaimId()));
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1.5rem 4rem' }}>
      <p data-testid="acv-explainer" style={{ color: 'var(--white, #fff)', fontSize: '1.05rem', lineHeight: 1.6 }}>
        {ACV_EXPLAINER_TEXT}
      </p>
      <a
        data-testid="acv-continue"
        href={href}
        style={{
          display: 'inline-block',
          background: '#b8860b',
          color: '#fff',
          borderRadius: 8,
          padding: '0.75rem 1.5rem',
          fontWeight: 800,
          textDecoration: 'none',
        }}
      >
        {ACV_CONTINUE}
      </a>
    </div>
  );
}
