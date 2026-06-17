'use client';

/**
 * Rescind mode (?action=rescind) — D-211 Phase 7 / BF-2 (port of
 * contractor-bid-form.html initRescindMode/confirmRescind, :5701-5810). Shows the
 * contractor's active bid for the claim, gates on the PR-1 RESCINDABLE_STATUSES,
 * and on confirm calls the rescind-bid EF (UNCHANGED contract) via the supabase
 * singleton with the PR-1 buildRescindRequest payload, then returns to the React
 * dashboard. Copy from BID_COPY.rescind (parity-tested).
 *
 * Tier-3 note: rescind-bid's comma-joined ACAO + bid_status-taxonomy findings are
 * filed for migration-author (ClickUp 86e1xe0wb) — not addressed here.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Card, formatCurrency } from './bid-ui';
import { BID_COPY } from './copy';
import { isRescindable, buildRescindRequest } from './utils';

const DASHBOARD_ROUTE = '/contractor/dashboard';

export interface RescindQuote {
  id: string;
  total_price: number | null;
  bid_status: string | null;
  created_at: string | null;
}

export function RescindCard({ contractorId, quote }: { contractorId: string | null; quote: RescindQuote | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!quote) {
    return <Card title="Rescind Bid"><div className="oqb-summary-k">{BID_COPY.rescind.noActiveBid}</div></Card>;
  }
  if (!isRescindable(quote.bid_status)) {
    return <Card title="Rescind Bid"><div className="oqb-err">{BID_COPY.rescind.notRescindable(quote.bid_status || 'unknown')}</div></Card>;
  }
  if (done) {
    return (
      <Card title="Bid Rescinded">
        <div className="oqb-summary-k">Your bid has been withdrawn. Returning to your dashboard…</div>
      </Card>
    );
  }

  async function confirmRescind() {
    if (!contractorId || !quote) return;
    setBusy(true);
    setError(null);
    try {
      const { error: efError } = await supabase.functions.invoke('rescind-bid', {
        body: buildRescindRequest(quote.id, contractorId),
      });
      if (efError) throw efError;
      setDone(true);
      setTimeout(() => router.replace(DASHBOARD_ROUTE), 2500);
    } catch (err) {
      console.error('Error rescinding bid:', err);
      setError(BID_COPY.rescind.genericError);
      setBusy(false);
    }
  }

  return (
    <Card title="Rescind Bid" sub="Withdraw your bid for this project. This cannot be undone.">
      <div className="oqb-summary">
        <span className="oqb-summary-k">Bid Amount</span>
        <span className="oqb-summary-v">{formatCurrency(quote.total_price || 0)}</span>
        <span className="oqb-summary-k">Status</span>
        <span className="oqb-summary-v">{quote.bid_status}</span>
        <span className="oqb-summary-k">Submitted</span>
        <span className="oqb-summary-v">{quote.created_at ? new Date(quote.created_at).toLocaleDateString() : '—'}</span>
      </div>
      {error && <div className="oqb-err">{error}</div>}
      <div className="oqb-actions" style={{ marginTop: '1rem' }}>
        <button type="button" className="oqb-btn oqb-btn-danger" onClick={confirmRescind} disabled={busy}>
          {busy ? BID_COPY.rescind.rescinding : BID_COPY.rescind.confirmBtn}
        </button>
        <button type="button" className="oqb-btn oqb-btn-secondary" onClick={() => router.replace(DASHBOARD_ROUTE)} disabled={busy}>
          Cancel
        </button>
      </div>
    </Card>
  );
}
