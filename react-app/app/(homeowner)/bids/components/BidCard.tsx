'use client';

/**
 * One bid card (bids.html:1201-1289 render). Job-type badge, contractor identity,
 * D-150 expiry warning/notice (with the "why do bids expire?" tooltip), pricing,
 * the net-to-contractor transparency line, and the action button whose label/state
 * comes from deriveBidAction.
 */

import { useState } from 'react';
import {
  deriveBidAction,
  deriveBidExpiry,
  EXPIRY_TOOLTIP,
  formatBidDate,
  formatWarranty,
  getScopeSummary,
  isLowestPrice,
  netToContractor,
} from '../utils';
import type { BidRow, BidsClaim, ContractorProfile } from '../types';

const JOB_TYPE: Record<string, { label: string; color: string }> = {
  insurance_rcv: { label: 'RCV', color: 'var(--blue, #2563EB)' },
  insurance_acv: { label: 'ACV', color: 'var(--purple, #7C3AED)' },
  retail: { label: 'Retail', color: 'var(--green, #16A34A)' },
  repair: { label: 'Repair', color: 'var(--orange, #EA580C)' },
};

function initialsOf(name: string): string {
  return (name || 'C')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}

interface BidCardProps {
  bid: BidRow;
  bids: BidRow[];
  claim: BidsClaim | null;
  contractor: ContractorProfile;
  onSelect: (bid: BidRow) => void;
  onRenew: (bid: BidRow) => void;
  renewalState?: 'idle' | 'sending' | 'sent';
  now?: Date;
}

export function BidCard({
  bid,
  bids,
  claim,
  contractor,
  onSelect,
  onRenew,
  renewalState = 'idle',
  now,
}: BidCardProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const expiry = deriveBidExpiry(bid, now);
  const action = deriveBidAction(claim, bid);
  const isExpired = expiry.state === 'expired';
  const lowest = isLowestPrice(bid, bids);
  const jt = JOB_TYPE[claim?.job_type || ''] || { label: 'Project', color: 'var(--slate, #64748B)' };
  const ss = getScopeSummary(bid);
  const net = netToContractor(bid);
  const companyName = contractor.company_name || 'Contractor';

  return (
    <div className={'oqb-card' + (lowest ? ' lowest' : '') + (isExpired ? ' expired' : '')}>
      <div className="oqb-card-top">
        <span className="oqb-jobtype" style={{ background: jt.color }}>{jt.label}</span>
        {isExpired ? <span className="oqb-expired-badge">Expired</span> : <span />}
        {lowest && !isExpired ? <span className="oqb-best">Best Price</span> : null}
      </div>

      <div className="oqb-card-header">
        <div className="oqb-avatar">
          {contractor._resolvedPhotoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contractor._resolvedPhotoUrl} alt={companyName} />
          ) : (
            initialsOf(companyName)
          )}
        </div>
        <div>
          <div className="oqb-name">{companyName}</div>
          <div className="oqb-meta">
            {contractor.years_in_business ? <span>{contractor.years_in_business} years in business</span> : null}
            {contractor.rating ? <span>★ {contractor.rating}</span> : null}
            {contractor.verified ? <span className="oqb-verified">✓ Licensed</span> : null}
          </div>
        </div>
      </div>

      {expiry.state === 'expiring' && <div className="oqb-expiry-warning">{expiry.warning}</div>}

      {isExpired && (
        <div className="oqb-expiry-notice">
          ⏰ This bid expired on {expiry.expiredOn}.
          <button
            type="button"
            className="oqb-expiry-info"
            aria-label="Why do bids expire?"
            aria-expanded={tooltipOpen}
            onClick={() => setTooltipOpen((v) => !v)}
          >
            ?
          </button>
          {tooltipOpen && <div className="oqb-expiry-tooltip" role="tooltip">{EXPIRY_TOOLTIP}</div>}
        </div>
      )}

      <div className="oqb-metrics">
        <div className="oqb-metric">
          <span className="oqb-metric-label">Total Price</span>
          <span className="oqb-metric-value price">${(bid.total_price || 0).toLocaleString()}</span>
        </div>
        <div className="oqb-metric">
          <span className="oqb-metric-label">Start Date</span>
          <span className="oqb-metric-value">
            {ss.estimated_start_date ? formatBidDate(ss.estimated_start_date as string) : 'TBD'}
          </span>
        </div>
        <div className="oqb-metric wide">
          <span className="oqb-metric-label">Completion Time</span>
          <span className="oqb-metric-value">{(ss.estimated_completion_time as string) || 'TBD'}</span>
        </div>
        <div className="oqb-metric wide">
          <span className="oqb-metric-label">Warranty</span>
          <span className="oqb-metric-value">{formatWarranty(bid)}</span>
        </div>
      </div>

      {net && (
        <div className="oqb-net">
          Contractor receives: <strong>${Math.round(net.net).toLocaleString()}</strong> after {net.feeLabel} Otter
          Quotes fee
        </div>
      )}

      <div className="oqb-actions">
        <a
          className="oqb-btn ghost"
          href={`https://otterquote.com/contractor-about.html?contractor_id=${encodeURIComponent(
            bid.contractor_id,
          )}&claim_id=${encodeURIComponent(claim?.id || '')}`}
        >
          View Full Profile
        </a>
        <BidActionButton
          action={action.kind}
          label={action.label}
          href={action.href}
          disabled={action.disabled}
          renewalState={renewalState}
          onSelect={() => onSelect(bid)}
          onRenew={() => onRenew(bid)}
        />
      </div>
    </div>
  );
}

function BidActionButton({
  action,
  label,
  href,
  disabled,
  renewalState,
  onSelect,
  onRenew,
}: {
  action: string;
  label: string;
  href?: string;
  disabled?: boolean;
  renewalState: 'idle' | 'sending' | 'sent';
  onSelect: () => void;
  onRenew: () => void;
}) {
  if (action === 'contract_signed' || action === 'awarded_selected') {
    return (
      <a className="oqb-btn primary" href={href}>
        {label}
      </a>
    );
  }
  if (action === 'not_selected') {
    return (
      <button type="button" className="oqb-btn ghost" disabled>
        {label}
      </button>
    );
  }
  if (action === 'renew') {
    const renewLabel =
      renewalState === 'sent' ? '✓ Request Sent' : renewalState === 'sending' ? 'Sending request…' : label;
    return (
      <button
        type="button"
        className="oqb-btn renew"
        onClick={onRenew}
        disabled={renewalState !== 'idle'}
      >
        {renewLabel}
      </button>
    );
  }
  return (
    <button type="button" className="oqb-btn primary" onClick={onSelect} disabled={disabled}>
      {label}
    </button>
  );
}
