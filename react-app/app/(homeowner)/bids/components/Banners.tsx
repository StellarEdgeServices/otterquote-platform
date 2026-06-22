'use client';

/**
 * Small presentational banners + empty/waiting states for /bids:
 *   • BidUpdatedBanner   — unread bid_updated notifications (bids.html:364-375)
 *   • AllExpiredBanner   — every bid expired (bids.html:412-417)
 *   • EmptyState         — no bids yet + waiting indicator (bids.html:420-436)
 *   • ErrorState         — fetch failure
 */

import { ALL_EXPIRED_BANNER, EMPTY_STATE, WAITING_TEXT } from '../utils';

export function BidUpdatedBanner({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  if (count <= 0) return null;
  const label =
    count === 1 ? 'A contractor updated their bid.' : `${count} contractors updated their bids.`;
  return (
    <div className="oqb-banner updated" role="status">
      <span>🔄 {label} Review the latest details below.</span>
      <button type="button" className="oqb-banner-dismiss" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

export function AllExpiredBanner() {
  return (
    <div className="oqb-banner expired" role="status">
      <span className="oqb-banner-icon" aria-hidden="true">⏰</span>
      <span>{ALL_EXPIRED_BANNER}</span>
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="oqb-empty" role="status">
      <div className="oqb-empty-icon" aria-hidden="true">📋</div>
      <h2>{EMPTY_STATE.title}</h2>
      <p>{EMPTY_STATE.body}</p>
      <div className="oqb-waiting">
        <span className="oqb-waiting-dots"><span /><span /><span /></span>
        <span>{WAITING_TEXT}</span>
      </div>
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="oqb-error" role="alert">
      <h2>We couldn&apos;t load your bids</h2>
      <p>Something went wrong fetching your bids. Please refresh and try again.</p>
      {onRetry && (
        <button type="button" className="oqb-btn primary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
